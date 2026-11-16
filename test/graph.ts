import { readFileSync } from "node:fs";
import { parseConfig } from "../src/config.js";
import type { GhClient, GhGetOptions } from "../src/gh.js";
import type { Config, GhComment, GhCompare, GhPull } from "../src/types.js";

export type Node = { parents: string[]; author: string };

export function kickoffConfig(): Config {
  const file = new URL("../examples/kickoff.elenchus.json", import.meta.url);
  return parseConfig(JSON.parse(readFileSync(file, "utf8")) as unknown);
}

export function comment(id: number, body: string, createdAt: string): GhComment {
  return {
    id,
    html_url: `https://github.com/BeniCheni/elenchus/pull/1#issuecomment-${id}`,
    body,
    created_at: createdAt,
    user: { login: "BeniCheni" },
  };
}

export function fenced(record: unknown): string {
  return `Transcribed for the test.\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
}

export function graphGh(input: {
  head: string;
  baseSha: string;
  /** Current tip of the base branch, when the pull request object still names an older SHA. */
  branchTip?: string;
  baseRef?: string;
  comments: GhComment[];
  nodes: Record<string, Node>;
  calls?: { path: string; paginate?: boolean }[];
}): GhClient {
  const nodes = input.nodes;
  const resolve = (sha: string): string => {
    const hits = Object.keys(nodes).filter((key) => key === sha || key.startsWith(sha) || sha.startsWith(key));
    if (hits.length !== 1) throw new Error(`sha ${sha} matches ${hits.length} commits`);
    return hits[0] as string;
  };
  const reachable = (sha: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [resolve(sha)];
    while (stack.length) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const parent of nodes[current]?.parents ?? []) stack.push(resolve(parent));
    }
    return seen;
  };
  const compare = (base: string, head: string): GhCompare => {
    const baseSha = resolve(base);
    const headSha = resolve(head);
    if (baseSha === headSha) return { status: "identical", total_commits: 0, commits: [] };
    const fromHead = reachable(headSha);
    const fromBase = reachable(baseSha);
    let status: GhCompare["status"];
    if (fromHead.has(baseSha)) status = "ahead";
    else if (fromBase.has(headSha)) status = "behind";
    else status = "diverged";
    const shas = [...fromHead].filter((sha) => !fromBase.has(sha));
    return {
      status,
      total_commits: shas.length,
      commits: shas.map((sha) => {
        const [name, email] = splitAuthor(nodes[sha]?.author ?? " <");
        return { sha, commit: { author: { name, email } } };
      }),
    };
  };
  const pull: GhPull = {
    number: 1,
    html_url: "https://github.com/BeniCheni/elenchus/pull/1",
    head: { sha: resolve(input.head) },
    base: { sha: resolve(input.baseSha), ref: input.baseRef ?? "replay/main" },
  };
  const branchTip = resolve(input.branchTip ?? input.baseSha);
  return {
    async get(apiPath: string, options?: GhGetOptions) {
      input.calls?.push({ path: apiPath, ...(options?.paginate ? { paginate: true } : {}) });
      if (apiPath === "/repos/BeniCheni/elenchus/pulls/1") return pull;
      if (apiPath === `/repos/BeniCheni/elenchus/commits/${pull.base.ref}`) return { sha: branchTip };
      if (apiPath.startsWith("/repos/BeniCheni/elenchus/issues/1/comments")) return input.comments;
      const match = apiPath.match(/\/compare\/([^./]+)\.\.\.([^./]+)$/);
      if (match) return compare(match[1] ?? "", match[2] ?? "");
      throw new Error(`unexpected GET ${apiPath}`);
    },
  };
}

function splitAuthor(author: string): [string, string] {
  const match = author.match(/^(.*) <(.*)>$/);
  if (!match) return [author, ""];
  return [match[1] ?? "", match[2] ?? ""];
}
