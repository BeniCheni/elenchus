import { vendorForRuntime } from "./config.js";
import { postingOrder, recordTimeline } from "./load.js";
import { checkRuling } from "./ruling.js";
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
  const notices = state.notices.filter(({ rule }) => rule === "config" || rule === "record replacement");
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
    headNote: headNote(state),
    unreadable: state.unreadable,
    merged: state.pull.merged === true,
    mergeCommit: state.pull.merged ? state.pull.merge_commit_sha ?? null : null,
    gateStatus: state.gateStatus,
    ...(notices.length ? { notices } : {}),
  };
}

function headNote(state: ReviewState): string | null {
  if (state.passes.some((pass) => pass.outcome.kind !== "recorded")) return null;
  const output = recordTimeline(state.passes).at(-1)?.record.output_sha;
  if (!output) return null;
  if (sameSha(state.head, output)) return `head equals last output_sha ${output}`;
  return `head ${state.head} does not equal last output_sha ${output}`;
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
  const ruling = checkRuling(state);
  const reason = ruling?.findings[0]?.message;
  if (ruling && reason && (!firstOpen || state.passes.indexOf(firstOpen) > state.passes.indexOf(ruling.pass)
      || (firstOpen === ruling.pass && firstOpen.outcome.kind === "absent"))) {
    const { id, seat, role } = ruling.pass;
    return { step: id, seat, role, blocked: reason, options: null };
  }
  if (!firstOpen) {
    return {
      step: "authorize",
      seat: null,
      role: null,
      blocked: state.config.gate ? "authorization required" : "no gate configured",
      options: null,
    };
  }
  if (firstOpen.outcome.kind === "rejected") {
    if (firstOpen.outcome.failures > state.config.retry_cap) {
      return {
        step: escalateTo(state.config),
        seat: null,
        role: null,
        blocked: `pass ${firstOpen.id} exceeded retry cap ${state.config.retry_cap} after ${firstOpen.outcome.failures} failed attempts`,
        options: null,
      };
    }
    const which = `record rejected after ${firstOpen.outcome.failures} failed attempt(s); back to the seat`;
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
      options: ["wait", "re-route"],
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
      rule: orphan.rule,
      ...(orphan.pass ? { pass: orphan.pass } : {}),
      comment: orphan.commentUrl,
      message: orphan.reason,
    });
  }
  if (state.pull.merged) {
    const sha = state.pull.merge_commit_sha;
    items.push({ severity: "notice", rule: "merged", message: `pull request merged${sha ? ` at ${sha}` : ""}; range rules skipped` });
  }
  if (state.passes.every((pass) => pass.outcome.kind === "absent")) {
    items.push({ severity: "notice", rule: "records", message: "no seat records" });
  }
  for (const [index, pass] of state.passes.entries()) {
    if (pass.outcome.kind !== "recorded") continue;
    const original = pass.outcome.history[0]!;
    const predecessor = state.passes[index - 1];
    if (predecessor?.outcome.kind === "recorded" && postingOrder(original, predecessor.outcome.history[0]!) < 0) {
      items.push({
        severity: "fail",
        rule: "sequence",
        pass: pass.id,
        comment: original.commentUrl,
        message: `posted before pass ${predecessor.id}`,
      });
    }
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
  checkLaterRejections(state, items);
  checkFindings(state, items);
  checkRoutes(state, items);
  checkRetries(state, items);
  checkPostedBy(state, items);
  checkPullNumber(state, items);
  if (!state.pull.merged) checkCoverage(state, items);
  for (const item of state.unreadable) {
    if (item.attached) continue;
    items.push({
      severity: "fail",
      rule: "schema",
      comment: item.commentUrl,
      message: item.reason,
    });
  }
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
  const timeline = recordTimeline(state.passes);
  for (const [index, posting] of timeline.entries()) {
    const previous = timeline[index - 1]?.record;
    const record = posting.record;
    if (previous && !record.reread && !sameSha(record.input_sha, previous.output_sha)) {
      items.push({
        severity: "fail",
        rule: "sha-chain",
        pass: record.pass,
        comment: posting.commentUrl,
        message: `input_sha ${record.input_sha} is not the previous pass ${previous.pass}'s output_sha ${previous.output_sha}`,
      });
    }
  }
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") continue;
    const record = pass.outcome.record;
    const writing = isWriting(record);
    if (pass.resolveError) {
      items.push({
        severity: "fail",
        rule: "sha-chain",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: pass.resolveError,
      });
      continue;
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

function checkLaterRejections(state: ReviewState, items: CheckItem[]): void {
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") continue;
    for (const rejection of pass.outcome.laterRejections) {
      items.push({
        severity: "fail",
        rule: "schema",
        pass: pass.id,
        comment: rejection.commentUrl,
        message: rejection.reason,
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
  const flow = state.config.finding_flow;
  if (!flow) return;
  const opener = recorded(state, flow.opens);
  const opened = opener?.outcome.kind === "recorded" ? opener.outcome.record.findings.map(({ id }) => id) : [];
  for (const id of flow.carries) {
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
          message: `finding ${finding} opened in pass ${flow.opens} is missing`,
        });
      }
    }
  }
  const synthesis = state.passes.find(({ id }) => id === flow.carries.at(-1))?.outcome;
  if (synthesis?.kind !== "recorded") return;
  const ruling = state.passes.find(({ id }) => id === flow.ruling)?.outcome;
  const have = new Set([...opened, ...synthesis.record.findings.map(({ id }) => id)]);
  // Same-range corrections keep their existing rules. A re-read carries the prior round's IDs.
  const earlierSyntheses = synthesis.postings.filter(({ record }) =>
    !sameSha(record.input_sha, synthesis.record.input_sha) || !sameSha(record.output_sha, synthesis.record.output_sha),
  );
  for (const posting of [...earlierSyntheses, ...(ruling?.kind === "recorded" ? ruling.postings : [])]) {
    if (postingOrder(posting, synthesis.posting) >= 0) continue;
    for (const { id } of posting.record.findings) {
      if (have.has(id)) continue;
      have.add(id);
      items.push({
        severity: "fail", rule: "finding-carry", pass: synthesis.record.pass, finding: id,
        comment: synthesis.commentUrl,
        message: `finding ${id} from pass ${posting.record.pass} record ${posting.commentUrl} is missing`,
      });
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
  if (table && Object.hasOwn(table, observed.requested) && table[observed.requested]?.includes(observed.observed)) return;
  items.push({
    severity: "fail",
    rule: "route",
    pass: pass.id,
    comment: pass.outcome.commentUrl,
    message: `${field} requested ${observed.requested} observed ${observed.observed}`,
  });
}

function checkPullNumber(state: ReviewState, items: CheckItem[]): void {
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded" || pass.outcome.record.pr === state.pr) continue;
    items.push({
      severity: "fail",
      rule: "pr",
      pass: pass.id,
      comment: pass.outcome.commentUrl,
      message: `record pr ${pass.outcome.record.pr} does not match pull request ${state.pr}`,
    });
  }
}

function checkPostedBy(state: ReviewState, items: CheckItem[]): void {
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") continue;
    const postedBy = pass.outcome.record.posted_by;
    if (postedBy !== undefined && postedBy !== pass.outcome.authorLogin) {
      items.push({
        severity: "fail",
        rule: "posted_by",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: `posted_by ${postedBy} is not ${pass.outcome.authorLogin}`,
      });
    }
  }
}

function escalateTo(config: Config): string {
  return `escalate to ${config.escalate_to ?? "the maintainer"}`;
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
          ? `${escalateTo(state.config)}: ${pass.outcome.reason}`
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

function checkCoverage(state: ReviewState, items: CheckItem[]): void {
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") continue;
    const marked = state.config.passes.find((item) => item.id === pass.id)?.coverage === true;
    const record = pass.outcome.record;
    if (!marked && record.coverage?.reviewed_paths === undefined) continue;
    if (!record.coverage) {
      items.push({
        severity: "unverified",
        rule: "coverage",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: "coverage not reported",
      });
      continue;
    }
    const manifest = pass.coverageManifest;
    if (!manifest || manifest.error) {
      items.push({
        severity: "fail",
        rule: "coverage",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: manifest?.error ?? "file list truncated",
      });
      continue;
    }
    const coverage = record.coverage;
    const seen = new Set<string>();
    for (const skip of coverage.skipped) {
      if (skip.reason.trim() === "") {
        items.push({
          severity: "fail",
          rule: "coverage",
          pass: pass.id,
          comment: pass.outcome.commentUrl,
          message: `skipped ${skip.path} has no reason`,
        });
      } else if (!manifest.paths.includes(skip.path)) {
        items.push({
          severity: "fail",
          rule: "coverage",
          pass: pass.id,
          comment: pass.outcome.commentUrl,
          message: `skipped ${skip.path} is not in the manifest`,
        });
      }
      if (seen.has(skip.path)) {
        items.push({
          severity: "fail",
          rule: "coverage",
          pass: pass.id,
          comment: pass.outcome.commentUrl,
          message: `skipped ${skip.path} is listed more than once`,
        });
      }
      seen.add(skip.path);
    }
    if (coverage.total !== manifest.paths.length) {
      items.push({
        severity: "fail",
        rule: "coverage",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: `total ${coverage.total} is not the manifest's ${manifest.paths.length}`,
      });
    }
    if (coverage.reviewed_paths) {
      checkReviewedPaths(pass.id, pass.outcome.commentUrl, coverage.reviewed, coverage.reviewed_paths, seen, manifest.paths, items);
    }
    const distinct = seen.size;
    if (coverage.reviewed + distinct !== coverage.total) {
      const notSkipped = manifest.paths.filter((file) => !seen.has(file));
      items.push({
        severity: "fail",
        rule: "coverage",
        pass: pass.id,
        comment: pass.outcome.commentUrl,
        message: `reviewed ${coverage.reviewed} + skipped ${distinct} is not total ${coverage.total}; not skipped: ${notSkipped.join(", ")}`,
      });
    }
  }
}

function checkReviewedPaths(
  pass: string,
  comment: string,
  count: number,
  reviewed: string[],
  skipped: Set<string>,
  manifest: string[],
  items: CheckItem[],
): void {
  const expected = new Set(manifest);
  const actual = new Set(reviewed);
  const fail = (message: string) => items.push({ severity: "fail", rule: "coverage", pass, comment, message });
  for (const path of reviewed) {
    if (!expected.has(path)) fail(`reviewed ${path} is not in the manifest`);
    if (skipped.has(path)) fail(`${path} is both reviewed and skipped`);
  }
  for (const path of manifest) {
    if (!actual.has(path) && !skipped.has(path)) fail(`${path} is missing from reviewed and skipped paths`);
  }
  if (actual.size !== count) fail(`reviewed ${count} is not the number of reviewed paths ${actual.size}`);
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
