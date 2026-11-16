import { parseConfig } from "./config.js";
import type { GhClient } from "./gh.js";
import { extractRecord, guessPass, hasUnreadJsonFence } from "./records.js";
import { validateSeatRecord } from "./schema.js";
import { sameSha } from "./sha.js";
import type {
  Attempt,
  Config,
  GhComment,
  GhCompare,
  GhContent,
  GhPull,
  Notice,
  PassState,
  RangeCommit,
  ReviewState,
  SeatRecord,
} from "./types.js";

export async function loadReview(
  gh: GhClient,
  repo: string,
  pr: number,
  configOverride?: Config,
): Promise<ReviewState> {
  const pull = (await gh.get(`/repos/${repo}/pulls/${pr}`)) as GhPull;
  const baseTip = (await gh.get(`/repos/${repo}/commits/${pull.base.ref}`)) as { sha: string };
  const comments = (await gh.get(`/repos/${repo}/issues/${pr}/comments?per_page=100`, {
    paginate: true,
  })) as GhComment[];
  const config = configOverride ?? (await readConfig(gh, repo, pull.base.ref));
  const { attempts, notices } = parseAttempts(comments);
  const known = new Set(config.passes.map((pass) => pass.id));
  const orphans = attempts
    .filter((attempt) => attempt.pass === null || !known.has(attempt.pass))
    .map((attempt) => ({
      pass: attempt.pass,
      commentUrl: attempt.commentUrl,
      reason: attempt.reason ?? "malformed record",
    }));
  const passes = config.passes.map((pass) => passState(pass, attempts.filter((attempt) => attempt.pass === pass.id)));
  const compared = await attachGit(gh, repo, pull.head.sha, baseTip.sha, passes);
  return {
    repo,
    pr: pull.number,
    head: pull.head.sha,
    baseRef: pull.base.ref,
    baseSha: baseTip.sha,
    config,
    passes: compared.passes,
    orphans,
    notices,
    inProgressPass: compared.inProgressPass,
  };
}

async function readConfig(gh: GhClient, repo: string, ref: string): Promise<Config> {
  let file: GhContent;
  try {
    file = (await gh.get(`/repos/${repo}/contents/.elenchus.json?ref=${ref}`)) as GhContent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`no .elenchus.json on ${ref}: ${message}`);
  }
  if (!file.content) throw new Error(`no .elenchus.json on ${ref}`);
  const text = Buffer.from(file.content, "base64").toString("utf8");
  return parseConfig(JSON.parse(text) as unknown);
}

function parseAttempts(comments: GhComment[]): { attempts: Attempt[]; notices: Notice[] } {
  const ordered = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const attempts: Attempt[] = [];
  const notices: Notice[] = [];
  for (const comment of ordered) {
    const body = comment.body ?? "";
    const raw = extractRecord(body);
    if (hasUnreadJsonFence(body)) {
      notices.push({
        rule: "extraction",
        commentUrl: comment.html_url,
        message: "json fence was not read as a record",
      });
    }
    if (raw === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        pass: guessPass(raw),
        commentUrl: comment.html_url,
        createdAt: comment.created_at,
        id: comment.id,
        valid: false,
        reason: `invalid JSON: ${message}`,
        record: null,
      });
      continue;
    }
    const result = validateSeatRecord(value);
    const pass = result.ok ? result.record.pass : passField(value) ?? guessPass(raw);
    attempts.push({
      pass,
      commentUrl: comment.html_url,
      createdAt: comment.created_at,
      id: comment.id,
      valid: result.ok,
      reason: result.ok ? null : result.reason,
      record: result.ok ? result.record : null,
    });
  }
  return { attempts, notices };
}

function passField(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const pass = (value as { pass?: unknown }).pass;
  return typeof pass === "string" ? pass : null;
}

function passState(pass: { id: string; role: string; seat: string }, attempts: Attempt[]): PassState {
  const base = { id: pass.id, role: pass.role, seat: pass.seat, outputIsAncestor: null, range: null };
  if (attempts.length === 0) return { ...base, outcome: { kind: "absent" } };
  const last = attempts[attempts.length - 1] as Attempt;
  if (last.valid && last.record) {
    const priorFailures = attempts.slice(0, -1).filter((attempt) => !attempt.valid).length;
    return {
      ...base,
      outcome: {
        kind: "recorded",
        record: last.record,
        commentUrl: last.commentUrl,
        priorFailures,
      },
    };
  }
  const failures = attempts.filter((attempt) => !attempt.valid).length;
  return {
    ...base,
    outcome: {
      kind: "rejected",
      reason: last.reason ?? "malformed record",
      commentUrl: last.commentUrl,
      failures,
    },
  };
}

async function attachGit(
  gh: GhClient,
  repo: string,
  head: string,
  baseSha: string,
  passes: PassState[],
): Promise<{ passes: PassState[]; inProgressPass: string | null }> {
  const cache = new Map<string, GhCompare>();
  const compare = async (base: string, tip: string): Promise<GhCompare> => {
    const key = `${base}...${tip}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const value = (await gh.get(`/repos/${repo}/compare/${base}...${tip}`)) as GhCompare;
    cache.set(key, value);
    return value;
  };
  const isAncestorOrEqual = async (ancestor: string, descendant: string): Promise<boolean> => {
    if (sameSha(ancestor, descendant)) return true;
    const result = await compare(ancestor, descendant);
    return result.status === "ahead" || result.status === "identical";
  };

  const next: PassState[] = [];
  for (const pass of passes) {
    if (pass.outcome.kind !== "recorded") {
      next.push(pass);
      continue;
    }
    const record = pass.outcome.record;
    const outputIsAncestor = await isAncestorOrEqual(record.output_sha, head);
    const range = await seatRange(record, baseSha, compare, isAncestorOrEqual);
    next.push({ ...pass, outputIsAncestor, range });
  }

  const firstGap = next.find((pass) => pass.outcome.kind !== "recorded");
  let inProgressPass: string | null = null;
  if (firstGap && firstGap.outcome.kind === "absent") {
    const index = next.indexOf(firstGap);
    const previous = index > 0 ? next[index - 1] : undefined;
    if (previous?.outcome.kind === "recorded") {
      const output = previous.outcome.record.output_sha;
      if (!sameSha(output, head)) {
        const result = await compare(output, head);
        if (result.status === "ahead") inProgressPass = firstGap.id;
      }
    }
  }
  return { passes: next, inProgressPass };
}

async function seatRange(
  record: SeatRecord,
  baseSha: string,
  compare: (base: string, tip: string) => Promise<GhCompare>,
  isAncestorOrEqual: (ancestor: string, descendant: string) => Promise<boolean>,
): Promise<{ commits: RangeCommit[]; error: string | null }> {
  if (sameSha(record.input_sha, record.output_sha)) {
    return { commits: [], error: null };
  }
  const result = await compare(record.input_sha, record.output_sha);
  if (result.status !== "ahead") {
    return {
      commits: [],
      error: `input_sha ${record.input_sha} is not an ancestor of output_sha ${record.output_sha} (${result.status})`,
    };
  }
  const commits = result.commits ?? [];
  const total = result.total_commits ?? commits.length;
  if (commits.length !== total) {
    return { commits: [], error: `compare of ${record.input_sha}..${record.output_sha} was truncated (${commits.length} of ${total})` };
  }
  const kept: RangeCommit[] = [];
  for (const commit of commits) {
    if (await isAncestorOrEqual(commit.sha, baseSha)) continue;
    const name = commit.commit?.author?.name ?? "";
    const email = commit.commit?.author?.email ?? "";
    kept.push({ sha: commit.sha, author: `${name} <${email}>` });
  }
  return { commits: kept, error: null };
}
