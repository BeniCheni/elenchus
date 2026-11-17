import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { checkHead } from "../src/gate-review.js";
import type { GhClient } from "../src/gh.js";
import { loadReview } from "../src/load.js";
import type { GhCompare, SeatRecord } from "../src/types.js";
import { comment, fenced, graphGh, kickoffConfig } from "./graph.js";

const REVIEWED = "a".repeat(40);
const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const sha = (text: string) => createHash("sha1").update(text).digest("hex");
const record: SeatRecord = {
  seat_record: 1, schema_version: "1.2", pr: 1, pass: "finish", runtime: "Claude Code",
  model: { requested: "claude-fable-5-2", observed: null, source: "not reported" },
  effort: { requested: "xhigh", observed: "xhigh" },
  route: { recommended_by: null, confirmed_by: null },
  input_sha: REVIEWED, output_sha: REVIEWED, commits: [], findings: [], verdict: "ok",
};

type Snapshot = Record<string, string | { text: string; mode: string }>;

async function headCheck(options: {
  before?: Snapshot;
  after?: Snapshot;
  base?: Snapshot;
  secondParent?: string;
  run?: { head_sha?: string; status?: string; conclusion?: string; app?: { id: number } } | null;
  reread?: boolean;
  truncated?: string;
  compare?: Partial<GhCompare>;
  allow?: boolean;
}) {
  const config = kickoffConfig();
  config.passes = [{ id: "finish", role: "finish", seat: "reviewer" }];
  config.gate!.allowed_changes!.reread_pass = "finish";
  if (options.allow === false) delete config.gate!.allowed_changes;
  const records = [comment(1, fenced(record), "2026-11-14T00:00:01Z")];
  if (options.reread) records.push(comment(2, fenced({
    ...record, reread: true, input_sha: HEAD, output_sha: HEAD,
  }), "2026-11-14T00:00:02Z"));
  const nodes = {
    [REVIEWED]: { parents: [], author: "Codex <noreply@openai.com>" },
    [BASE]: { parents: [REVIEWED], author: "Codex <noreply@openai.com>" },
    [HEAD]: { parents: [REVIEWED, ...(options.secondParent ? [options.secondParent] : [])], author: "Codex <noreply@openai.com>" },
  };
  const inner = graphGh({ head: HEAD, baseSha: BASE, nodes, comments: records });
  const blobs = new Map<string, string>();
  const trees = new Map(Object.entries({
    [REVIEWED]: options.before ?? {},
    [HEAD]: options.after ?? {},
    [BASE]: options.base ?? {},
  }).map(([ref, snapshot]) => [ref, Object.entries(snapshot).map(([path, value]) => {
    const { text, mode } = typeof value === "string" ? { text: value, mode: "100644" } : value;
    const id = sha(text);
    blobs.set(id, text);
    return { path, type: "blob", mode, sha: id };
  })]));
  const gh: GhClient = {
    async get(apiPath, request) {
      if (apiPath.includes("/check-runs?")) return {
        check_runs: options.run === null ? [] : [{
          name: "verify", head_sha: HEAD, status: "completed", conclusion: "success", app: { id: 15368 }, ...options.run,
        }],
      };
      const ref = /\/git\/trees\/([^?]+)/.exec(apiPath)?.[1];
      if (ref) return { tree: trees.get(ref) ?? [], truncated: options.truncated === ref };
      const blob = /\/git\/blobs\/([^?]+)/.exec(apiPath)?.[1];
      if (blob) return { encoding: "base64", content: Buffer.from(blobs.get(blob)!).toString("base64") };
      if (apiPath.endsWith("?per_page=1")) return { status: "diverged" };
      const value = await inner.get(apiPath, request);
      if (options.compare && apiPath.includes("/compare/") && request?.paginate) {
        return { ...(value as GhCompare), ...options.compare };
      }
      return value;
    },
  };
  const state = await loadReview(gh, "BeniCheni/elenchus", 1, config, { ranges: false });
  return checkHead(gh, state, true);
}

it("classifies configured paths and requires green CI at the new head", async () => {
  const changed = { after: { "docs/release.md": "ok", "README.md": "updated" } };
  expect(await headCheck(changed)).toEqual([{ severity: "notice", rule: "head", message: expect.stringContaining("only configured paths") }]);
  for (const run of [null, { conclusion: "failure" }, { status: "in_progress" }, { app: { id: 9 } }, { head_sha: BASE }]) {
    expect(await headCheck({ ...changed, run })).toContainEqual({
      severity: "fail", rule: "ci", message: expect.stringMatching(/verify.*(failure|missing|success)/),
    });
  }
});

it("requires the review pass for source changes and accepts its re-read", async () => {
  const after = { "src/index.ts": "source" };
  expect(await headCheck({ after })).toContainEqual({
    severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read"),
  });
  expect(await headCheck({ after, reread: true })).toEqual([]);
  expect(await headCheck({ after: { "docs/ok.md": "ok" }, allow: false })).toContainEqual({
    severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read"),
  });
});

it("checks test-file version changes byte for byte", async () => {
  const before = { "package.json": '{"version":"1.2.3"}', "test/version.test.ts": 'assert("1.2.3");\n' };
  const after = { "package.json": '{"version":"1.2.4"}', "test/version.test.ts": 'assert("1.2.4");\n' };
  expect(await headCheck({ before, after })).toContainEqual({
    severity: "notice", rule: "head", message: expect.stringContaining("test version replacement"),
  });
  for (const value of ['other("1.2.4");\n', 'assert("1.2.4");', { text: after["test/version.test.ts"], mode: "100755" }]) {
    expect(await headCheck({ before, after: { ...after, "test/version.test.ts": value } })).toContainEqual({
      severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read"),
    });
  }
  expect(await headCheck({ before, after: { ...before, "test/version.test.ts": after["test/version.test.ts"] } }))
    .toContainEqual({ severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read") });
});

it("permits a base merge only when each changed path takes the second parent's entry", async () => {
  const before = { "src/index.ts": "old", "src/deleted.ts": "gone" };
  const base = { "src/index.ts": "incoming" };
  const correct = { before, after: base, base, secondParent: BASE };
  expect(await headCheck(correct)).toContainEqual({
    severity: "notice", rule: "head", message: expect.stringContaining("merge of the base branch"),
  });
  for (const options of [{ after: { "src/index.ts": "manual result" } }, { secondParent: REVIEWED }, { truncated: BASE }]) {
    expect(await headCheck({ ...correct, ...options })).toContainEqual({
      severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read"),
    });
  }
});

it("fails when the new head diverges or a paginated range is incomplete", async () => {
  expect(await headCheck({ compare: { status: "diverged" } })).toContainEqual({
    severity: "fail", rule: "head", message: expect.stringContaining("does not advance"),
  });
  expect(await headCheck({ compare: { total_commits: 2 } })).toContainEqual({
    severity: "fail", rule: "head", message: expect.stringContaining("did not list every commit"),
  });
});
