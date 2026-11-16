import { describe, expect, it } from "vitest";
import { formatCheck, formatStatus } from "../src/format.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";
import type { SeatRecord } from "../src/types.js";
import { comment, fenced, graphGh, kickoffConfig } from "./graph.js";

const CLAUDE = "Claude <noreply@anthropic.com>";
const CURSOR = "Cursor <cursoragent@cursor.com>";
const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const C = "3333333333333333333333333333333333333333";

const nodes = {
  [A]: { parents: [] as string[], author: CLAUDE },
  [B]: { parents: [A], author: CLAUDE },
  [C]: { parents: [B], author: CURSOR },
};

function seat(over: Partial<SeatRecord> & Pick<SeatRecord, "pass">): SeatRecord {
  return {
    seat_record: 1,
    pr: 320,
    runtime: "Claude Code",
    model: { requested: "Fable 5.2", observed: "Fable 5.2", source: "transcribed: test" },
    effort: { requested: "Extra", observed: "Extra", source: "transcribed: test" },
    route: { recommended_by: "PM", confirmed_by: null },
    posted_by: "BeniCheni",
    input_sha: A,
    output_sha: A,
    commits: [],
    findings: [],
    verdict: "ok",
    ...over,
  };
}

function world(comments: ReturnType<typeof comment>[], head = A, baseSha = A) {
  const calls: { path: string; paginate?: boolean }[] = [];
  const gh = graphGh({ head, baseSha, comments, nodes, calls });
  return { gh, calls };
}

async function review(comments: ReturnType<typeof comment>[], head = A, baseSha = A) {
  const { gh, calls } = world(comments, head, baseSha);
  const state = await loadReview(gh, "BeniCheni/elenchus", 1, kickoffConfig());
  return { state, calls, status: formatStatus(buildStatus(state)), check: formatCheck(buildCheck(state)) };
}

describe("status and check", () => {
  it("paginates comment reads and ignores a comment with no record at the end", async () => {
    const { calls, status } = await review([
      comment(1, "no record here\n\n```json\n{}\n```\n\nand then more prose", "2026-11-14T00:00:00Z"),
    ]);
    expect(calls.some((call) => call.path.includes("/comments") && call.paginate)).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/pulls/1") && call.paginate)).toBe(false);
    expect(status).toContain("next: 0");
    expect(status).toContain("blocked: no record for pass 0");
  });

  it("T12 rejects a malformed record, the first failed resubmission, and escalates on the second", async () => {
    const bad = "```json\n{\"seat_record\":1,\"pass\":\"0\"}\n```\n";
    const once = await review([comment(1, bad, "2026-11-14T00:00:01Z")]);
    expect(once.status).toContain("back to the seat");
    expect(once.status).not.toContain("escalate to Beni");
    expect(once.check).toMatch(/FAIL retries pass 0/);
    expect(once.check).toMatch(/verdict/);

    const twice = await review([
      comment(1, bad, "2026-11-14T00:00:01Z"),
      comment(2, bad, "2026-11-14T00:00:02Z"),
    ]);
    expect(twice.status).toContain("first resubmission failed; back to the seat");
    expect(twice.status).not.toContain("escalate to Beni");

    const thrice = await review([
      comment(1, bad, "2026-11-14T00:00:01Z"),
      comment(2, bad, "2026-11-14T00:00:02Z"),
      comment(3, bad, "2026-11-14T00:00:03Z"),
    ]);
    expect(thrice.status).toContain("next: escalate to Beni");
    expect(thrice.check).toMatch(/FAIL retries pass 0 .*escalate to Beni/);
  });

  it("says when a record's retries field disagrees with the comments", async () => {
    const bad = "```json\n{\"seat_record\":1,\"pass\":\"0\"}\n```\n";
    const good = seat({ pass: "0", retries: 0 });
    const { check } = await review([
      comment(1, bad, "2026-11-14T00:00:01Z"),
      comment(2, fenced(good), "2026-11-14T00:00:02Z"),
    ]);
    expect(check).toMatch(/FAIL retries pass 0 .*record retries 0 but the comments show 1/);
  });

  it("T13 fails a route mismatch, passes the matching observation, and leaves not reported unverified", async () => {
    const pass0 = seat({ pass: "0" });
    const s2 = (model: SeatRecord["model"]): SeatRecord =>
      seat({
        pass: "1",
        runtime: "claude -p",
        model,
        effort: { requested: null, observed: null, source: "not reported" },
        input_sha: A.slice(0, 7),
        output_sha: A.slice(0, 7),
      });
    const mismatch = await review([
      comment(1, fenced(pass0), "2026-11-14T00:00:01Z"),
      comment(2, fenced(s2({ requested: "haiku", observed: "claude-sonnet-5-5", source: "modelUsage" })), "2026-11-14T00:00:02Z"),
    ]);
    expect(mismatch.check).toMatch(/FAIL route pass 1/);
    expect(mismatch.check).toContain("requested haiku");
    expect(mismatch.check).toContain("observed claude-sonnet-5-5");

    const matched = await review([
      comment(1, fenced(pass0), "2026-11-14T00:00:01Z"),
      comment(2, fenced(s2({ requested: "haiku", observed: "claude-haiku-5-5", source: "modelUsage" })), "2026-11-14T00:00:02Z"),
    ]);
    expect(matched.check).not.toMatch(/FAIL /);
    expect(matched.check).toMatch(/UNVERIFIED route pass 1 .*effort/);

    const unverified = await review([
      comment(1, fenced(pass0), "2026-11-14T00:00:01Z"),
      comment(
        2,
        fenced(s2({ requested: "haiku", observed: null, source: "not reported" })),
        "2026-11-14T00:00:02Z",
      ),
    ]);
    expect(unverified.check).not.toMatch(/FAIL /);
    expect(unverified.check).toMatch(/UNVERIFIED route pass 1 .*model not reported/);
  });

  it("T1 names a skipped pass", async () => {
    const { check } = await review([
      comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({ pass: "1", input_sha: A, output_sha: B, commits: [B] })), "2026-11-14T00:00:02Z"),
      comment(3, fenced(seat({ pass: "2", runtime: "Cursor", input_sha: B, output_sha: C, commits: [C], model: { requested: "grok-4.7-xhigh", observed: "Grok 4.7 Extra High", source: "test" }, effort: { requested: "xhigh", observed: "Extra High", source: "test" } })), "2026-11-14T00:00:03Z"),
    ], C, A);
    expect(check).toMatch(/FAIL sequence pass 2 .*skipped pass 1\.5/);
  });

  it("T3 fails when a Pass 1 finding is missing from Pass 2, and passes once it is restored", async () => {
    const finding = { id: "7", severity: "low", status: "open" as const };
    const common = [
      comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({ pass: "1", findings: [finding], input_sha: A, output_sha: B, commits: [B] })), "2026-11-14T00:00:02Z"),
      comment(3, fenced(seat({ pass: "1.5", input_sha: B, output_sha: B })), "2026-11-14T00:00:03Z"),
    ];
    const broken = await review([
      ...common,
      comment(4, fenced(seat({ pass: "2", runtime: "Cursor", input_sha: B, output_sha: C, commits: [C], findings: [], model: { requested: "grok-4.7-xhigh", observed: "Grok 4.7 256K Extra High", source: "test" }, effort: { requested: "xhigh", observed: "xhigh", source: "test" } })), "2026-11-14T00:00:04Z"),
      comment(5, fenced(seat({ pass: "2.5", input_sha: C, output_sha: C, findings: [finding] })), "2026-11-14T00:00:05Z"),
    ], C, A);
    expect(broken.check).toMatch(/FAIL finding-carry pass 2 finding 7 .*finding 7 opened in pass 1 is missing/);

    const restored = await review([
      ...common,
      comment(4, fenced(seat({ pass: "2", runtime: "Cursor", input_sha: B, output_sha: C, commits: [C], findings: [{ ...finding, status: "fixed" }], model: { requested: "grok-4.7-xhigh", observed: "Grok 4.7 256K Extra High", source: "test" }, effort: { requested: "xhigh", observed: "xhigh", source: "test" } })), "2026-11-14T00:00:04Z"),
      comment(5, fenced(seat({ pass: "2.5", input_sha: C, output_sha: C, findings: [finding] })), "2026-11-14T00:00:05Z"),
    ], C, A);
    expect(restored.check).not.toMatch(/FAIL /);
  });

  it("reads commits after a recorded pass as that pass in progress", async () => {
    const { status } = await review([
      comment(1, fenced(seat({ pass: "0", output_sha: A.slice(0, 7) })), "2026-11-14T00:00:01Z"),
    ], B, A);
    expect(status).toContain("pass 1: in progress, cold review, seat reviewer");
    expect(status).toContain("options: wait, or re-route");
    expect(status).toContain("next: 1");
  });

  it("fails a commit whose author is not the seat's vendor", async () => {
    const { check } = await review([
      comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({ pass: "1", input_sha: A, output_sha: C, commits: [B, C] })), "2026-11-14T00:00:02Z"),
    ], C, A);
    expect(check).toMatch(/FAIL authors pass 1 .*not vendor claude/);
  });

  it("drops commits reachable from the base branch before the author check", async () => {
    const { check } = await review([
      comment(1, fenced(seat({ pass: "0", output_sha: A })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({
        pass: "1",
        runtime: "Cursor",
        input_sha: A,
        output_sha: C,
        commits: [C],
        model: { requested: "grok-4.7-xhigh", observed: "Grok 4.7 Extra High", source: "test" },
        effort: { requested: "xhigh", observed: "Extra High", source: "test" },
      })), "2026-11-14T00:00:02Z"),
    ], C, B);
    expect(check).not.toMatch(/FAIL /);
  });
});
