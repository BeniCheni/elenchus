import { parseConfig } from "./config.js";
import type { GhClient } from "./gh.js";
import { readManifest } from "./manifest.js";
import { extractRecord, guessPass, hasJsonFence, hasUnreadJsonFence } from "./records.js";
import { readGateStatus } from "./gate-status.js";
import { validateSeatRecord } from "./schema.js";
import { sameSha } from "./sha.js";
import type {
  Attempt,
  CompareCommits,
  Config,
  GhComment,
  GhCompare,
  GhContent,
  GhPull,
  Notice,
  PassState,
  RangeCommit,
  RecordedPosting,
  ReviewState,
  SeatRecord,
  Unreadable,
} from "./types.js";

export async function loadReview(
  gh: GhClient,
  repo: string,
  pr: number,
  configOverride?: Config,
  options: { ranges?: boolean; gateStatus?: boolean } = {},
): Promise<ReviewState> {
  const pull = (await gh.get(`/repos/${repo}/pulls/${pr}`)) as GhPull;
  if (pull.number !== pr) throw new Error(`GitHub returned pull request ${pull.number} for ${pr}`);
  const [baseSha, comments] = await Promise.all([
    reviewBase(gh, repo, pull),
    gh.get(`/repos/${repo}/issues/${pr}/comments?per_page=100`, { paginate: true }) as Promise<GhComment[]>,
  ]);
  const config = configOverride ?? await readConfig(gh, repo, baseSha).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`configuration: base ${pull.base.ref} ${baseSha}\n${message}`);
  });
  const known = new Set(config.passes.map((pass) => pass.id));
  const { attempts, notices, unreadable } = parseAttempts(comments, config, known);
  const orphans = attempts
    .filter((attempt) => attempt.pass === null || !known.has(attempt.pass))
    .map((attempt) => ({
      rule: attempt.valid ? "pass" as const : "schema" as const,
      pass: attempt.pass,
      commentUrl: attempt.commentUrl,
      reason: attempt.reason ?? `pass ${attempt.pass} is not configured`,
    }));
  const passes = config.passes.map((pass) => passState(pass, attempts.filter((attempt) => attempt.pass === pass.id)));
  const boundary = rereadBoundary(config, passes)?.output_sha;
  const compare = reviewCompare(gh, repo, pull.head.sha, boundary);
  const compared = await attachGit(gh, repo, pull.head.sha, baseSha, passes, config, compare, {
    ranges: options.ranges !== false && !pull.merged,
    merged: pull.merged === true,
  });
  const gateStatus = options.gateStatus && config.gate
    ? await readGateStatus(gh, repo, pull.head.sha, config.gate)
    : null;
  return {
    repo,
    pr: pull.number,
    head: pull.head.sha,
    baseRef: pull.base.ref,
    baseSha,
    pull,
    gateStatus,
    config,
    compare,
    passes: compared.passes,
    orphans,
    notices: [...(config.unknownKeys ?? []).map((key) => ({ rule: "config", message: `unknown key ${key}` })), ...notices],
    unreadable: listedUnreadable(unreadable, compared.passes),
    inProgressPass: compared.inProgressPass,
  };
}

async function reviewBase(gh: GhClient, repo: string, pull: GhPull): Promise<string> {
  if (pull.merged) {
    if (!pull.merge_commit_sha) return pull.base.sha;
    const merge = await gh.get(`/repos/${repo}/commits/${encodeURIComponent(pull.merge_commit_sha)}`) as {
      parents?: { sha: string }[];
    };
    return merge.parents?.[0]?.sha ?? pull.base.sha;
  }
  const ref = encodeURIComponent(`heads/${pull.base.ref}`);
  const tip = await gh.get(`/repos/${repo}/commits/${ref}`) as { sha: string };
  return tip.sha;
}

async function readConfig(gh: GhClient, repo: string, ref: string): Promise<Config> {
  let file: GhContent;
  try {
    file = (await gh.get(`/repos/${repo}/contents/.elenchus.json?ref=${encodeURIComponent(ref)}`)) as GhContent;
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
  const latestByPass = new Map<string, RecordedPosting>();
  const notices: Notice[] = [];
  const unreadable: UnreadableEvent[] = [];
  for (const comment of ordered) {
    const login = comment.user?.login ?? "";
    const body = comment.body ?? "";
    if (!config.record_authors.includes(login)) {
      if (hasJsonFence(body)) notices.push({
        rule: "record_authors",
        commentUrl: comment.html_url,
        message: `comment by ${login || "unknown"} ignored for records`,
      });
      continue;
    }
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
    if (pass !== null && (known.has(pass) || result.ok)) {
      const record = result.ok ? result.record : null;
      const prior = latestByPass.get(pass);
      const reason = record ? rereadError(record, prior?.record) : (result.ok ? null : result.reason);
      const replaces = record && prior && !record.reread && usesCurrentSchema(record, prior.record) && sameRange(record, prior.record)
        ? prior.id : undefined;
      if (record && reason === null) {
        latestByPass.set(pass, { record, id: comment.id, createdAt: comment.created_at, commentUrl: comment.html_url });
        if (replaces !== undefined) notices.push({
          rule: "record replacement",
          message: `pass ${pass} comment ${comment.id} replaces comment ${replaces} at the same SHAs`,
        });
      }
      attempts.push({
        pass,
        commentUrl: comment.html_url,
        createdAt: comment.created_at,
        id: comment.id,
        authorLogin: comment.user?.login ?? "",
        valid: reason === null,
        reason,
        record: reason === null ? record : null,
        ...(replaces === undefined ? {} : { replaces }),
      });
      continue;
    }
    countUnreadable(unreadable, attempts, config, comment, result.ok ? "pass cannot be read" : result.reason);
  }
  return { attempts, notices, unreadable };
}

function rereadError(record: SeatRecord, prior: SeatRecord | null | undefined): string | null {
  if (record.reread) {
    if (!prior) return "a re-read requires an earlier record for this pass";
    if (sameSha(prior.output_sha, record.output_sha)) return "a re-read requires a later output_sha";
  } else if (prior && usesCurrentSchema(record, prior) && !sameRange(record, prior)) {
    return "a repeat of this pass must be marked as a re-read";
  }
  return null;
}

function usesCurrentSchema(record: SeatRecord, prior: SeatRecord): boolean {
  return record.schema_version === "1.2" || prior.schema_version === "1.2";
}

function sameRange(record: SeatRecord, prior: SeatRecord): boolean {
  return record.input_sha.toLowerCase() === prior.input_sha.toLowerCase() &&
    record.output_sha.toLowerCase() === prior.output_sha.toLowerCase();
}

function failedAttempt(comment: GhComment, pass: string, reason: string): Attempt {
  return {
    pass,
    commentUrl: comment.html_url,
    createdAt: comment.created_at,
    id: comment.id,
    authorLogin: comment.user?.login ?? "",
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
  const base = { id: pass.id, role: pass.role, seat: pass.seat, outputIsAncestor: null, range: null, resolveError: null };
  const valid = attempts.filter(
    (attempt): attempt is Attempt & { record: SeatRecord } => attempt.valid && attempt.record !== null,
  );
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
        authorLogin: chosen.authorLogin,
        history: recordHistory(valid),
        posting: chosen,
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

function recordHistory(valid: (RecordedPosting & Pick<Attempt, "replaces">)[]): RecordedPosting[] {
  // A correction has the same SHA range and keeps the original posting slot.
  // Use the actual standing comment in the outcome for findings and ruling order.
  const timeline = valid.filter(({ replaces }) => replaces === undefined);
  const firstReread = timeline.findIndex(({ record }) => record.reread);
  // With no re-read, retain the last update just as legacy records have always done.
  return timeline.slice(firstReread === -1 ? -1 : firstReread - 1);
}

export function postingOrder(a: RecordedPosting, b: RecordedPosting): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
}

export function recordTimeline(passes: PassState[]): RecordedPosting[] {
  return passes
    .flatMap(({ outcome }) => outcome.kind === "recorded" ? outcome.history : [])
    .sort(postingOrder);
}

function isBefore(attempt: Attempt, other: Attempt): boolean {
  return attempt.createdAt < other.createdAt || (attempt.createdAt === other.createdAt && attempt.id < other.id);
}

export function rereadBoundary(config: Config, passes: PassState[]): SeatRecord | undefined {
  const pass = passes.find(({ id }) => id === config.gate?.allowed_changes?.reread_pass);
  return pass?.outcome.kind === "recorded" ? pass.outcome.record : undefined;
}

export class UnresolvedSha extends Error {
  constructor(readonly spec: string) {
    super(`cannot resolve ${spec}`);
    this.name = "UnresolvedSha";
  }
}

function reviewCompare(gh: GhClient, repo: string, head: string, boundary?: string): CompareCommits {
  const cache = new Map<string, GhCompare>();
  return async (base, tip, paginate = false) => {
    // Share the reviewed range with ancestry and seat reads, including legacy
    // records that abbreviate the already known current head.
    const reviewedRange = boundary && sameSha(base, boundary) && sameSha(tip, head) && !sameSha(boundary, head);
    if (reviewedRange) {
      base = boundary;
      tip = head;
    }
    const spec = `${base}...${tip}`;
    const key = paginate ? `${spec}?per_page=100` : spec;
    const hit = cache.get(`${spec}?per_page=100`) ?? cache.get(key);
    if (hit) return hit;
    const singlePage = reviewedRange ? cache.get(spec) : undefined;
    if (singlePage?.commits && singlePage.total_commits === singlePage.commits.length) return singlePage;
    try {
      const value = (await gh.get(`/repos/${repo}/compare/${key}`, paginate ? { paginate: true } : undefined)) as GhCompare;
      cache.set(key, value);
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Not Found") || message.includes("No common ancestor")) throw new UnresolvedSha(spec);
      throw error;
    }
  };
}

async function attachGit(
  gh: GhClient,
  repo: string,
  head: string,
  baseSha: string,
  passes: PassState[],
  config: Config,
  compare: CompareCommits,
  options: { ranges: boolean; merged: boolean },
): Promise<{ passes: PassState[]; inProgressPass: string | null }> {
  const isAncestorOrEqual = async (ancestor: string, descendant: string): Promise<boolean> => {
    if (sameSha(ancestor, descendant)) return true;
    const result = await compare(ancestor, descendant);
    return result.status === "ahead" || result.status === "identical";
  };

  const timeline = recordTimeline(passes);
  const next: PassState[] = [];
  for (const pass of passes) {
    if (!options.ranges || pass.outcome.kind !== "recorded") {
      next.push(pass);
      continue;
    }
    const record = pass.outcome.record;
    const wantsManifest = record.coverage !== undefined && (
      config.passes.find((item) => item.id === pass.id)?.coverage === true ||
      record.coverage.reviewed_paths !== undefined
    );
    try {
      const resolveError = await rereadChainError(pass.outcome.history, timeline, isAncestorOrEqual);
      const outputIsAncestor = await isAncestorOrEqual(record.output_sha, head);
      const range = await seatRange(record, baseSha, compare);
      const coverageManifest = wantsManifest
        ? await readManifest(gh, repo, await compare(baseSha, record.input_sha), record.input_sha)
        : undefined;
      next.push({ ...pass, resolveError, outputIsAncestor, range, ...(coverageManifest ? { coverageManifest } : {}) });
    } catch (error) {
      if (!(error instanceof UnresolvedSha)) throw error;
      const coverageManifest = wantsManifest ? { paths: [], error: error.message } : undefined;
      next.push({
        ...pass,
        outputIsAncestor: null,
        range: null,
        resolveError: error.message,
        ...(coverageManifest ? { coverageManifest } : {}),
      });
    }
  }

  const firstGap = next.find((pass) => pass.outcome.kind !== "recorded");
  let inProgressPass: string | null = null;
  if (!options.merged && firstGap?.outcome.kind === "absent") {
    const index = next.indexOf(firstGap);
    const previous = index > 0 ? next[index - 1] : undefined;
    if (previous?.outcome.kind === "recorded") {
      const output = previous.outcome.record.output_sha;
      if (!sameSha(output, head)) {
        try {
          const result = await compare(output, head);
          if (result.status === "ahead") inProgressPass = firstGap.id;
        } catch (error) {
          if (!(error instanceof UnresolvedSha)) throw error;
          const at = next.indexOf(previous);
          const current = next[at];
          if (current && !current.resolveError) next[at] = { ...current, resolveError: error.message };
        }
      }
    }
  }
  return { passes: next, inProgressPass };
}

async function rereadChainError(
  history: RecordedPosting[],
  timeline: RecordedPosting[],
  isAncestorOrEqual: (ancestor: string, descendant: string) => Promise<boolean>,
): Promise<string | null> {
  for (const [index, posting] of history.entries()) {
    if (!posting.record.reread) continue;
    const prior = history[index - 1]!.record.output_sha;
    const { input_sha: input, output_sha: output } = posting.record;
    if (!await isAncestorOrEqual(prior, output)) {
      return `re-read output_sha ${output} does not advance from ${prior}`;
    }
    const previous = timeline[timeline.indexOf(posting) - 1]!.record.output_sha;
    if (!await isAncestorOrEqual(previous, input)) {
      return `re-read input_sha ${input} does not continue from ${previous}`;
    }
  }
  return null;
}

async function seatRange(
  record: SeatRecord,
  baseSha: string,
  compare: (base: string, tip: string, paginate: boolean) => Promise<GhCompare>,
): Promise<{ commits: RangeCommit[]; error: string | null }> {
  if (sameSha(record.input_sha, record.output_sha)) {
    return { commits: [], error: null };
  }
  const inputIsBase = sameSha(baseSha, record.input_sha);
  const result = await compare(record.input_sha, record.output_sha, inputIsBase);
  if (result.status !== "ahead") {
    return {
      commits: [],
      error: `input_sha ${record.input_sha} is not an ancestor of output_sha ${record.output_sha} (${result.status})`,
    };
  }
  if (sameSha(baseSha, record.output_sha)) return { commits: [], error: null };
  const fromBase = inputIsBase ? result : await compare(baseSha, record.output_sha, true);
  const commits = fromBase.commits ?? [];
  if (fromBase.total_commits !== commits.length) {
    return { commits: [], error: `compare of base ${baseSha} to ${record.output_sha} was truncated` };
  }
  // The paginated comparison contains every commit outside the base. Walk only
  // in that graph to remove commits already present at the input.
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const canonicalInput = result.base_commit?.sha;
  const input = canonicalInput
    ? bySha.get(canonicalInput)
    : commits.find(({ sha }) => sameSha(record.input_sha, sha));
  const stack = input ? [input.sha] : [];
  const beforeInput = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (beforeInput.has(sha)) continue;
    const commit = bySha.get(sha);
    if (!commit) continue;
    if (!commit.parents) return { commits: [], error: `compare omitted parents of ${sha}` };
    beforeInput.add(sha);
    stack.push(...commit.parents.map((parent) => parent.sha));
  }

  return {
    commits: commits.filter(({ sha }) => !beforeInput.has(sha)).map((commit) => {
      const name = commit.commit?.author?.name ?? "";
      const email = commit.commit?.author?.email ?? "";
      return { sha: commit.sha, author: `${name} <${email}>` };
    }),
    error: null,
  };
}
