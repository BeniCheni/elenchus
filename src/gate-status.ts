import type { GhClient } from "./gh.js";
import type { GateConfig } from "./types.js";

type Status = {
  context: string;
  state: string;
  creator?: { login?: string; type?: string };
};

export async function readGateStatus(gh: GhClient, repo: string, head: string, gate: GateConfig): Promise<string> {
  const statuses = await gh.get(`/repos/${repo}/commits/${head}/statuses?per_page=100`, { paginate: true }) as Status[];
  const matching = statuses.filter((status) => status.context.toLowerCase() === gate.context.toLowerCase());
  if (matching.length === 0) return "no status";
  // The statuses endpoint returns newest first across pages.
  const creators = new Map<string | undefined, { state: string; type: string; earlier: number }>();
  for (const status of matching) {
    const login = status.creator?.login;
    const existing = creators.get(login);
    if (existing) existing.earlier += 1;
    else creators.set(login, { state: status.state, type: status.creator?.type ?? "unknown", earlier: 0 });
  }
  const summaries = [...creators].map(([login, { state, type, earlier }]) => {
    const count = earlier === 1 ? "1 earlier status" : `${earlier} earlier statuses`;
    return `${state} by ${login ?? "unknown"} (${type}, ${count})`;
  });
  return `${summaries.join(", ")}; source UNVERIFIED because GitHub's status API does not report which App posted it; the review gate's ruleset decides whether it counts`;
}
