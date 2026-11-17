import { AppStatusClient } from "./app-status.js";
import { checkHead } from "./gate-review.js";
import type { GhClient } from "./gh.js";
import { loadReview, postingOrder } from "./load.js";
import { buildCheck } from "./report.js";
import type { CheckItem, ReviewState } from "./types.js";

type AuthorizeResult = { ok: false; items: CheckItem[] } | {
  ok: true;
  head: string;
  context: string;
  posted: boolean;
};

export async function authorize(
  gh: GhClient,
  repo: string,
  pr: number,
  options: { dryRun?: boolean; keychainService?: string; app?: AppStatusClient } = {},
): Promise<AuthorizeResult> {
  const state = await loadReview(gh, repo, pr);
  const gate = state.config.gate;
  if (!gate) throw new Error("config has no gate");
  const blocking = new Set<string>(gate.blocking_unverified);
  const items = buildCheck(state).filter(({ severity, rule }) =>
    severity === "fail" || (severity === "unverified" && blocking.has(rule)),
  );
  if (state.pull.merged || state.pull.state === "closed") {
    items.push({ severity: "fail", rule: "pr", message: "pull request is closed" });
  }
  for (const pass of state.passes) {
    if (pass.outcome.kind !== "recorded") {
      items.push({ severity: "fail", rule: "records", pass: pass.id, message: "no valid record" });
    }
  }
  items.push(...unresolvedFindings(state), ...await checkHead(gh, state, true));
  if (items.length > 0) return { ok: false, items };
  if (!options.dryRun) {
    if (gate.app_id === undefined) throw new Error("authorize requires config.gate.app_id");
    const app = options.app ?? new AppStatusClient();
    await app.post({
      repo,
      pr,
      context: gate.context,
      appId: gate.app_id,
      sha: state.head,
      keychainService: options.keychainService ?? "",
    });
  }
  return { ok: true, head: state.head, context: gate.context, posted: !options.dryRun };
}

function unresolvedFindings(state: ReviewState): CheckItem[] {
  const flow = state.config.finding_flow;
  const synthesis = state.passes.find(({ id }) => id === flow?.carries.at(-1));
  if (synthesis?.outcome.kind !== "recorded" || !flow?.ruling) return [];
  const ruling = state.passes.find(({ id }) => id === flow.ruling)?.outcome;
  const synthesized = synthesis.outcome.history.at(-1)!;
  if (ruling?.kind === "recorded" && postingOrder(ruling.history.at(-1)!, synthesized) > 0) return [];
  return synthesized.record.findings.filter(({ status }) => status === "contested").map(({ id }) => ({
    severity: "fail",
    rule: "ruling",
    pass: synthesis.id,
    finding: id,
    comment: synthesized.commentUrl,
    message: `contested finding ${id} needs a ruling in pass ${flow.ruling}`,
  }));
}
