import { vendorForRuntime } from "./config.js";
import { sameSha } from "./sha.js";
import type {
  CheckItem,
  Config,
  Observed,
  PassState,
  ReviewState,
  SeatRecord,
  StatusView,
  VendorConfig,
} from "./types.js";

export function buildStatus(state: ReviewState): StatusView {
  const firstOpen = state.passes.find((pass) => pass.outcome.kind !== "recorded");
  return {
    repo: state.repo,
    pr: state.pr,
    head: state.head,
    base: { ref: state.baseRef, sha: state.baseSha },
    passes: state.passes.map((pass) => ({
      pass: pass.id,
      role: pass.role,
      seat: pass.seat,
      state: passStateName(pass, state.inProgressPass),
      output_sha: pass.outcome.kind === "recorded" ? pass.outcome.record.output_sha : null,
      comment_url: commentOf(pass),
      reason: pass.outcome.kind === "rejected" ? pass.outcome.reason : null,
    })),
    next: nextStep(state, firstOpen),
  };
}

function passStateName(pass: PassState, inProgressPass: string | null): StatusView["passes"][number]["state"] {
  if (pass.outcome.kind === "recorded") return "recorded";
  if (pass.outcome.kind === "rejected") return "rejected";
  if (pass.id === inProgressPass) return "in_progress";
  return "not_recorded";
}

function commentOf(pass: PassState): string | null {
  if (pass.outcome.kind === "recorded" || pass.outcome.kind === "rejected") return pass.outcome.commentUrl;
  return null;
}

function nextStep(state: ReviewState, firstOpen: PassState | undefined): StatusView["next"] {
  if (!firstOpen) {
    return {
      step: "authorize",
      seat: null,
      role: null,
      blocked: "Sprint 3 builds authorize",
      options: null,
    };
  }
  if (firstOpen.outcome.kind === "rejected") {
    if (firstOpen.outcome.failures > state.config.retry_cap) {
      return {
        step: "escalate to Beni",
        seat: null,
        role: null,
        blocked: `pass ${firstOpen.id} second failed resubmission`,
        options: null,
      };
    }
    const which = firstOpen.outcome.failures <= 1 ? "record rejected; back to the seat" : "first resubmission failed; back to the seat";
    return {
      step: firstOpen.id,
      seat: firstOpen.seat,
      role: firstOpen.role,
      blocked: which,
      options: null,
    };
  }
  if (firstOpen.id === state.inProgressPass) {
    const index = state.passes.findIndex((pass) => pass.id === firstOpen.id);
    const previous = index > 0 ? state.passes[index - 1] : undefined;
    return {
      step: firstOpen.id,
      seat: firstOpen.seat,
      role: firstOpen.role,
      blocked: `commits pushed after pass ${previous?.id ?? "none"} and pass ${firstOpen.id} has no record`,
      options: ["wait", "or re-route"],
    };
  }
  return {
    step: firstOpen.id,
    seat: firstOpen.seat,
    role: firstOpen.role,
    blocked: `no record for pass ${firstOpen.id}`,
    options: null,
  };
}

export function buildCheck(state: ReviewState): CheckItem[] {
  const items: CheckItem[] = [];
  for (const orphan of state.orphans) {
    items.push({
      severity: "fail",
      rule: "schema",
      ...(orphan.pass ? { pass: orphan.pass } : {}),
      comment: orphan.commentUrl,
      message: orphan.reason,
    });
  }
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") continue;
    for (const earlier of state.passes) {
      if (earlier.id === pass.id) break;
      if (earlier.outcome.kind !== "recorded") {
        items.push({
          severity: "fail",
          rule: "sequence",
          pass: pass.id,
          comment: pass.outcome.commentUrl,
          message: `skipped pass ${earlier.id}`,
        });
      }
    }
  }
  checkChain(state, items);
  checkFindings(state, items);
  checkRoutes(state, items);
  checkRetries(state, items);
  for (const notice of state.notices) {
    items.push({
      severity: "notice",
      rule: notice.rule,
      comment: notice.commentUrl,
      message: notice.message,
    });
  }
  return items;
}

function checkChain(state: ReviewState, items: CheckItem[]): void {
  let previous: { pass: string; output: string } | null = null;
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") continue;
    const record = pass.outcome.record;
    const writing = isWriting(record);
    if (writing && previous && !sameSha(record.input_sha, previous.output)) {
      items.push({
        severity: "fail",
        rule: "sha-chain",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: `input_sha ${record.input_sha} is not the previous writing pass ${previous.pass}'s output_sha ${previous.output}`,
      });
    }
    if (pass.outputIsAncestor === false) {
      items.push({
        severity: "fail",
        rule: "sha-chain",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: `output_sha ${record.output_sha} is not an ancestor of or equal to head ${state.head}`,
      });
    }
    if (pass.range?.error) {
      items.push({
        severity: "fail",
        rule: "commits",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: pass.range.error,
      });
    } else if (pass.range) {
      const mismatch = commitMismatch(record.commits, pass.range.commits.map((commit) => commit.sha));
      if (mismatch) {
        items.push({
          severity: "fail",
          rule: "commits",
          pass: pass.id,
          comment: pass.outcome.commentUrl,
          message: `record commits do not equal ${record.input_sha}..${record.output_sha} minus the base branch: ${mismatch}`,
        });
      }
      if (writing) checkAuthors(state.config, pass, items);
    }
    if (writing) previous = { pass: pass.id, output: record.output_sha };
  }
}

function checkAuthors(config: Config, pass: PassState, items: CheckItem[]): void {
  if (pass.outcome.kind !== "recorded" || !pass.range) return;
  const vendor = vendorForRuntime(config, pass.outcome.record.runtime);
  if (!vendor) {
    items.push({
      severity: "fail",
      rule: "authors",
      pass: pass.id,
      comment: pass.outcome.commentUrl,
      message: `runtime ${pass.outcome.record.runtime} is not a configured vendor`,
    });
    return;
  }
  for (const commit of pass.range.commits) {
    if (!vendor.vendor.authors.includes(commit.author)) {
      items.push({
        severity: "fail",
        rule: "authors",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: `commit ${commit.sha} author "${commit.author}" is not vendor ${vendor.name}`,
      });
    }
  }
}

function checkFindings(state: ReviewState, items: CheckItem[]): void {
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") continue;
    const ids = pass.outcome.record.findings.map((finding) => finding.id);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        items.push({
          severity: "fail",
          rule: "finding-carry",
          pass: pass.id,
          finding: id,
          comment: pass.outcome.commentUrl,
          message: `finding ${id} is reused in pass ${pass.id}`,
        });
      }
      seen.add(id);
    }
  }
  const pass1 = recorded(state, "1");
  if (!pass1) return;
  const opened = pass1.outcome.kind === "recorded" ? pass1.outcome.record.findings.map((finding) => finding.id) : [];
  for (const id of ["2", "2.5"]) {
    const later = recorded(state, id);
    if (!later || later.outcome.kind !== "recorded") continue;
    const have = new Set(later.outcome.record.findings.map((finding) => finding.id));
    for (const finding of opened) {
      if (!have.has(finding)) {
        items.push({
          severity: "fail",
          rule: "finding-carry",
          pass: id,
          finding,
          comment: later.outcome.commentUrl,
          message: `finding ${finding} opened in pass 1 is missing`,
        });
      }
    }
  }
}

function checkRoutes(state: ReviewState, items: CheckItem[]): void {
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") continue;
    const record = pass.outcome.record;
    const vendor = vendorForRuntime(state.config, record.runtime);
    checkObserved(items, pass, "model", record.model, vendor?.vendor.models);
    checkObserved(items, pass, "effort", record.effort, vendor?.vendor.efforts);
  }
}

function checkObserved(
  items: CheckItem[],
  pass: PassState,
  field: "model" | "effort",
  observed: Observed,
  table: Record<string, string[]> | undefined,
): void {
  if (pass.outcome.kind !== "recorded") return;
  if (observed.observed === null || observed.requested === null) {
    const source = observed.observed === null ? (observed.source ?? "absent") : "request not stated";
    items.push({
      severity: "unverified",
      rule: "route",
      pass: pass.id,
      comment: pass.outcome.commentUrl,
      message: `${field} ${source === "not reported" || source === "absent" || source === "request not stated" ? source : `source ${source}`}`,
    });
    return;
  }
  if (observed.observed === observed.requested) return;
  if (table?.[observed.requested]?.includes(observed.observed)) return;
  items.push({
    severity: "fail",
    rule: "route",
    pass: pass.id,
    comment: pass.outcome.commentUrl,
    message: `${field} requested ${observed.requested} observed ${observed.observed}`,
  });
}

function checkRetries(state: ReviewState, items: CheckItem[]): void {
  for (const pass of state.passes) {
    if (pass.outcome.kind === "rejected") {
      const escalate = pass.outcome.failures > state.config.retry_cap;
      items.push({
        severity: "fail",
        rule: "retries",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: escalate
          ? `escalate to Beni: ${pass.outcome.reason}`
          : `${pass.outcome.reason}; back to the seat`,
      });
      continue;
    }
    if (pass.outcome.kind !== "recorded") continue;
    const claimed = pass.outcome.record.retries;
    if (claimed !== undefined && claimed !== pass.outcome.priorFailures) {
      items.push({
        severity: "fail",
        rule: "retries",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: `record retries ${claimed} but the comments show ${pass.outcome.priorFailures}`,
      });
    }
  }
}

function recorded(state: ReviewState, id: string): PassState | undefined {
  return state.passes.find((pass) => pass.id === id && pass.outcome.kind === "recorded");
}

function isWriting(record: SeatRecord): boolean {
  return record.commits.length > 0 || !sameSha(record.input_sha, record.output_sha);
}

function commitMismatch(recordedShas: string[], expected: string[]): string | null {
  const used = new Set<number>();
  const extra: string[] = [];
  for (const sha of recordedShas) {
    const index = expected.findIndex((candidate, i) => !used.has(i) && sameSha(sha, candidate));
    if (index < 0) extra.push(sha);
    else used.add(index);
  }
  const missing = expected.filter((_, index) => !used.has(index));
  if (extra.length === 0 && missing.length === 0) return null;
  return `missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`;
}
