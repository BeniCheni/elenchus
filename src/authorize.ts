import { AppStatusClient } from "./app-status.js";
import { checkHead } from "./gate-review.js";
import type { GhClient } from "./gh.js";
import { loadReview, postingOrder } from "./load.js";
import { buildCheck } from "./report.js";
import type { CheckItem, ReviewState } from "./types.js";

type AuthorizationConfig = { baseRef: string; baseSha: string };

type AuthorizeResult = AuthorizationConfig & ({ ok: false; items: CheckItem[] } | {
  ok: true;
  head: string;
  context: string;
  posted: boolean;
  items: CheckItem[];
});

export async function authorize(
  gh: GhClient,
  repo: string,
  pr: number,
  options: { dryRun?: boolean; keychainService?: string; app?: AppStatusClient } = {},
): Promise<AuthorizeResult> {
  const state = await loadReview(gh, repo, pr);
  const { baseRef, baseSha } = state;
  const config = { baseRef, baseSha };
  const gate = state.config.gate;
  const configErrors = (state.config.unknownKeys ?? []).map((key) => `unknown key ${key}`);
  if (!gate) configErrors.push("config has no gate");
  if (!gate?.required_checks.length) configErrors.push("config.gate.required_checks must list at least one check");
  if (!state.config.finding_flow?.ruling) configErrors.push("config.finding_flow.ruling is required");
  if (!options.dryRun && gate?.app_id === undefined) configErrors.push("authorize requires config.gate.app_id");
  if (!gate || configErrors.length) return {
    ...config,
    ok: false,
    items: configErrors.map((message) => ({ severity: "fail", rule: "config", message })),
  };
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
  if (items.some(({ severity }) => severity !== "notice")) return { ...config, ok: false, items };
  if (!options.dryRun) {
    const app = options.app ?? new AppStatusClient();
    await app.post({
      repo,
      pr,
      context: gate.context,
      appId: gate.app_id!,
      sha: state.head,
      keychainService: options.keychainService ?? "",
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`configuration: base ${baseRef} ${baseSha}\n${message}`);
    });
  }
  return { ...config, ok: true, head: state.head, context: gate.context, posted: !options.dryRun, items };
}

function unresolvedFindings(state: ReviewState): CheckItem[] {
  const flow = state.config.finding_flow;
  const synthesis = state.passes.find(({ id }) => id === flow?.carries.at(-1));
  if (synthesis?.outcome.kind !== "recorded" || !flow?.ruling) return [];
  const ruling = state.passes.find(({ id }) => id === flow.ruling)?.outcome;
  const synthesized = synthesis.outcome.posting;
  const ruled = new Set(ruling?.kind === "recorded" && postingOrder(ruling.posting, synthesized) > 0
    ? ruling.record.findings.filter(({ status }) => status !== "contested").map(({ id }) => id)
    : []);
  return synthesized.record.findings.filter(({ status, id }) => status === "contested" && !ruled.has(id)).map(({ id }) => ({
    severity: "fail",
    rule: "ruling",
    pass: synthesis.id,
    finding: id,
    comment: synthesized.commentUrl,
    message: `contested finding ${id} needs a ruling in pass ${flow.ruling}`,
  }));
}
