import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { kickoffConfig } from "./graph.js";

describe("repository policy configuration", () => {
  it("keeps policy fields optional for commands that do not consume them", () => {
    const raw = kickoffConfig();
    delete raw.gate;
    delete raw.finding_flow;
    delete raw.escalate_to;
    expect(parseConfig(raw)).toEqual(raw);
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
});
