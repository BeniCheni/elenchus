import { describe, expect, it } from "vitest";
import { formatCheck, formatStatus } from "../src/format.js";
import type { GhClient } from "../src/gh.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";
import { sameSha } from "../src/sha.js";
import type { GhCompare, SeatRecord } from "../src/types.js";
import { comment, fenced, graphGh, kickoffConfig, type Node } from "./graph.js";

const CLAUDE = "Claude <noreply@anthropic.com>";
const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const C = "3333333333333333333333333333333333333333";

const chain: Record<string, Node> = {
  [A]: { parents: [], author: CLAUDE },
  [B]: { parents: [A], author: CLAUDE },
  [C]: { parents: [B], author: CLAUDE },
};

function seat(over: Partial<SeatRecord> & Pick<SeatRecord, "pass">): SeatRecord {
  return {
    seat_record: 1,
    pr: 320,
    runtime: "Claude Code",
    model: { requested: "claude-fable-5-2", observed: "claude-fable-5-2", source: "test" },
    effort: { requested: "xhigh", observed: "xhigh", source: "test" },
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

async function report(comments: ReturnType<typeof comment>[], head = A, baseSha = A, gh?: GhClient) {
  const state = await loadReview(
    gh ?? graphGh({ head, baseSha, comments, nodes: chain }),
    "BeniCheni/elenchus",
    1,
    kickoffConfig(),
  );
  return { status: formatStatus(buildStatus(state)), check: formatCheck(buildCheck(state)) };
}

const finding = { id: "7", severity: "low", status: "open" as const };
const killed = { id: "7", severity: "low", status: "killed" as const };

describe("failing cases for rules the suite used to miss", () => {
  it("fails when a writing pass's input_sha is not the previous pass's output_sha", async () => {
    const { check } = await report([
      comment(1, fenced(seat({ pass: "0", input_sha: A, output_sha: B, commits: [B] })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({ pass: "1", input_sha: A, output_sha: C, commits: [B, C] })), "2026-11-14T00:00:02Z"),
    ], C, A);
    expect(check).toMatch(/FAIL sha-chain pass 1 .*input_sha .* is not the previous pass 0's output_sha/);
  });

  it("fails when output_sha is not an ancestor of the head", async () => {
    const { check } = await report([
      comment(1, fenced(seat({ pass: "0", input_sha: C, output_sha: C })), "2026-11-14T00:00:01Z"),
    ], B, A);
    expect(check).toMatch(/FAIL sha-chain pass 0 .*output_sha .* is not an ancestor of or equal to head/);
  });

  it("fails when input_sha is not an ancestor of output_sha", async () => {
    const { check } = await report([
      comment(1, fenced(seat({ pass: "0", input_sha: C, output_sha: A, commits: [] })), "2026-11-14T00:00:01Z"),
    ], A, A);
    expect(check).toMatch(/FAIL commits pass 0 .*input_sha .* is not an ancestor of output_sha/);
  });

  it("fails when the recorded commits are not the range minus the base", async () => {
    const { check } = await report([
      comment(1, fenced(seat({ pass: "0", input_sha: A, output_sha: C, commits: [B] })), "2026-11-14T00:00:01Z"),
    ], C, A);
    expect(check).toMatch(/FAIL commits pass 0 .*do not equal/);
  });

  it("fails when a compare is truncated", async () => {
    const comments = [comment(1, fenced(seat({ pass: "0", input_sha: A, output_sha: C, commits: [B, C] })), "2026-11-14T00:00:01Z")];
    const inner = graphGh({ head: C, baseSha: A, comments, nodes: chain });
    const gh: GhClient = {
      async get(path, options) {
        const value = await inner.get(path, options);
        if (!path.includes("/compare/")) return value;
        const compare = value as GhCompare;
        return { ...compare, total_commits: (compare.total_commits ?? 0) + 1 };
      },
    };
    const { check } = await report(comments, C, A, gh);
    expect(check).toMatch(/FAIL commits pass 0 .*truncated/);
  });

  it("fails when pass 2.5 drops a finding pass 1 opened", async () => {
    const pass2 = seat({ pass: "2", input_sha: B, output_sha: C, commits: [C], findings: [finding] });
    const common = [
      comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({ pass: "1", input_sha: A, output_sha: B, commits: [B], findings: [finding] })), "2026-11-14T00:00:02Z"),
      comment(3, fenced(seat({ pass: "1.5", input_sha: B, output_sha: B })), "2026-11-14T00:00:03Z"),
      comment(4, fenced(pass2), "2026-11-14T00:00:04Z"),
    ];
    const dropped = await report([
      ...common,
      comment(5, fenced(seat({ pass: "2.5", input_sha: C, output_sha: C, findings: [] })), "2026-11-14T00:00:05Z"),
    ], C, A);
    expect(dropped.check).toMatch(/FAIL finding-carry pass 2\.5 finding 7 .*missing/);
    const carried = await report([
      ...common,
      comment(5, fenced(seat({ pass: "2.5", input_sha: C, output_sha: C, findings: [finding] })), "2026-11-14T00:00:05Z"),
    ], C, A);
    expect(carried.check).not.toMatch(/FAIL finding-carry/);
  });

  it("fails when one record reuses a finding id", async () => {
    const { check } = await report([
      comment(1, fenced(seat({ pass: "0", findings: [finding, { ...finding, status: "fixed" }] })), "2026-11-14T00:00:01Z"),
    ]);
    expect(check).toMatch(/FAIL finding-carry pass 0 finding 7 .*reused/);
  });

  it("passes when a killed finding is carried and fails when it is dropped", async () => {
    const pass1 = seat({ pass: "1", input_sha: A, output_sha: B, commits: [B], findings: [killed] });
    const carried = seat({ pass: "2", input_sha: B, output_sha: C, commits: [C], findings: [killed] });
    const kept = await report([
      comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(pass1), "2026-11-14T00:00:02Z"),
      comment(3, fenced(seat({ pass: "1.5", input_sha: B, output_sha: B })), "2026-11-14T00:00:03Z"),
      comment(4, fenced(carried), "2026-11-14T00:00:04Z"),
    ], C, A);
    expect(kept.check).not.toMatch(/FAIL finding-carry/);
    const dropped = await report([
      comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(pass1), "2026-11-14T00:00:02Z"),
      comment(3, fenced(seat({ pass: "1.5", input_sha: B, output_sha: B })), "2026-11-14T00:00:03Z"),
      comment(4, fenced({ ...carried, findings: [] }), "2026-11-14T00:00:04Z"),
    ], C, A);
    expect(dropped.check).toMatch(/FAIL finding-carry pass 2 finding 7 .*missing/);
  });

  it("fails an unconfigured runtime", async () => {
    const { check } = await report([
      comment(1, fenced(seat({ pass: "0", runtime: "Emacs", input_sha: A, output_sha: B, commits: [B] })), "2026-11-14T00:00:01Z"),
    ], B, A);
    expect(check).toMatch(/FAIL authors pass 0 .*runtime Emacs is not a configured vendor/);
  });

  it("does not call a pass in progress unless the head is ahead of the previous output", async () => {
    const { status } = await report([
      comment(1, fenced(seat({ pass: "0", output_sha: C })), "2026-11-14T00:00:01Z"),
    ], A, A);
    expect(status).not.toContain("in progress");
    expect(status).toContain("blocked: no record for pass 1");
  });

  it("treats a prefix shorter than 7 digits as a different SHA", () => {
    const full = `1234567${"a".repeat(33)}`;
    expect(sameSha("1234567", full)).toBe(true);
    expect(sameSha("123456", `123456${"a".repeat(34)}`)).toBe(false);
  });
});
