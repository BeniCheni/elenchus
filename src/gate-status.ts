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
  const creators = matching.map((status) => {
    const login = status.creator?.login ?? "unknown";
    const type = status.creator?.type ?? "unknown";
    return `${status.state} by ${login} (${type})`;
  });
  return `${creators.join(", ")}; source UNVERIFIED because GitHub's status API does not report which App posted it; the review gate's ruleset decides whether it counts`;
}
