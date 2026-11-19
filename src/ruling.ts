import { postingOrder } from "./load.js";
import type { CheckItem, PassState, ReviewState } from "./types.js";

export function checkRuling(state: ReviewState): {
  pass: PassState;
  schema: CheckItem[];
  findings: CheckItem[];
} | undefined {
  const flow = state.config.finding_flow;
  const synthesis = state.passes.find(({ id }) => id === flow?.carries.at(-1))?.outcome;
  const pass = state.passes.find(({ id }) => id === flow?.ruling);
  if (synthesis?.kind !== "recorded" || !pass) return undefined;

  const ruling = pass.outcome;
  const decisions = ruling.kind === "recorded" && postingOrder(ruling.posting, synthesis.posting) > 0 ? ruling : undefined;
  const schema: CheckItem[] = [];
  const findings: CheckItem[] = [];
  for (const outcome of [synthesis, decisions]) {
    if (outcome && outcome.record.schema_version !== "1.2") {
      schema.push({
        severity: "fail", rule: "schema", pass: outcome.record.pass, comment: outcome.commentUrl,
        message: "authorize requires a schema v1.2 record",
      });
    }
  }
  if (!decisions) {
    findings.push({
      severity: "fail", rule: "ruling", pass: pass.id,
      message: ruling.kind === "recorded"
        ? `ruling ${ruling.commentUrl} precedes the standing synthesis ${synthesis.commentUrl}`
        : `no valid ruling follows the standing synthesis ${synthesis.commentUrl}`,
    });
  }

  const originals = new Map(synthesis.record.findings.map((finding) => [finding.id, finding]));
  const answers = new Map(decisions?.record.findings.map((finding) => [finding.id, finding]));
  for (const id of new Set([...originals.keys(), ...answers.keys()])) {
    const original = originals.get(id);
    const answer = answers.get(id);
    const outcome = answer ? decisions! : synthesis;
    const status = (answer ?? original!).status;
    // Legacy records still report contested status, but only v1.2 defines blocking severity.
    const blocking = (synthesis.record.schema_version === "1.2" && original?.severity === "blocking")
      || (decisions?.record.schema_version === "1.2" && answer?.severity === "blocking");
    const location = { severity: "fail" as const, rule: "ruling", pass: outcome.record.pass, finding: id, comment: outcome.commentUrl };
    if (blocking && status !== "fixed" && status !== "killed") {
      findings.push({ ...location, message: `blocking finding ${id} must be fixed or killed (status: ${status})` });
    } else if (status === "contested") {
      findings.push({ ...location, message: `contested finding ${id} needs a ruling in pass ${pass.id}` });
    }
  }
  return { pass, schema, findings };
}
