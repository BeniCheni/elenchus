import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkHead } from "../src/gate-review.js";
import type { GhClient } from "../src/gh.js";
import { loadReview } from "../src/load.js";
import type { GhCompare, SeatRecord } from "../src/types.js";
import { comment, fenced, graphGh, kickoffConfig } from "./graph.js";

const REVIEWED = "a".repeat(40);
const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const OFFBASE = "d".repeat(40);
const ANCESTOR = "e".repeat(40);
const sha = (text: string) => createHash("sha1").update(text).digest("hex");
const record: SeatRecord = {
  seat_record: 1, schema_version: "1.2", pr: 1, pass: "finish", runtime: "Claude Code",
  model: { requested: "claude-fable-5-2", observed: null, source: "not reported" },
  effort: { requested: "xhigh", observed: "xhigh" },
  route: { recommended_by: null, confirmed_by: null },
  input_sha: REVIEWED, output_sha: REVIEWED, commits: [], findings: [], verdict: "ok",
};

type Snapshot = Record<string, string | { text: string; mode: string; id?: string }>;

async function headCheck(options: {
  before?: Snapshot;
  after?: Snapshot;
  base?: Snapshot;
  ancestor?: Snapshot;
  firstParent?: string;
  secondParent?: string;
  thirdParent?: string;
  run?: { head_sha?: string; status?: string; conclusion?: string; app?: { id: number } } | null;
  reread?: boolean;
  truncated?: string;
  compare?: Partial<GhCompare>;
  allow?: boolean;
  pattern?: string;
  versionFile?: string;
  lockFile?: string;
}) {
  const config = kickoffConfig();
  config.passes = [{ id: "finish", role: "finish", seat: "reviewer" }];
  config.gate!.allowed_changes!.reread_pass = "finish";
  const version = config.gate!.allowed_changes!.version_only!;
  delete version.pattern;
  if (options.pattern) version.pattern = options.pattern;
  if (options.versionFile && options.lockFile) {
    version.file = options.versionFile;
    config.installs = [{ dir: "web", lockfile: options.lockFile }];
  }
  // The replay still lists these paths. They must not inherit the path exemption.
  config.gate!.allowed_changes!.paths.push(version.file, options.lockFile ? `web/${options.lockFile}` : "package-lock.json");
  if (options.allow === false) delete config.gate!.allowed_changes;
  const records = [comment(1, fenced(record), "2026-11-14T00:00:01Z")];
  if (options.reread) records.push(comment(2, fenced({
    ...record, reread: true, input_sha: HEAD, output_sha: HEAD,
  }), "2026-11-14T00:00:02Z"));
  const nodes = {
    [ANCESTOR]: { parents: [], author: "Codex <noreply@openai.com>" },
    [REVIEWED]: { parents: [ANCESTOR], author: "Codex <noreply@openai.com>" },
    [OFFBASE]: { parents: [ANCESTOR], author: "Codex <noreply@openai.com>" },
    [BASE]: { parents: [ANCESTOR], author: "Codex <noreply@openai.com>" },
    [HEAD]: {
      parents: [options.firstParent ?? REVIEWED, ...(options.secondParent ? [options.secondParent] : []), ...(options.thirdParent ? [options.thirdParent] : [])],
      author: "Codex <noreply@openai.com>",
    },
  };
  const inner = graphGh({ head: HEAD, baseSha: BASE, nodes, comments: records });
  const blobs = new Map<string, string>();
  const trees = new Map(Object.entries({
    [REVIEWED]: options.before ?? {},
    [HEAD]: options.after ?? {},
    [BASE]: options.base ?? {},
    [ANCESTOR]: options.ancestor ?? {},
  }).map(([ref, snapshot]) => [ref, Object.entries(snapshot).map(([path, value]) => {
    const { text, mode, id = sha(text) } = typeof value === "string" ? { text: value, mode: "100644" } : value;
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

it("accepts a clean base merge and refuses a dropped reviewed file, an ours merge, or another mode", async () => {
  const ancestor = { "src/index.ts": "old" };
  const before = { ...ancestor, "src/deleted.ts": "keep this reviewed addition" };
  const base = { "src/index.ts": "incoming" };
  const after = { ...before, ...base };
  const correct = { before, after, base, ancestor, secondParent: BASE };
  expect(await headCheck(correct)).toEqual([{
    severity: "notice", rule: "head", message: expect.stringContaining("merge of the base branch"),
  }]);
  for (const options of [
    { after: before },
    { after: base },
    { after: { ...after, "src/index.ts": { text: "incoming", mode: "100755" } } },
    { secondParent: OFFBASE },
    { truncated: BASE },
    { truncated: ANCESTOR },
  ]) {
    expect(await headCheck({ ...correct, ...options })).toContainEqual({
      severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read"),
    });
  }
});

it("refuses to replace a reviewed change with a different change to the same path on the base", async () => {
  const ancestor = { "src/guard.ts": "original" };
  const before = { "src/guard.ts": "reviewed", "test/guard.test.ts": "reviewed test" };
  const base = { "src/guard.ts": "incoming" };
  for (const after of [base, { ...before, ...base }, before]) {
    expect(await headCheck({ ancestor, before, base, after, secondParent: BASE })).toContainEqual({
      severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read"),
    });
  }
  const agreed = { "src/guard.ts": "same change" };
  expect(await headCheck({ ancestor, before: agreed, base: agreed, after: agreed, secondParent: BASE }))
    .toEqual([expect.objectContaining({ severity: "notice", message: expect.stringContaining("merge of the base branch") })]);
});

it("refuses an octopus merge and a review reachable only through a later parent", async () => {
  expect(await headCheck({ secondParent: BASE, thirdParent: OFFBASE })).toEqual([
    expect.objectContaining({ severity: "fail", message: expect.stringContaining("needs a pass finish re-read") }),
  ]);
  expect(await headCheck({ firstParent: BASE, secondParent: REVIEWED })).toEqual([
    expect.objectContaining({ severity: "fail", message: expect.stringContaining("first-parent chain") }),
  ]);
});

it("does not accept a version replacement if the old version is absent from the test blob", async () => {
  // Exercise the replacement invariant even if a fixture serves identical
  // content for two distinct Git object IDs.
  const text = 'assert("unrelated");';
  expect(await headCheck({
    before: { "package.json": '{"version":"1.0.0"}', "test/version.test.ts": text },
    after: { "package.json": '{"version":"1.0.1"}', "test/version.test.ts": { text, mode: "100644", id: sha("different object") } },
  })).toEqual([expect.objectContaining({ severity: "fail", rule: "head" })]);
});

it("accepts the JSON changes from npm version patch and refuses unrelated dependency and script changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elenchus-version-"));
  const packageFile = "package.json";
  const lockFile = "package-lock.json";
  const before = {
    [packageFile]: JSON.stringify({ name: "example", version: "1.2.3", scripts: { test: "node --test" }, dependencies: { example: "1.2.3" } }),
    [lockFile]: JSON.stringify({ name: "example", version: "1.2.3", lockfileVersion: 3, packages: {
      "": { name: "example", version: "1.2.3", dependencies: { example: "1.2.3" } },
      "node_modules/example": { version: "1.2.3" },
    } }),
  };
  try {
    for (const [file, content] of Object.entries(before)) writeFileSync(join(dir, file), content);
    execFileSync("npm", ["version", "patch", "--no-git-tag-version", "--ignore-scripts"], { cwd: dir });
    const after = { [packageFile]: readFileSync(join(dir, packageFile), "utf8"), [lockFile]: readFileSync(join(dir, lockFile), "utf8") };
    expect(await headCheck({ before, after })).toEqual([
      expect.objectContaining({ severity: "notice", message: expect.stringContaining("version files only") }),
    ]);
    const parsedLock = JSON.parse(after[lockFile]);
    for (const [field, changed] of Object.entries({
      dependency: { ...after, [lockFile]: after[lockFile].replaceAll('"1.2.3"', '"1.2.4"') },
      lockVersion: { ...after, [lockFile]: JSON.stringify({ ...parsedLock, version: "1.2.3" }) },
      rootLockVersion: { ...after, [lockFile]: JSON.stringify({ ...parsedLock, packages: {
        ...parsedLock.packages, "": { ...parsedLock.packages[""], version: "1.2.3" },
      } }) },
      scriptWithoutBump: { ...before, [packageFile]: before[packageFile].replace("node --test", "node --test other.test.js") },
      scriptWithBump: { ...after, [packageFile]: after[packageFile].replace("node --test", "node --test other.test.js") },
      versionFileMode: { ...after, [packageFile]: { text: after[packageFile], mode: "100755" } },
      lockFileMode: { ...after, [lockFile]: { text: after[lockFile], mode: "100755" } },
    })) {
      expect(await headCheck({ before, after: changed }), field).toEqual([expect.objectContaining({ severity: "fail", rule: "head" })]);
    }
    const nested = (files: typeof before) => ({ "web/release.json": files[packageFile], "web/npm-lock.json": files[lockFile] });
    expect(await headCheck({ versionFile: "web/release.json", lockFile: "npm-lock.json", before: nested(before), after: nested(after) }))
      .toEqual([expect.objectContaining({ severity: "notice", message: expect.stringContaining("version files only") })]);
    expect(await headCheck({
      versionFile: "web/release.json", lockFile: "npm-lock.json", before: nested(before),
      after: nested({ ...after, [lockFile]: after[lockFile].replaceAll('"1.2.3"', '"1.2.4"') }),
    })).toEqual([expect.objectContaining({ severity: "fail", rule: "head" })]);
    const oldParsedLock = JSON.parse(before[lockFile]);
    for (const oldLock of [
      { ...oldParsedLock, version: "1.2.2", packages: { ...oldParsedLock.packages, "": { ...oldParsedLock.packages[""], version: "1.2.2" } } },
      { ...oldParsedLock, packages: { ...oldParsedLock.packages, "": { ...oldParsedLock.packages[""], version: "1.2.2" } } },
    ]) {
      expect(await headCheck({ before: { ...before, [lockFile]: JSON.stringify(oldLock) }, after }))
        .toEqual([expect.objectContaining({ severity: "fail", rule: "head" })]);
    }
    expect(await headCheck({ before: after, after: { ...after, [lockFile]: JSON.stringify(parsedLock, null, 3) } }))
      .toEqual([expect.objectContaining({ severity: "fail", rule: "head" })]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("validates old and new version strings for both version-file and test replacements", async () => {
  for (const [oldVersion, newVersion] of [["1.0.0", "false"], ["false", "1.0.1"]]) {
    const before = { "package.json": JSON.stringify({ version: oldVersion }), "test/version.test.ts": oldVersion };
    const after = { ...before, "package.json": JSON.stringify({ version: newVersion }) };
    for (const changed of [after, { ...after, "test/version.test.ts": newVersion }]) {
      expect(await headCheck({ before, after: changed })).toEqual([expect.objectContaining({ severity: "fail", rule: "head" })]);
    }
  }
  const before = { "package.json": '{"version":"2026r1"}', "test/version.test.ts": "2026r1" };
  const after = { "package.json": '{"version":"2026r2"}', "test/version.test.ts": "2026r2" };
  expect(await headCheck({ before, after, pattern: "[0-9]{4}r[1-9]" })).toEqual([
    expect.objectContaining({ severity: "notice", message: expect.stringContaining("test version replacement") }),
  ]);
});

it("classifies a writing executor's commit and only recognizes the configured pass's re-read", async () => {
  const config = kickoffConfig();
  const records = config.passes.map(({ id }) => ({ ...record, pass: id }));
  records[6] = { ...records[6]!, output_sha: HEAD, commits: [HEAD] };
  const nodes = {
    [REVIEWED]: { parents: [], author: "Codex <noreply@openai.com>" },
    [HEAD]: { parents: [REVIEWED], author: "Codex <noreply@openai.com>" },
  };
  async function check(entries: SeatRecord[]) {
    const inner = graphGh({ head: HEAD, baseSha: REVIEWED, nodes, comments: entries.map((value, i) =>
      comment(i + 1, fenced(value), `2026-11-14T00:00:0${i}Z`),
    ) });
    const gh: GhClient = { async get(path, options) {
      if (path.includes("/check-runs?")) return { check_runs: [{ name: "verify", status: "completed", conclusion: "success", head_sha: HEAD, app: { id: 15368 } }] };
      if (path.includes("/git/trees/")) return { truncated: false, tree: path.includes(HEAD)
        ? [{ path: "src/executor.ts", sha: sha("code"), mode: "100644", type: "blob" }] : [] };
      return inner.get(path, options);
    } };
    return checkHead(gh, await loadReview(gh, "BeniCheni/elenchus", 1, config, { ranges: false }));
  }
  const fail = expect.objectContaining({ severity: "fail", rule: "head", message: expect.stringContaining("pass 2.5 re-read") });
  const reread = { ...record, reread: true as const, input_sha: HEAD, output_sha: HEAD };
  expect(await check(records)).toEqual([fail]);
  expect(await check([...records, { ...reread, pass: "1" }])).toEqual([fail]);
  expect(await check([...records, { ...reread, pass: "2.5" }])).toEqual([]);
});

it("fails when the new head diverges or a paginated range is incomplete", async () => {
  expect(await headCheck({ compare: { status: "diverged" } })).toContainEqual({
    severity: "fail", rule: "head", message: expect.stringContaining("does not advance"),
  });
  expect(await headCheck({ compare: { total_commits: 2 } })).toContainEqual({
    severity: "fail", rule: "head", message: expect.stringContaining("did not list every commit"),
  });
});

it("requires version-only changes to occur in configured test paths", async () => {
  expect(await headCheck({
    before: { "package.json": '{"version":"1.0.0"}', "src/version.ts": '"1.0.0"' },
    after: { "package.json": '{"version":"1.0.1"}', "src/version.ts": '"1.0.1"' },
  })).toContainEqual({ severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read") });
});

it("requires an actual old and new version before classifying a test replacement", async () => {
  for (const [before, after] of [
    [{ "package.json": '{}', "test/version.test.ts": '"null"' }, { "package.json": '{"version":"1.0.1"}', "test/version.test.ts": '"1.0.1"' }],
    [{ "package.json": '{"version":"1.0.0"}', "test/version.test.ts": '"1.0.0"' }, { "package.json": '{}', "test/version.test.ts": '"null"' }],
  ]) {
    expect(await headCheck({ before, after })).toContainEqual({
      severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read"),
    });
  }
});

it("requires the second parent to be on the base even when every resulting blob matches", async () => {
  // All three trees agree, so the refusal depends on the incoming parent's ancestry.
  expect(await headCheck({ secondParent: OFFBASE })).toEqual([
    expect.objectContaining({ severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read") }),
  ]);
});

it.each([REVIEWED, HEAD])("refuses a truncated tree at %s", async (truncated) => {
  expect(await headCheck({ after: { "docs/release.md": "ok" }, truncated })).toContainEqual({
    severity: "fail", rule: "head", message: expect.stringContaining("needs a pass finish re-read"),
  });
});
