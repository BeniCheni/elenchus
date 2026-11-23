import { posix } from "node:path";
import type { GhClient } from "./gh.js";
import { recordTimeline, rereadBoundary, UnresolvedSha } from "./load.js";
import { diffTrees, readTree } from "./manifest.js";
import { FULL_SHA, sameSha } from "./sha.js";
import type { AllowedChanges, CheckItem, GhCompareCommit, ReviewState } from "./types.js";

const DEFAULT_VERSION_PATTERN = "(?:0|[1-9][0-9]*)(?:\\.(?:0|[1-9][0-9]*)){2}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";

type CheckRun = {
  name: string;
  status: string;
  conclusion?: string | null;
  head_sha: string;
  app?: { id: number } | null;
};

export async function checkHead(gh: GhClient, state: ReviewState, forAuthorization = false): Promise<CheckItem[]> {
  const gate = state.config.gate;
  const allowed = gate?.allowed_changes;
  const lastPass = state.passes.at(-1);
  const last = lastPass?.outcome.kind === "recorded" ? lastPass.outcome.record : undefined;
  const boundary = allowed ? rereadBoundary(state.config, state.passes) : last;
  const rereadPass = allowed?.reread_pass ?? lastPass?.id;
  const changed = boundary && !sameSha(state.head, boundary.output_sha);
  if (state.pull.merged || (!changed && !forAuthorization)) return [];

  const items = gate ? await checkRequiredRuns(gh, state) : [];
  if (forAuthorization) {
    const latest = recordTimeline(state.passes).at(-1)?.record;
    const outputs = new Set([boundary?.output_sha, last?.output_sha, latest?.output_sha]);
    for (const output of outputs) {
      if (output !== undefined && !FULL_SHA.test(output)) {
        items.push(headFailure(`output_sha ${output} must be a full 40-digit SHA for authorize`));
      }
    }
  }
  if (!changed) return items;
  const reviewed = boundary.output_sha;
  const reread = rereadPass ? `pass ${rereadPass} re-read` : "re-read";
  if (!allowed) {
    items.push(headFailure(`head ${state.head} differs from ${reviewed}; needs a ${reread}`));
    return items;
  }

  const difference = await state.compare(reviewed, state.head, true).catch((error: unknown) => {
    if (error instanceof UnresolvedSha) return null;
    throw error;
  });
  if (difference?.status !== "ahead") {
    items.push(headFailure(`head ${state.head} does not advance from ${reviewed}; needs a ${reread}`));
    return items;
  }
  const commits = difference.commits ?? [];
  if (commits.length === 0 || difference.total_commits !== commits.length) {
    items.push(headFailure(`compare of ${reviewed} to ${state.head} did not list every commit; needs a ${reread}`));
    return items;
  }

  const canonicalBoundary = difference.base_commit?.sha ?? reviewed;
  const proof = new HeadChanges(gh, state, canonicalBoundary, allowed);
  const parentOf = new Map(commits.map((commit) => [commit.sha, commit.parents?.[0]?.sha]));
  // The commits brought in by a verified base merge were reviewed on the
  // base branch. Classify the merge itself and the PR's first-parent chain.
  const onBranch = firstParentChain(state.head, canonicalBoundary, parentOf);
  if (!onBranch) {
    items.push(headFailure(`head ${state.head} does not continue ${reviewed} on its first-parent chain; needs a ${reread}`));
    return items;
  }
  for (const commit of commits) {
    if (!onBranch.has(commit.sha)) continue;
    const shape = await proof.classify(commit);
    items.push(shape
      ? { severity: "notice", rule: "head", message: `${commit.sha} allowed shape: ${shape}` }
      : headFailure(`${commit.sha} needs a ${reread} at ${state.head}`));
  }
  return items;
}

function firstParentChain(head: string, reviewed: string, parents: Map<string, string | undefined>): Set<string> | null {
  const chain = new Set<string>();
  let tip = head;
  while (!sameSha(tip, reviewed)) {
    const parent = parents.get(tip);
    if (!parent || chain.has(tip)) return null;
    chain.add(tip);
    tip = parent;
  }
  return chain;
}

function headFailure(message: string): CheckItem {
  return { severity: "fail", rule: "head", message };
}

async function checkRequiredRuns(gh: GhClient, state: ReviewState): Promise<CheckItem[]> {
  const required = state.config.gate?.required_checks ?? [];
  if (required.length === 0) return [];
  const { check_runs: runs } = await gh.get(
    `/repos/${state.repo}/commits/${state.head}/check-runs?filter=latest&per_page=100`,
    { paginate: true },
  ) as { check_runs: CheckRun[] };
  const items: CheckItem[] = [];
  for (const check of required) {
    const matching = runs.filter((run) =>
      run.name === check.name && run.head_sha === state.head &&
      (check.app_id === undefined || run.app?.id === check.app_id),
    );
    const bad = matching.filter((run) => run.status !== "completed" || run.conclusion !== "success");
    if (matching.length > 0 && bad.length === 0) continue;
    const reason = matching.length === 0
      ? "missing"
      : bad.map((run) => run.conclusion ?? run.status).join(", ");
    items.push({ severity: "fail", rule: "ci", message: `${check.name} at ${state.head} is ${reason}` });
  }
  return items;
}

type GitTree = Awaited<ReturnType<typeof readTree>>;
type TreeEntry = GitTree["tree"][number];

class HeadChanges {
  private trees = new Map<string, Promise<GitTree>>();
  private blobs = new Map<string, Promise<string | null>>();

  constructor(
    private gh: GhClient,
    private state: ReviewState,
    private reviewed: string,
    private allowed: AllowedChanges,
  ) {}

  async classify(commit: GhCompareCommit): Promise<string | null> {
    const parents = commit.parents ?? [];
    const parent = parents[0]?.sha;
    if (!parent || parents.length > 2) return null;
    const [before, after] = await Promise.all([this.tree(parent), this.tree(commit.sha)]);
    if (before.truncated || after.truncated) return null;
    const previous = pathIndex(before);
    const next = pathIndex(after);
    if (parents.length === 2) {
      const second = parents[1]!.sha;
      if (!await this.onBase(second)) return null;
      return await this.cleanMerge(parent, second, previous, next) ? "merge of the base branch" : null;
    }

    const paths = diffTrees(before.tree, after.tree).map(({ path }) => path);
    const version = this.allowed.version_only;
    const versionFile = posix.normalize(version?.file ?? "package.json");
    const versionDir = posix.dirname(versionFile);
    const install = this.state.config.installs?.find(({ dir }) => posix.normalize(dir) === versionDir);
    const lockFile = posix.join(versionDir, install?.lockfile ?? "package-lock.json");
    const outside = paths.filter((path) => path !== versionFile && path !== lockFile &&
      !this.allowed.paths.some((pattern) => posix.matchesGlob(path, pattern)));
    const changesVersion = paths.includes(versionFile);
    const changesLock = paths.includes(lockFile);
    if (outside.length === 0 && !changesVersion && !changesLock) return "only configured paths";
    if (!version || outside.some((path) => !version.tests.some((pattern) => posix.matchesGlob(path, pattern)))) {
      return null;
    }
    const pattern = new RegExp(`^(?:${version.pattern ?? DEFAULT_VERSION_PATTERN})$`);
    const [beforeVersion, afterVersion] = await Promise.all([
      this.json(previous.get(versionFile)), this.json(next.get(versionFile)),
    ]);
    if (!beforeVersion || !afterVersion) return null;
    const newVersion = versionOf(afterVersion.value, pattern);
    let oldVersion = versionOf(beforeVersion.value, pattern);
    if (!newVersion || !oldVersion) return null;
    if (changesVersion && (oldVersion === newVersion || !sameFileMode(previous, next, versionFile) ||
        !sameVersionLines(beforeVersion.text, afterVersion.text, false))) return null;
    if (changesLock && (!sameFileMode(previous, next, lockFile) || !await this.versionOnlyLock(
      previous.get(lockFile), next.get(lockFile), oldVersion, newVersion, pattern,
    ))) return null;
    if (outside.length === 0) return "version files only";
    if (oldVersion === newVersion) {
      const reviewTree = await this.tree(this.reviewed);
      if (reviewTree.truncated) return null;
      oldVersion = versionOf((await this.json(pathIndex(reviewTree).get(versionFile)))?.value, pattern);
    }
    if (!oldVersion || !newVersion || oldVersion === newVersion) return null;
    for (const path of outside) {
      const left = previous.get(path);
      const right = next.get(path);
      if (!left || !right || left.mode !== right.mode) return null;
      const [oldText, newText] = await Promise.all([this.text(left), this.text(right)]);
      if (oldText === null || newText === null || !oldText.includes(oldVersion) ||
          oldText.replaceAll(oldVersion, () => newVersion) !== newText) return null;
    }
    return "test version replacement";
  }

  private async cleanMerge(
    first: string, second: string, ours: Map<string, TreeEntry>, result: Map<string, TreeEntry>,
  ): Promise<boolean> {
    const compare = await this.state.compare(first, second).catch((error: unknown) => {
      if (error instanceof UnresolvedSha) return null;
      throw error;
    });
    const ancestor = compare?.merge_base_commit?.sha;
    if (!ancestor) return false;
    const [baseTree, incomingTree] = await Promise.all([this.tree(ancestor), this.tree(second)]);
    if (baseTree.truncated || incomingTree.truncated) return false;
    const base = pathIndex(baseTree);
    const incoming = pathIndex(incomingTree);
    const paths = new Set([...base.keys(), ...ours.keys(), ...incoming.keys(), ...result.keys()]);
    for (const path of paths) {
      const original = base.get(path);
      const left = ours.get(path);
      const right = incoming.get(path);
      const expected = sameEntry(original, left) ? right : left;
      if (!sameEntry(original, left) && !sameEntry(original, right) && !sameEntry(left, right)) return false;
      if (!sameEntry(expected, result.get(path))) return false;
    }
    // A comparison names one merge base. Any other merge base appears in
    // both parents' ranges from that base.
    const [left, right] = await Promise.all([
      this.commitsSince(ancestor, first), this.commitsSince(ancestor, second),
    ]);
    if (!left || !right) return false;
    const leftShas = new Set(left.map(({ sha }) => sha));
    return !right.some(({ sha }) => leftShas.has(sha));
  }

  private async commitsSince(base: string, tip: string): Promise<GhCompareCommit[] | null> {
    if (base === tip) return [];
    const compare = await this.state.compare(base, tip, true).catch((error: unknown) => {
      if (error instanceof UnresolvedSha) return null;
      throw error;
    });
    const commits = compare?.commits;
    return compare?.status === "ahead" && commits && compare.total_commits === commits.length ? commits : null;
  }

  private async versionOnlyLock(
    before: TreeEntry | undefined, after: TreeEntry | undefined, oldVersion: string, newVersion: string, pattern: RegExp,
  ): Promise<boolean> {
    const [from, to] = await Promise.all([this.json(before), this.json(after)]);
    if (!from || !to) return false;
    const lockVersion = versionOf(from.value, pattern);
    if (!lockVersion || lockVersion === newVersion ||
        (oldVersion !== newVersion && lockVersion !== oldVersion)) return false;
    if (lockRoot(from.value)?.version !== lockVersion || to.value.version !== newVersion ||
        lockRoot(to.value)?.version !== newVersion) return false;
    return sameVersionLines(from.text, to.text, true);
  }

  private tree(sha: string): Promise<GitTree> {
    const prior = this.trees.get(sha);
    if (prior) return prior;
    const result = readTree(this.gh, this.state.repo, sha);
    this.trees.set(sha, result);
    return result;
  }

  private async onBase(sha: string): Promise<boolean> {
    if (sameSha(sha, this.state.baseSha)) return true;
    const compare = await this.state.compare(sha, this.state.baseSha).catch((error: unknown) => {
      if (error instanceof UnresolvedSha) return null;
      throw error;
    });
    return compare?.status === "ahead" || compare?.status === "identical";
  }

  private async json(entry: TreeEntry | undefined): Promise<{ text: string; value: Record<string, unknown> } | null> {
    if (!entry) return null;
    const text = await this.text(entry);
    if (text === null) return null;
    try {
      const value = jsonObject(JSON.parse(text) as unknown);
      return value ? { text, value } : null;
    } catch {
      return null;
    }
  }

  private text(entry: TreeEntry): Promise<string | null> {
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) return Promise.resolve(null);
    const cached = this.blobs.get(entry.sha);
    if (cached) return cached;
    const pending = (async () => {
      const blob = await this.gh.get(`/repos/${this.state.repo}/git/blobs/${entry.sha}`) as {
        content?: string;
        encoding?: string;
      };
      if (blob.encoding !== "base64" || typeof blob.content !== "string") return null;
      const bytes = Buffer.from(blob.content, "base64");
      const text = bytes.toString("utf8");
      return Buffer.from(text, "utf8").equals(bytes) ? text : null;
    })();
    this.blobs.set(entry.sha, pending);
    return pending;
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function lockRoot(value: Record<string, unknown>): Record<string, unknown> | null {
  return jsonObject(jsonObject(value.packages)?.[""]);
}

function versionOf(value: Record<string, unknown> | undefined, pattern: RegExp): string | null {
  const version = value?.version;
  return typeof version === "string" && pattern.exec(version)?.[0] === version ? version : null;
}

function sameVersionLines(before: string, after: string, lock: boolean): boolean {
  const oldLines = versionLines(before, lock);
  const newLines = versionLines(after, lock);
  return oldLines !== null && newLines !== null && oldLines.length === newLines.length &&
    oldLines.every((line, index) => line === newLines[index]);
}

function versionLines(text: string, lock: boolean): string[] | null {
  // The caller already parsed the document. Walk the original tokens so a
  // dependency's version and the order or formatting of keys remain visible.
  const frames: { path: string[] | null; key?: string }[] = [];
  const spans: { start: number; end: number }[] = [];
  let member = false;
  for (const { 0: token, 1: string, 2: colon, index } of text.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}[\],]/g)) {
    const frame = frames.at(-1);
    if (token === "{" || token === "[") {
      const path = !frame ? [] : frame.path && frame.key !== undefined ? [...frame.path, frame.key] : null;
      frames.push({ path: token === "{" ? path : null });
    } else if (token === "}" || token === "]") {
      frames.pop();
    } else if (frame?.path) {
      if (token === ",") {
        delete frame.key;
      } else if (colon) {
        frame.key = JSON.parse(string!) as string;
      } else if (frame.key === "version" && (
        frame.path.length === 0 || (lock && frame.path.length === 2 && frame.path[0] === "packages" && frame.path[1] === "")
      )) {
        // Require one root version and, for the lockfile, one package version.
        if (frame.path.length === 0) {
          if (member) return null;
          member = true;
        }
        spans.push({ start: index, end: index + token.length });
      }
    }
  }
  if (!member || spans.length !== (lock ? 2 : 1)) return null;
  let normalized = text;
  for (const { start, end } of spans.reverse()) {
    normalized = normalized.slice(0, start) + '""' + normalized.slice(end);
  }
  return normalized.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function sameFileMode(before: Map<string, TreeEntry>, after: Map<string, TreeEntry>, path: string): boolean {
  return before.get(path)?.mode === after.get(path)?.mode;
}

function pathIndex(tree: GitTree): Map<string, TreeEntry> {
  return new Map(tree.tree.filter(({ type }) => type !== "tree").map((entry) => [entry.path, entry]));
}

function sameEntry(left: TreeEntry | undefined, right: TreeEntry | undefined): boolean {
  return left?.sha === right?.sha && left?.mode === right?.mode;
}
