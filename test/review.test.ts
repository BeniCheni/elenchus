import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { formatCheck, formatStatus } from "../src/format.js";
import type { GhClient } from "../src/gh.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";
import type { SeatRecord } from "../src/types.js";
import { extractRecord } from "../src/records.js";
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
    pr: 1,
    runtime: "Claude Code",
    model: { requested: "claude-fable-5-2", observed: "claude-fable-5-2", source: "transcribed: test" },
    effort: { requested: "xhigh", observed: "xhigh", source: "transcribed: test" },
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
    expect(twice.status).toContain("record rejected after 2 failed attempt(s); back to the seat");
    expect(twice.status).not.toContain("escalate to Beni");

    const thrice = await review([
      comment(1, bad, "2026-11-14T00:00:01Z"),
      comment(2, bad, "2026-11-14T00:00:02Z"),
      comment(3, bad, "2026-11-14T00:00:03Z"),
    ]);
    expect(thrice.status).toContain("next: escalate to Beni");
    expect(thrice.check).toMatch(/FAIL retries pass 0 .*escalate to Beni/);
  });

  it("reads comments in creation order when the array is not", async () => {
    const { status } = await review([
      comment(2, fenced(seat({ pass: "0", verdict: "later" })), "2026-11-14T00:00:02Z"),
      comment(1, fenced(seat({ pass: "0", verdict: "earlier" })), "2026-11-14T00:00:01Z"),
    ]);
    expect(status).toContain("pass 0: recorded");
    expect(status).toContain("issuecomment-2");
    expect(status).not.toContain("issuecomment-1");
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

  it.each([
    ["2", "Codex", "gpt-6.2-astra", "xhigh", true],
    ["3", "Grok", "grok-4.7", "medium", true],
    ["3", "Grok", "grok-4.7", "high", false],
  ] as const)("checks pass %s on %s, %s at %s", async (pass, runtime, model, effort, allowed) => {
    const record = seat({
      pass, runtime, schema_version: "1.2",
      model: { requested: model, observed: model }, effort: { requested: effort, observed: effort },
    });
    const { state } = await review([comment(1, fenced(record), "2026-11-14T00:00:01Z")]);
    expect(state.passes.find(({ id }) => id === pass)?.outcome).toMatchObject({ kind: "recorded", record });
    const routes = buildCheck(state).filter(({ rule }) => rule === "route");
    expect(routes).toEqual(allowed ? [] : [expect.objectContaining({
      severity: "fail", pass, message: "effort requested high observed high",
    })]);
  });

  it("configures the chat-only Grok runtime with no commit authors or prepared seat", () => {
    expect(kickoffConfig().vendors.xai).toEqual({
      authors: [], runtimes: ["Grok"], models: { "grok-4.7": ["grok-4.7"] },
      efforts: { medium: ["medium"] }, read_only_seat: false,
    });
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
      comment(3, fenced(seat({ pass: "2", runtime: "Cursor", input_sha: B, output_sha: C, commits: [C], model: { requested: "grok-4.7-xhigh", observed: "Grok 4.7 256K Extra High", source: "test" }, effort: { requested: "xhigh", observed: "Extra High", source: "test" } })), "2026-11-14T00:00:03Z"),
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

  it("uses the base branch tip when the pull request still names an older base SHA", async () => {
    const calls: { path: string; paginate?: boolean }[] = [];
    const gh = graphGh({
      head: C,
      baseSha: A,
      branchTip: B,
      comments: [
        comment(1, fenced(seat({ pass: "0", output_sha: A })), "2026-11-14T00:00:01Z"),
        comment(2, fenced(seat({
          pass: "1",
          runtime: "Cursor",
          input_sha: A,
          output_sha: C,
          commits: [C],
          model: { requested: "grok-4.7-xhigh", observed: "Grok 4.7 256K Extra High", source: "test" },
          effort: { requested: "xhigh", observed: "Extra High", source: "test" },
        })), "2026-11-14T00:00:02Z"),
      ],
      nodes,
      calls,
    });
    const state = await loadReview(gh, "BeniCheni/elenchus", 1, kickoffConfig());
    const check = formatCheck(buildCheck(state));
    expect(state.baseSha).toBe(B);
    expect(check).not.toMatch(/FAIL /);
    expect(calls.some((call) => call.path.endsWith("/commits/heads%2Freplay%2Fmain"))).toBe(true);
    expect(calls.filter((call) => call.path.includes("/compare/") && call.paginate)).toEqual([
      { path: `/repos/BeniCheni/elenchus/compare/${B}...${C}?per_page=100`, paginate: true },
    ]);
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
        model: { requested: "grok-4.7-xhigh", observed: "Grok 4.7 256K Extra High", source: "test" },
        effort: { requested: "xhigh", observed: "Extra High", source: "test" },
      })), "2026-11-14T00:00:02Z"),
    ], C, B);
    expect(check).not.toMatch(/FAIL /);
  });
});

describe("record extraction", () => {
  const url = "https://github.com/BeniCheni/elenchus/pull/1#issuecomment-";

  it("reads the last json block when an earlier one is only an excerpt", async () => {
    const record = seat({ pass: "0" });
    const body = `An excerpt.\n\n\`\`\`json\n{"note":true}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
    expect(extractRecord(body)).toBe(JSON.stringify(record, null, 2));
    const { status, check } = await review([comment(1, body, "2026-11-14T00:00:01Z")]);
    expect(status).toContain("pass 0: recorded");
    expect(check).toContain(`NOTICE extraction ${url}1 json fence was not read as a record`);
    expect(check).not.toMatch(/FAIL /);
  });

  it("does not read a json block that is followed by another kind of fence", async () => {
    const body = "```json\n{\"pass\":\"0\"}\n```\n\n```text\nstill talking\n```\n";
    expect(extractRecord(body)).toBeNull();
    const { status, check } = await review([comment(2, body, "2026-11-14T00:00:01Z")]);
    expect(status).toContain("blocked: no record for pass 0");
    expect(status).not.toContain("rejected");
    expect(check).toContain(`NOTICE extraction ${url}2 json fence was not read as a record`);
    expect(check).not.toMatch(/FAIL /);
  });

  it("accepts a record written with CRLF line endings", async () => {
    const record = seat({ pass: "0" });
    const body = `\`\`\`json\r\n${JSON.stringify(record, null, 2)}\r\n\`\`\`\r\n`;
    expect(extractRecord(body)).toBe(JSON.stringify(record, null, 2));
    const { status, check } = await review([comment(3, body, "2026-11-14T00:00:01Z")]);
    expect(status).toContain("pass 0: recorded");
    expect(check).not.toMatch(/NOTICE /);
    expect(check).not.toMatch(/FAIL /);
  });

  it.each([
    ["an upper-case tag", "```JSON\n{\"pass\":\"0\"}\n```\n"],
    ["a space after the backticks", "``` json\n{\"pass\":\"0\"}\n```\n"],
    ["four backticks", "````json\n{\"pass\":\"0\"}\n````\n"],
    ["an indented fence", "    ```json\n{\"pass\":\"0\"}\n    ```\n"],
    ["a quoted fence", "> ```json\n> {\"pass\":\"0\"}\n> ```\n"],
  ])("prints one notice for %s and does not change the result", async (label, body) => {
    expect(extractRecord(body), label).toBeNull();
    const { status, check } = await review([comment(4, body, "2026-11-14T00:00:01Z")]);
    expect(status).toContain("blocked: no record for pass 0");
    expect(status).not.toContain("rejected");
    expect(check.match(/NOTICE extraction /g)?.length).toBe(1);
    expect(check).toContain(`${url}4`);
    expect(check).not.toMatch(/FAIL /);
  });
});

describe("attribution", () => {
  const url = (id: number) => `https://github.com/BeniCheni/elenchus/pull/1#issuecomment-${id}`;

  function prefix(through: string) {
    const ids = ["0", "1", "1.5", "2", "2.5", "3", "exec"];
    const stop = ids.indexOf(through);
    return ids.slice(0, stop + 1).map((id, index) =>
      comment(index + 1, fenced(seat({ pass: id })), `2026-11-14T00:00:${String(index + 1).padStart(2, "0")}Z`),
    );
  }

  it("keeps a valid record when a later comment ends with a partial pass excerpt", async () => {
    const excerpt = "```json\n{ \"pass\": \"1\", \"findings\": [ { \"id\": \"3\" } ] }\n```\n";
    const { status, check } = await review([
      ...prefix("1"),
      comment(9, `Discussion.\n\n${excerpt}`, "2026-11-14T00:00:09Z"),
    ]);
    expect(status).toContain("pass 1: recorded");
    expect(status).not.toContain("pass 1: rejected");
    expect(status).not.toContain("back to the seat");
    expect(check).toContain(`FAIL schema pass 1 ${url(9)}`);
    expect(check).not.toMatch(/skipped pass 1/);
  });

  it("treats a status receipt pasted at the end of a later comment as a notice", async () => {
    const receipt = {
      repo: "BeniCheni/elenchus",
      pr: 1,
      passes: [{ pass: "0", state: "recorded" }],
      next: { step: "authorize" },
    };
    const body = `Receipt.\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`;
    const { status, check } = await review([
      ...prefix("exec"),
      comment(20, body, "2026-11-14T00:01:00Z"),
    ]);
    expect(status).toContain("pass 0: recorded");
    expect(status).toContain("next: 2.5");
    expect(status).toContain("blocked: authorize requires a schema v1.2 record");
    expect(status).not.toContain("rejected");
    expect(check).toContain(`NOTICE extraction ${url(20)} json block is not a seat record`);
    expect(check).not.toMatch(/FAIL /);
  });

  it("reads a numeric pass as that pass, then accepts a later record whose retries count includes it", async () => {
    const numeric = { ...seat({ pass: "2" }), pass: 2 };
    const { status, check } = await review([
      ...prefix("1.5"),
      comment(8, fenced(numeric), "2026-11-14T00:00:08Z"),
      comment(9, fenced(seat({ pass: "2", retries: 1 })), "2026-11-14T00:00:09Z"),
    ]);
    expect(status).toContain("pass 2: recorded");
    expect(status).not.toContain("pass 2: rejected");
    expect(check).not.toMatch(/FAIL /);
    expect(check).not.toMatch(/record retries 1 but the comments show 0/);
  });

  it("lists an unreadable pass and counts it against the first pass that had no record", async () => {
    const missing = { ...seat({ pass: "0" }) } as { pass?: string };
    delete missing.pass;
    const { status, check } = await review([comment(4, fenced(missing), "2026-11-14T00:00:04Z")]);
    expect(status).toContain("pass 0: rejected");
    expect(status).toContain(`unreadable pass: ${url(4)}`);
    expect(check).toContain(`FAIL retries pass 0 ${url(4)}`);
  });

  it("only lists an unreadable pass once every pass already has a valid record", async () => {
    const stray = { ...seat({ pass: "0" }), pass: "nope" };
    const { status, check } = await review([
      ...prefix("exec"),
      comment(30, fenced(stray), "2026-11-14T00:02:00Z"),
    ]);
    expect(status).toContain("pass exec: recorded");
    expect(status).toContain("next: 2.5");
    expect(status).toContain("blocked: authorize requires a schema v1.2 record");
    expect(status).toContain(`unreadable pass: ${url(30)}`);
    expect(check).toContain(`FAIL schema ${url(30)}`);
    expect(check).not.toMatch(/FAIL sequence/);
    expect(check).not.toMatch(/FAIL retries/);
  });
});

describe("record authors", () => {
  const url = (id: number) => `https://github.com/BeniCheni/elenchus/pull/1#issuecomment-${id}`;

  function recorded(through: string) {
    const ids = ["0", "1", "1.5", "2", "2.5", "3", "exec"];
    const stop = ids.indexOf(through);
    return ids.slice(0, stop + 1).map((id, index) =>
      comment(index + 1, fenced(seat({ pass: id })), `2026-11-14T00:00:${String(index + 1).padStart(2, "0")}Z`),
    );
  }

  it("rejects a configuration that omits record_authors", () => {
    const file = new URL("../examples/kickoff.elenchus.json", import.meta.url);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete raw.record_authors;
    expect(() => parseConfig(raw)).toThrow(/record_authors/);
  });

  it("ignores another account's valid exec record", async () => {
    const { status, check } = await review([
      ...recorded("3"),
      comment(12, fenced(seat({ pass: "exec", posted_by: "BeniCheni" })), "2026-11-14T00:00:12Z", "mallory"),
    ]);
    expect(status).toContain("pass exec: not recorded");
    expect(status).toContain("next: 2.5");
    expect(status).toContain("blocked: authorize requires a schema v1.2 record");
    expect(check).toContain(`NOTICE record_authors ${url(12)} comment by mallory ignored for records`);
    expect(check).not.toMatch(/FAIL /);
  });

  it("does not escalate when another account posts three malformed blocks", async () => {
    const bad = "```json\n{\"seat_record\":1,\"pass\":\"1\"}\n```\n";
    const { status, check } = await review([
      ...recorded("exec"),
      comment(21, bad, "2026-11-14T00:00:21Z", "mallory"),
      comment(22, bad, "2026-11-14T00:00:22Z", "mallory"),
      comment(23, bad, "2026-11-14T00:00:23Z", "mallory"),
    ]);
    expect(status).toContain("next: 2.5");
    expect(status).toContain("blocked: authorize requires a schema v1.2 record");
    expect(status).not.toContain("escalate to Beni");
    expect(check.match(/NOTICE record_authors /g)?.length).toBe(3);
    expect(check).not.toMatch(/FAIL /);
  });

  it("fails posted_by when it differs from the comment author", async () => {
    const { status, check } = await review([
      comment(1, fenced(seat({ pass: "0", posted_by: "mallory" })), "2026-11-14T00:00:01Z"),
    ]);
    expect(status).toContain("pass 0: recorded");
    expect(check).toContain(`FAIL posted_by pass 0 ${url(1)} posted_by mallory is not BeniCheni`);
  });
});

describe("unresolvable SHAs", () => {
  async function unresolved(message: string) {
    const comments = [comment(1, fenced(seat({ pass: "0", input_sha: A, output_sha: "09324fc" })), "2026-11-14T00:00:01Z")];
    const inner = graphGh({ head: A, baseSha: A, comments, nodes });
    const state = await loadReview(
      {
        async get(path, options) {
          if (path.includes("/compare/")) throw new Error(message);
          return inner.get(path, options);
        },
      },
      "BeniCheni/elenchus",
      1,
      kickoffConfig(),
    );
    return { status: formatStatus(buildStatus(state)), check: formatCheck(buildCheck(state)) };
  }

  it("reports a mistyped SHA and still prints every pass", async () => {
    const { status, check } = await unresolved("gh: Not Found (HTTP 404)");
    expect(status).toContain("pass 0: recorded");
    expect(status).toContain("pass exec: not recorded");
    expect(check).toMatch(/FAIL sha-chain pass 0 .* cannot resolve /);
  });

  it("reports an unrelated history and still prints every pass", async () => {
    const { status, check } = await unresolved("No common ancestor");
    expect(status).toContain("pass 0: recorded");
    expect(status).toContain("pass 1: not recorded");
    expect(check).toMatch(/FAIL sha-chain pass 0 .* cannot resolve /);
  });
});

describe("v1.2 passes and re-reads", () => {
  const config = kickoffConfig();
  config.passes = [
    { id: "cold", role: "cold", seat: "reviewer" },
    { id: "finish", role: "finish", seat: "reviewer" },
  ];
  const modern = (pass: string, sha: string, fields: Partial<SeatRecord> = {}) => seat({
    schema_version: "1.2", pr: 1, pass, input_sha: sha, output_sha: sha, ...fields,
  });
  const verify = async (records: SeatRecord[], head = B) => {
    const gh = graphGh({
      head, baseSha: A, nodes,
      comments: records.map((record, i) => comment(i + 1, fenced(record), `2026-11-14T00:00:0${i}Z`)),
    });
    const state = await loadReview(gh, "BeniCheni/elenchus", 1, config);
    return { check: formatCheck(buildCheck(state)), status: formatStatus(buildStatus(state)) };
  };

  it("names an unconfigured pass", async () => {
    const { check } = await verify([modern("extra", A)]);
    expect(check).toMatch(/FAIL pass pass extra .*not configured/);
  });

  it("links a read-only pass to its predecessor's output", async () => {
    const { check } = await verify([modern("cold", B), modern("finish", A)]);
    expect(check).toMatch(/FAIL sha-chain pass finish .*previous pass cold/);
  });

  it("accepts a later re-read of an earlier pass and checks its route in place of the original", async () => {
    const original = modern("cold", A, { model: { requested: "claude-fable-5-2", observed: "other" } });
    const { check, status } = await verify([original, modern("finish", A), modern("cold", B, { reread: true })]);
    expect(check).toBe("ok\n");
    expect(status).toContain("issuecomment-3");
    expect(status).toContain(`head equals last output_sha ${B}`);
  });

  it("accepts and names a same-range correction without changing sequence or a re-read's place", async () => {
    const original = modern("cold", A, { model: { requested: "claude-fable-5-2", observed: "other" } });
    const corrected = modern("cold", A);
    const { check, status } = await verify([original, corrected, modern("finish", A)], A);
    expect(check).toBe("NOTICE record replacement pass cold comment 2 replaces comment 1 at the same SHAs\n");
    expect(status).toContain("pass cold comment 2 replaces comment 1 at the same SHAs");
    const reread = await verify([
      corrected, modern("finish", A), modern("cold", B, { reread: true }), modern("cold", B),
    ]);
    expect(reread.check).toContain("a repeat after a later pass has recorded must be marked as a re-read");
    expect(reread.status).toContain("issuecomment-3");
    const outOfOrder = await verify([modern("finish", A), corrected, modern("finish", A)], A);
    expect(outOfOrder.check).toMatch(/FAIL sequence pass finish/);
    expect(outOfOrder.check).toContain("NOTICE record replacement pass finish comment 3 replaces comment 1");
  });

  it.each([
    { records: [modern("cold", B, { reread: true })], error: /requires an earlier record/ },
    { records: [modern("cold", A), modern("cold", A, { reread: true })], error: /requires a later output_sha/ },
    { records: [modern("cold", A), modern("cold", B)], error: /must be marked as a re-read/ },
    { records: [modern("cold", A), modern("cold", A, { output_sha: B })], error: /must be marked as a re-read/ },
    { records: [modern("cold", B), modern("cold", B, { input_sha: A })], error: /must be marked as a re-read/ },
    { records: [modern("cold", B), modern("cold", A, { reread: true })], error: /does not advance from/ },
    { records: [modern("cold", A), modern("finish", C), modern("cold", B, { reread: true })], error: /does not continue from/ },
  ])("fails invalid re-read chains %#", async ({ records, error }) => {
    const { check } = await verify(records, C);
    expect(check).toMatch(error);
  });
});

it("refuses a pull request response with the wrong pull number before further reads", async () => {
  const calls: string[] = [];
  const gh: GhClient = { async get(path) {
    calls.push(path);
    return { number: 2, head: { sha: A }, base: { ref: "main", sha: A } };
  } };
  await expect(loadReview(gh, "BeniCheni/elenchus", 1, kickoffConfig())).rejects.toThrow(/returned pull request 2 for 1/);
  expect(calls).toEqual(["/repos/BeniCheni/elenchus/pulls/1"]);
});

it("requires a matching model and effort to be listed in the vendor table", async () => {
  const unlisted = [
    comment(1, fenced(seat({
      pass: "0",
      model: { requested: "unlisted", observed: "unlisted" },
      effort: { requested: "unlisted", observed: "unlisted" },
    })), "2026-11-14T00:00:01Z"),
  ];
  const { check } = await review(unlisted);
  expect(check.match(/FAIL route/g)).toHaveLength(2);
  expect(check).toMatch(/model requested unlisted observed unlisted/);
  expect(check).toMatch(/effort requested unlisted observed unlisted/);
});

it("uses the configured addressee and retry cap", async () => {
  const config = { ...kickoffConfig(), retry_cap: 0, escalate_to: "Rae" };
  const gh = graphGh({
    head: A, baseSha: A, nodes,
    comments: [comment(1, fenced({ seat_record: 1, pass: "0" }), "2026-11-14T00:00:01Z")],
  });
  const state = await loadReview(gh, "BeniCheni/elenchus", 1, config);
  expect(formatStatus(buildStatus(state))).toContain("next: escalate to Rae");
  expect(formatStatus(buildStatus(state))).toContain("retry cap 0 after 1 failed attempts");
  expect(formatCheck(buildCheck(state))).toContain("escalate to Rae");
});

it("fails sequence when an accepted record was posted before its predecessor, including tied timestamps", async () => {
  const timestamp = "2026-11-14T00:00:01Z";
  const { check } = await review([
    comment(2, fenced(seat({ pass: "0" })), timestamp),
    comment(1, fenced(seat({ pass: "1" })), timestamp),
  ]);
  expect(check).toMatch(/FAIL sequence pass 1 .*posted before pass 0/);
});

it("names a record with the wrong PR and ignores unauthorized comments without a json fence", async () => {
  const { check } = await review([
    comment(1, fenced(seat({ pass: "0", pr: 99 })), "2026-11-14T00:00:01Z"),
    comment(2, "plain prose", "2026-11-14T00:00:02Z", "other"),
    comment(3, fenced(seat({ pass: "1" })), "2026-11-14T00:00:03Z", "other"),
  ]);
  expect(check).toMatch(/FAIL pr pass 0 .*record pr 99 does not match pull request 1/);
  expect(check).toMatch(/NOTICE record_authors .*issuecomment-3 /);
  expect(check).not.toContain("issuecomment-2");
});

it("names a merged PR measured from the merge's first parent without range reads", async () => {
  const calls: { path: string; paginate?: boolean }[] = [];
  const gh = graphGh({
    head: B, baseSha: A, mergedAt: C, nodes, calls,
    comments: [comment(1, fenced(seat({ pass: "0", input_sha: A, output_sha: B })), "2026-11-14T00:00:01Z")],
  });
  const state = await loadReview(gh, "BeniCheni/elenchus", 1, kickoffConfig());
  expect(state.baseSha).toBe(B);
  expect(formatStatus(buildStatus(state))).toContain(`merged: ${C}\n`);
  for (const pass of state.config.passes) pass.coverage = true;
  expect(formatCheck(buildCheck(state))).toContain(`NOTICE merged pull request merged at ${C}`);
  expect(formatCheck(buildCheck(state))).not.toContain("coverage");
  expect(calls.map(({ path }) => path)).not.toContain("/repos/BeniCheni/elenchus/commits/heads%2Freplay%2Fmain");
  expect(calls.some(({ path }) => path.includes("/compare/"))).toBe(false);
});

it("uses encoded refs and avoids writing-pass ranges in status mode", async () => {
  const calls: { path: string; paginate?: boolean }[] = [];
  const gh = graphGh({
    head: C, baseSha: A, baseRef: "feature/a&b+#", nodes, calls,
    comments: [comment(1, fenced(seat({ pass: "0", input_sha: A, output_sha: B, commits: [B] })), "2026-11-14T00:00:01Z")],
  });
  await loadReview(gh, "BeniCheni/elenchus", 1, kickoffConfig(), { ranges: false });
  expect(calls.some(({ path }) => path.endsWith("/commits/heads%2Ffeature%2Fa%26b%2B%23"))).toBe(true);
  expect(calls.filter(({ path }) => path.includes("/compare/")).map(({ path }) => path)).toEqual([
    `/repos/BeniCheni/elenchus/compare/${B}...${C}`,
  ]);
});

it("reports that a pull request has no seat records", async () => {
  const { check } = await review([]);
  expect(check).toBe("NOTICE records no seat records\n");
});

it("carries findings across repository-defined pass ids", async () => {
  const config = kickoffConfig();
  config.passes = [
    { id: "discover", role: "discover", seat: "reviewer" },
    { id: "respond", role: "respond", seat: "builder" },
  ];
  config.finding_flow = { opens: "discover", carries: ["respond"] };
  const gh = graphGh({
    head: A, baseSha: A, nodes,
    comments: [
      comment(1, fenced(seat({ schema_version: "1.2", pass: "discover", findings: [{ id: "F9", severity: "note", status: "open" }] })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({ schema_version: "1.2", pass: "respond", findings: [] })), "2026-11-14T00:00:02Z"),
    ],
  });
  const state = await loadReview(gh, "BeniCheni/elenchus", 1, config);
  expect(formatCheck(buildCheck(state))).toMatch(/FAIL finding-carry pass respond finding F9 .*opened in pass discover is missing/);
});
