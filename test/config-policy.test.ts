import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { formatCheck, formatStatus } from "../src/format.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";
import { graphGh, kickoffConfig } from "./graph.js";

describe("repository policy configuration", () => {
  it("keeps policy fields optional for commands that do not consume them", () => {
    const raw = kickoffConfig();
    delete raw.gate;
    delete raw.finding_flow;
    delete raw.escalate_to;
    expect(parseConfig(raw)).toEqual(raw);
  });

  it("rejects a missing config.finding_flow.carries and parses an empty list", () => {
    const config = kickoffConfig();
    const { carries: _carries, ...withoutCarries } = config.finding_flow!;
    expect(() => parseConfig({ ...config, finding_flow: withoutCarries }))
      .toThrow("config.finding_flow.carries must be a list of strings");
    expect(parseConfig({ ...config, finding_flow: { ...withoutCarries, carries: [] } }).finding_flow?.carries).toEqual([]);
  });

  it.each([
    { passes: [{ id: "", role: "r", seat: "s" }] },
    { passes: [{ id: "same", role: "r", seat: "s" }, { id: "same", role: "r", seat: "s" }] },
    { escalate_to: "" },
    { gate: [] },
    { gate: { ...kickoffConfig().gate, context: "" } },
    { gate: { ...kickoffConfig().gate, app_id: 0 } },
    { gate: { ...kickoffConfig().gate, app_id: 1.5 } },
    { gate: { ...kickoffConfig().gate, required_checks: "verify" } },
    { gate: { ...kickoffConfig().gate, required_checks: [{ name: "verify", app_id: -1 }] } },
    { gate: { ...kickoffConfig().gate, required_checks: [{ app_id: 1 }] } },
    { gate: { ...kickoffConfig().gate, blocking_unverified: ["unknown"] } },
    { gate: { ...kickoffConfig().gate, allowed_changes: { paths: [], reread_pass: "unconfigured" } } },
    { gate: { ...kickoffConfig().gate, allowed_changes: { paths: [], reread_pass: "2.5", version_only: {} } } },
    { finding_flow: { opens: "unconfigured", carries: [] } },
    { finding_flow: { opens: "1", carries: ["2.5", "2"] } },
    { finding_flow: { opens: "1", carries: ["1"] } },
    { finding_flow: { opens: "1", carries: ["2"], ruling: "0" } },
    { finding_flow: { opens: "1", carries: ["2"], ruling: "unconfigured" } },
  ])("rejects an invalid policy field %#", (change) => {
    const config = kickoffConfig();
    if ("passes" in change) {
      delete config.gate;
      delete config.finding_flow;
    }
    expect(() => parseConfig({ ...config, ...change })).toThrow(/config\./);
  });

  it("rejects a malformed version pattern when loading configuration", () => {
    const config = kickoffConfig();
    config.gate!.allowed_changes!.version_only!.pattern = "[";
    expect(() => parseConfig(config)).toThrow("config.gate.allowed_changes.version_only.pattern must be a regular expression");
  });

  it("reports unknown keys at each config level and leaves status and check usable", async () => {
    const raw = kickoffConfig();
    const fields = {
      "config": raw,
      "config.passes[0]": raw.passes[0],
      "config.vendors.codex": raw.vendors.codex,
      "config.installs[0]": raw.installs![0],
      "config.handoff": raw.handoff,
      "config.finding_flow": raw.finding_flow,
      "config.gate": raw.gate,
      "config.gate.required_checks[0]": raw.gate!.required_checks[0],
      "config.gate.allowed_changes": raw.gate!.allowed_changes,
      "config.gate.allowed_changes.version_only": raw.gate!.allowed_changes!.version_only,
    };
    for (const entry of Object.values(fields)) Object.assign(entry!, { typo: true });
    const sha = "a".repeat(40);
    const gh = graphGh({ head: sha, baseSha: sha, nodes: { [sha]: { parents: [], author: "Test" } }, comments: [] });
    const state = await loadReview(gh, "BeniCheni/elenchus", 1, parseConfig(raw));
    const status = formatStatus(buildStatus(state));
    const check = formatCheck(buildCheck(state));
    for (const path of Object.keys(fields)) {
      expect(status).toContain(`NOTICE config unknown key ${path}.typo`);
      expect(check).toContain(`NOTICE config unknown key ${path}.typo`);
    }
    expect(check).not.toMatch(/^FAIL /m);
  });
});
