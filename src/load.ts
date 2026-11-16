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
  Unreadable,
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
  const known = new Set(config.passes.map((pass) => pass.id));
  const { attempts, notices, unreadable } = parseAttempts(comments, config, known);
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
    unreadable: listedUnreadable(unreadable, compared.passes),
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

type UnreadableEvent = { commentUrl: string; reason: string; target: string | null };

function parseAttempts(
  comments: GhComment[],
  config: Config,
  known: Set<string>,
): { attempts: Attempt[]; notices: Notice[]; unreadable: UnreadableEvent[] } {
  const ordered = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const attempts: Attempt[] = [];
  const notices: Notice[] = [];
  const unreadable: UnreadableEvent[] = [];
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
      const reason = `invalid JSON: ${message}`;
      const guessed = guessPass(raw);
      if (guessed !== null && known.has(guessed)) {
        attempts.push(failedAttempt(comment, guessed, reason));
      } else {
        countUnreadable(unreadable, attempts, config, comment, reason);
      }
      continue;
    }
    if (!isRecordAttempt(value)) {
      notices.push({
        rule: "extraction",
        commentUrl: comment.html_url,
        message: "json block is not a seat record",
      });
      continue;
    }
    const result = validateSeatRecord(value);
    const pass = passField(value);
    if (pass !== null && known.has(pass)) {
      attempts.push({
        pass,
        commentUrl: comment.html_url,
        createdAt: comment.created_at,
        id: comment.id,
        valid: result.ok,
        reason: result.ok ? null : result.reason,
        record: result.ok ? result.record : null,
      });
      continue;
    }
    countUnreadable(unreadable, attempts, config, comment, result.ok ? "pass cannot be read" : result.reason);
  }
  return { attempts, notices, unreadable };
}

function failedAttempt(comment: GhComment, pass: string, reason: string): Attempt {
  return {
    pass,
    commentUrl: comment.html_url,
    createdAt: comment.created_at,
    id: comment.id,
    valid: false,
    reason,
    record: null,
  };
}

/** A parsed object is a record attempt only when seat_record or pass is at the top level. */
function isRecordAttempt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return "seat_record" in record || "pass" in record;
}

function passField(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pass = (value as { pass?: unknown }).pass;
  if (typeof pass === "string") return pass;
  if (typeof pass === "number" && Number.isFinite(pass)) return String(pass);
  return null;
}

function countUnreadable(
  unreadable: UnreadableEvent[],
  attempts: Attempt[],
  config: Config,
  comment: GhComment,
  reason: string,
): void {
  const target = config.passes.find((pass) => !attempts.some((attempt) => attempt.pass === pass.id && attempt.valid))?.id ?? null;
  unreadable.push({ commentUrl: comment.html_url, reason, target });
  if (target === null) return;
  attempts.push(failedAttempt(comment, target, reason));
}

function listedUnreadable(events: UnreadableEvent[], passes: PassState[]): Unreadable[] {
  const listed: Unreadable[] = [];
  for (const event of events) {
    if (event.target === null) {
      listed.push({ commentUrl: event.commentUrl, reason: event.reason, attached: false });
      continue;
    }
    const pass = passes.find((candidate) => candidate.id === event.target);
    if (!pass || pass.outcome.kind !== "rejected") continue;
    listed.push({ commentUrl: event.commentUrl, reason: event.reason, attached: true });
  }
  return listed;
}

function passState(pass: { id: string; role: string; seat: string }, attempts: Attempt[]): PassState {
  const base = { id: pass.id, role: pass.role, seat: pass.seat, outputIsAncestor: null, range: null };
  const valid = attempts.filter((attempt) => attempt.valid && attempt.record);
  const chosen = valid[valid.length - 1];
  if (chosen?.record) {
    const priorFailures = attempts.filter((attempt) => !attempt.valid && isBefore(attempt, chosen)).length;
    const laterRejections = attempts
      .filter((attempt) => !attempt.valid && isBefore(chosen, attempt))
      .map((attempt) => ({ commentUrl: attempt.commentUrl, reason: attempt.reason ?? "malformed record" }));
    return {
      ...base,
      outcome: {
        kind: "recorded",
        record: chosen.record,
        commentUrl: chosen.commentUrl,
        priorFailures,
        laterRejections,
      },
    };
  }
  if (attempts.length === 0) return { ...base, outcome: { kind: "absent" } };
  const last = attempts[attempts.length - 1] as Attempt;
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

function isBefore(attempt: Attempt, other: Attempt): boolean {
  return attempt.createdAt < other.createdAt || (attempt.createdAt === other.createdAt && attempt.id < other.id);
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
