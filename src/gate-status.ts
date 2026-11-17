import type { GhClient } from "./gh.js";
import type { GateConfig } from "./types.js";

type Status = {
  context: string;
  state: string;
  creator?: { login?: string; type?: string };
};

export async function readGateStatus(gh: GhClient, repo: string, head: string, gate: GateConfig): Promise<string> {
  const statuses = await gh.get(`/repos/${repo}/commits/${head}/statuses?per_page=100`, { paginate: true }) as Status[];
  const seen = new Set<string>();
  const foreign: string[] = [];
  let configured: string | undefined;
  for (const status of statuses) {
    if (status.context.toLowerCase() !== gate.context.toLowerCase()) continue;
    const login = status.creator?.login ?? "unknown";
    if (seen.has(login)) continue;
    seen.add(login);
    const slug = status.creator?.type === "Bot" ? /^([a-z0-9-]+)\[bot\]$/i.exec(login)?.[1] : undefined;
    if (slug && gate.app_id !== undefined && await matchesApp(gh, slug, gate.app_id)) {
      configured = `${status.state} by ${login} (App ${gate.app_id})`;
    } else {
      foreign.push(`${status.state} by ${login} (does not count)`);
    }
  }
  return [configured, ...foreign].filter(Boolean).join(", ") || "no status";
}

async function matchesApp(gh: GhClient, slug: string, id: number): Promise<boolean> {
  try {
    const app = await gh.get(`/apps/${encodeURIComponent(slug)}`) as { id?: number };
    return app.id === id;
  } catch (error) {
    if (error instanceof Error && error.message.includes("HTTP 404")) return false;
    throw error;
  }
}
