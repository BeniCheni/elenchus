import { describe, expect, it } from "vitest";
import { validateSeatRecord } from "../src/schema.js";

const v1 = {
  seat_record: 1,
  pr: 320,
  pass: "2",
  runtime: "cursor agent -p",
  model: { requested: "grok-4.7-xhigh", observed: "Grok 4.7 256K Extra High" },
  effort: { requested: "xhigh", observed: "xhigh" },
  route: { recommended_by: "Planner", confirmed_by: "Beni" },
  input_sha: "89b8067",
  output_sha: "09324fb",
  commits: ["0c7bdd8", "09324fb"],
  findings: [{ id: "F6", severity: "low", status: "contested" }],
  verdict: "mergeable after fixes",
};

describe("seat record schema v1.1", () => {
  it("accepts a v1 record that omits every v1.1 field", () => {
    expect(validateSeatRecord(v1).ok).toBe(true);
  });

  it("accepts the v1.1 additions", () => {
    const result = validateSeatRecord({
      ...v1,
      runtime_version: "2026.11.13-eacade1",
      session: { id: "abc", log: "stream-json init" },
      mode: { requested: "write", observed: null, source: "not reported" },
      posted_by: "BeniCheni",
      route: { ...v1.route, by_hand: false },
      findings: [{ ...v1.findings[0], disposition: "accept", path: "src/a.ts", start_line: 1, end_line: 2, category: "layout", evidence: "probe" }],
      coverage: { total: 1, reviewed: 1, skipped: [] },
      not_verified: ["a phone"],
      retries: 0,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a record the schema does not describe", () => {
    expect(validateSeatRecord({ ...v1, verdict: undefined }).ok).toBe(false);
    const missing = validateSeatRecord({ ...v1, pass: "reread" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/pass/);
    const extra = validateSeatRecord({ ...v1, rulings: [] });
    expect(extra.ok).toBe(false);
  });

  it("accepts only the finding status enum", () => {
    const finding = { id: "7", severity: "low", status: "killed" };
    expect(validateSeatRecord({ ...v1, findings: [finding] }).ok).toBe(true);
    expect(validateSeatRecord({ ...v1, findings: [{ ...finding, status: "nope" }] }).ok).toBe(false);
  });

  it("accepts only a SHA of 7 to 40 hex digits", () => {
    expect(validateSeatRecord({ ...v1, input_sha: "zzzzzzz" }).ok).toBe(false);
    expect(validateSeatRecord({ ...v1, input_sha: "abc123" }).ok).toBe(false);
    expect(validateSeatRecord({ ...v1, input_sha: "abc1234" }).ok).toBe(true);
  });
});

describe("seat record schema v1.2", () => {
  const record = {
    ...v1,
    findings: [{ ...v1.findings[0], severity: "note" }],
    schema_version: "1.2",
    input_sha: "a".repeat(40),
    output_sha: "c".repeat(40),
    commits: ["b".repeat(40), "c".repeat(40)],
    pass: "independent synthesis",
    reread: true,
    next_route: {
      runtime: "Codex", model: "gpt-6.1-sol", effort: "xhigh", recommended_by: "lead", confirmed_by: "maintainer",
    },
    model: { requested: "model", observed: null, source: "not reported" },
    effort: { requested: "high", observed: null, source: "not reported" },
    coverage: { total: 1, reviewed: 1, skipped: [], reviewed_paths: ["src/a.ts"] },
  };

  it("accepts repository-defined passes, a re-read, a handoff route and named paths", () => {
    expect(validateSeatRecord(record).ok).toBe(true);
  });

  it.each(["Blocking", "BLOCKING", "blocker", " blocking", "blocking (raised at Pass 3)"])(
    "rejects unrecognised finding severity %j (A10 to A14)",
    (severity) => {
      expect(validateSeatRecord({ ...record, findings: [{ ...record.findings[0], severity }] })).toMatchObject({
        ok: false, reason: expect.stringContaining("/findings/0/severity"),
      });
    },
  );

  it.each([
    { schema_version: "1.3" },
    { input_sha: "abc1234" },
    { output_sha: "abc1234" },
    { commits: ["abc1234"] },
    { pass: "" },
    { reread: false },
    { extra: true },
    { next_route: { ...record.next_route, extra: true } },
    { next_route: { ...record.next_route, confirmed_by: undefined } },
    { coverage: { ...record.coverage, extra: true } },
    { coverage: { ...record.coverage, reviewed_paths: ["src/a.ts", "src/a.ts"] } },
  ])("rejects an invalid or unknown field: %j", (change) => {
    expect(validateSeatRecord({ ...record, ...change }).ok).toBe(false);
  });

  it.each(["model", "effort"] as const)("validates the requested and observed %s independently", (field) => {
    expect(validateSeatRecord({ ...record, [field]: { ...record[field], requested: null } }).ok).toBe(false);
    expect(validateSeatRecord({ ...record, [field]: { ...record[field], source: undefined } }).ok).toBe(false);
    expect(validateSeatRecord({ ...record, [field]: { ...record[field], source: "" } }).ok).toBe(false);
    expect(validateSeatRecord({ ...record, [field]: { requested: "high", observed: "high" } }).ok).toBe(true);
  });
});

describe("v1.2 closed object boundaries", () => {
  const complete = {
    ...v1,
    findings: [{ ...v1.findings[0], severity: "note" }],
    schema_version: "1.2",
    input_sha: "a".repeat(40),
    output_sha: "c".repeat(40),
    commits: ["b".repeat(40), "c".repeat(40)],
    session: { id: "session", log: "metadata" },
    mode: { requested: null, observed: null },
    next_route: { runtime: "Codex", model: "gpt-6.1-sol", effort: "xhigh", recommended_by: null, confirmed_by: null },
    coverage: { total: 2, reviewed: 1, reviewed_paths: ["a"], skipped: [{ path: "b", reason: "deleted" }] },
  };
  it.each([
    [],
    ["session"],
    ["model"],
    ["effort"],
    ["mode"],
    ["route"],
    ["next_route"],
    ["coverage"],
    ["coverage", "skipped", "0"],
    ["findings", "0"],
  ])("rejects an extra property at %j", (...path) => {
    const copy = structuredClone(complete);
    let object = copy as unknown as Record<string, unknown>;
    for (const part of path) object = object[part] as Record<string, unknown>;
    object.unlisted = true;
    expect(validateSeatRecord(copy).ok).toBe(false);
  });
});
