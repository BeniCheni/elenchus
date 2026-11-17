import { posix } from "node:path";
import type { GhClient } from "./gh.js";
import { recordTimeline } from "./load.js";
import { diffTrees, readTree } from "./manifest.js";
import { sameSha } from "./sha.js";
import type { AllowedChanges, CheckItem, GhCompare, GhCompareCommit, ReviewState } from "./types.js";

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
  const allRecorded = state.passes.every(({ outcome }) => outcome.kind === "recorded");
  const lastPass = state.passes.at(-1)?.id;
  const rereadPass = allowed?.reread_pass ?? lastPass;
  // A later re-read of a different seat can update that seat's record, but it
  // cannot stand in for the review required at a changed head.
  const last = allRecorded ? recordTimeline(state.passes).filter(({ record }) =>
    record.reread ? record.pass === rereadPass : record.pass === lastPass,
  ).at(-1) : undefined;
  const changed = last && !sameSha(state.head, last.record.output_sha);
  if (state.pull.merged || (!changed && !forAuthorization)) return [];

  const items = gate ? await checkRequiredRuns(gh, state) : [];
  if (!changed) return items;
  const reviewed = last.record.output_sha;
  const reread = rereadPass ? `pass ${rereadPass} re-read` : "re-read";
  if (!allowed) {
    items.push(headFailure(`head ${state.head} differs from ${reviewed}; needs a ${reread}`));
    return items;
  }

  const difference = await gh.get(
    `/repos/${state.repo}/compare/${reviewed}...${state.head}?per_page=100`,
    { paginate: true },
  ) as GhCompare;
  if (difference.status !== "ahead") {
    items.push(headFailure(`head ${state.head} does not advance from ${reviewed}; needs a ${reread}`));
    return items;
  }
  const commits = difference.commits ?? [];
  if (commits.length === 0 || difference.total_commits !== commits.length) {
    items.push(headFailure(`compare of ${reviewed} to ${state.head} did not list every commit; needs a ${reread}`));
    return items;
  }

  const proof = new HeadChanges(gh, state, reviewed, allowed);
  const parentOf = new Map(commits.map((commit) => [commit.sha, commit.parents?.[0]?.sha]));
  // The commits brought in by a verified base merge were reviewed on the
  // base branch. Classify the merge itself and the PR's first-parent chain.
  const onBranch = firstParentChain(state.head, reviewed, parentOf);
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
    const paths = diffTrees(before.tree, after.tree).map(({ path }) => path);
    const previous = pathIndex(before);
    const next = pathIndex(after);
    if (parents.length === 2) {
      const second = parents[1]!.sha;
      if (!await this.onBase(second)) return null;
      const base = await this.tree(second);
      if (base.truncated) return null;
      const incoming = pathIndex(base);
      const takesIncoming = paths.every((path) => sameEntry(next.get(path), incoming.get(path)));
      return takesIncoming ? "merge of the base branch" : null;
    }

    const outside = paths.filter((path) => !this.allowed.paths.some((pattern) => posix.matchesGlob(path, pattern)));
    if (outside.length === 0) return "only configured paths";
    const version = this.allowed.version_only;
    if (!version || outside.some((path) => !version.tests.some((pattern) => posix.matchesGlob(path, pattern)))) {
      return null;
    }
    const newVersion = await this.version(next.get(version.file));
    let oldVersion = await this.version(previous.get(version.file));
    if (oldVersion === newVersion) {
      const reviewTree = await this.tree(this.reviewed);
      if (reviewTree.truncated) return null;
      oldVersion = await this.version(pathIndex(reviewTree).get(version.file));
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

  private tree(sha: string): Promise<GitTree> {
    const prior = this.trees.get(sha);
    if (prior) return prior;
    const result = readTree(this.gh, this.state.repo, sha);
    this.trees.set(sha, result);
    return result;
  }

  private async onBase(sha: string): Promise<boolean> {
    if (sameSha(sha, this.state.baseSha)) return true;
    const compare = await this.gh.get(`/repos/${this.state.repo}/compare/${sha}...${this.state.baseSha}?per_page=1`) as GhCompare;
    return compare.status === "ahead" || compare.status === "identical";
  }

  private async version(entry: TreeEntry | undefined): Promise<string | null> {
    if (!entry) return null;
    const text = await this.text(entry);
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as { version?: unknown } | null;
      return typeof value?.version === "string" ? value.version : null;
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

function pathIndex(tree: GitTree): Map<string, TreeEntry> {
  return new Map(tree.tree.filter(({ type }) => type !== "tree").map((entry) => [entry.path, entry]));
}

function sameEntry(left: TreeEntry | undefined, right: TreeEntry | undefined): boolean {
  return left?.sha === right?.sha && left?.mode === right?.mode;
}
