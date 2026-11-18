import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fenced, kickoffConfig } from "./graph.js";
import { beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "dist/cli.js");

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function fakeGh(dir: string): string {
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const script = path.join(bin, "gh");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const apiPath = process.argv[process.argv.length - 1];
const file = path.join(process.env.FIXTURE_DIR, encodeURIComponent(apiPath) + ".json");
if (!fs.existsSync(file)) {
  process.stderr.write("Not Found\\n");
  process.exit(1);
}
const fixture = fs.readFileSync(file, "utf8");
process.stdout.write(process.argv.includes("--slurp") ? "[" + fixture + "]" : fixture);
`,
  );
  chmodSync(script, 0o755);
  return bin;
}

beforeAll(() => {
  const tsc = path.join(root, "node_modules/typescript/bin/tsc");
  const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stdout + build.stderr);
});

describe("the built command", () => {
  it("exits 2 on a usage error", () => {
    expect(run([]).status).toBe(2);
    expect(run(["status", "--nope"]).status).toBe(2);
    expect(run(["prep", "BeniCheni/elenchus#3"]).status).toBe(2);
  });

  it("exits 0 when check has no failure", () => {
    const sha = "1".repeat(40);
    const result = checkedComments([{
      id: 1,
      html_url: "https://github.com/BeniCheni/elenchus/pull/1#issuecomment-1",
      user: { login: "BeniCheni" },
      created_at: "2026-11-14T00:00:01Z",
      body: fenced({
        seat_record: 1, pr: 1, pass: "0", runtime: "Claude Code",
        model: { requested: "claude-fable-5-2", observed: null, source: "not reported" },
        effort: { requested: "xhigh", observed: "xhigh" },
        route: { recommended_by: null, confirmed_by: null },
        input_sha: sha, output_sha: sha, commits: [], findings: [], verdict: "ok",
      }),
    }]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/UNVERIFIED route/);
    expect(result.stdout).not.toMatch(/FAIL /);
  });

  it("exits 1 when check finds a failure", () => {
    const result = checkedComments([{
      id: 1,
      html_url: "https://github.com/BeniCheni/elenchus/pull/1#issuecomment-1",
      user: { login: "BeniCheni" },
      created_at: "2026-11-14T00:00:01Z",
      body: fenced({ seat_record: 1, pass: "0" }),
    }]);
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(result.stdout).toMatch(/FAIL retries pass 0/);
  });
});

function checkedComments(comments: unknown[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "elenchus-cli-"));
  const fixtures = path.join(dir, "fixtures");
  mkdirSync(fixtures);
  const sha = "1".repeat(40);
  const write = (apiPath: string, value: unknown) => {
    writeFileSync(path.join(fixtures, `${encodeURIComponent(apiPath)}.json`), JSON.stringify(value));
  };
  write("/repos/BeniCheni/elenchus/pulls/1", { number: 1, head: { sha }, base: { sha, ref: "replay/main" } });
  write("/repos/BeniCheni/elenchus/commits/heads%2Freplay%2Fmain", { sha });
  write("/repos/BeniCheni/elenchus/issues/1/comments?per_page=100", comments);
  const bin = fakeGh(dir);
  return run(["check", "BeniCheni/elenchus#1", "--config", "examples/kickoff.elenchus.json"], {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FIXTURE_DIR: fixtures,
  });
}

function authorizeCli(options: { red?: boolean; incomplete?: boolean; omitCoverage?: boolean; correction?: boolean; changed?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "elenchus-cli-authorize-"));
  const fixtures = path.join(dir, "fixtures");
  mkdirSync(fixtures);
  const sha = "1".repeat(40);
  const head = options.changed ? "2".repeat(40) : sha;
  const write = (apiPath: string, value: unknown) => {
    writeFileSync(path.join(fixtures, `${encodeURIComponent(apiPath)}.json`), JSON.stringify(value));
  };
  const baseConfig = kickoffConfig();
  baseConfig.passes = [
    { id: "0", role: "review", seat: "reviewer", coverage: options.omitCoverage === true || options.correction === true },
    { id: "ruling", role: "ruling", seat: "maintainer" },
  ];
  baseConfig.finding_flow = { opens: "0", carries: [], ruling: "ruling" };
  baseConfig.gate!.allowed_changes!.reread_pass = "0";
  baseConfig.gate!.app_id = 459;
  write("/repos/BeniCheni/elenchus/pulls/1", { number: 1, state: "open", head: { sha: head }, base: { sha, ref: "trunk" } });
  write("/repos/BeniCheni/elenchus/commits/heads%2Ftrunk", { sha });
  write(`/repos/BeniCheni/elenchus/contents/.elenchus.json?ref=${sha}`, {
    content: Buffer.from(JSON.stringify(baseConfig)).toString("base64"),
  });
  const passes = options.correction ? ["0", "0", "ruling"] : ["0", "ruling"];
  write("/repos/BeniCheni/elenchus/issues/1/comments?per_page=100", options.incomplete ? [] : passes.map((pass, i) => ({
    id: i + 1, html_url: `https://github.com/BeniCheni/elenchus/pull/1#issuecomment-${i + 1}`,
    user: { login: "BeniCheni" }, created_at: `2026-11-14T00:00:0${i + 1}Z`,
    body: fenced({
      seat_record: 1, schema_version: "1.2", pr: 1, pass, runtime: "Codex",
      model: { requested: "gpt-6.1-sol", observed: null, source: "not reported" },
      effort: { requested: "xhigh", observed: null, source: "not reported" },
      route: { recommended_by: null, confirmed_by: null },
      input_sha: sha, output_sha: sha, commits: [], findings: [], verdict: "ok",
      ...(options.correction && pass === "0" ? { coverage: { total: 1 - i, reviewed: 1 - i, skipped: [] } } : {}),
    }),
  })));
  write(`/repos/BeniCheni/elenchus/commits/${head}/check-runs?filter=latest&per_page=100`, {
    check_runs: [{ name: "verify", app: { id: 15368 }, head_sha: head, status: "completed", conclusion: options.red ? "failure" : "success" }],
  });
  if (options.correction) write(`/repos/BeniCheni/elenchus/compare/${sha}...${sha}`, { status: "identical", total_commits: 0, files: [] });
  if (options.changed) {
    write(`/repos/BeniCheni/elenchus/compare/${sha}...${head}`, {
      status: "ahead", total_commits: 1, commits: [{ sha: head, parents: [{ sha }] }],
    });
    write(`/repos/BeniCheni/elenchus/git/trees/${sha}?recursive=1`, { tree: [], truncated: false });
    write(`/repos/BeniCheni/elenchus/git/trees/${head}?recursive=1`, {
      tree: [{ path: "docs/release.md", type: "blob", mode: "100644", sha: "3".repeat(40) }], truncated: false,
    });
  }
  const bin = fakeGh(dir);
  return run(["authorize", "BeniCheni/elenchus#1", "--dry-run"], {
    PATH: `${bin}:${process.env.PATH ?? ""}`, FIXTURE_DIR: fixtures,
  });
}

it("runs authorize dry-run through dist/cli.js in the repository", () => {
  const result = authorizeCli();
  expect(result.status, result.stderr).toBe(0);
  const base = `configuration: base trunk ${"1".repeat(40)}\n`;
  expect(result.stdout).toBe(`${base}would post kickoff/360 success on ${"1".repeat(40)}\n`);
  for (const [options, expected] of [
    [{ red: true }, /FAIL ci verify .*failure/],
    [{ incomplete: true }, /FAIL records pass 0 no valid record/],
    [{ omitCoverage: true }, /UNVERIFIED coverage pass 0 .*coverage not reported/],
  ] as const) {
    const rejected = authorizeCli(options);
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(rejected.stdout.startsWith(base)).toBe(true);
    expect(rejected.stdout).toMatch(expected);
  }
});

it("prints both replacement IDs and the accepted shape on authorize success, and the IDs on refusal", () => {
  const notice = "NOTICE record replacement pass 0 comment 2 replaces comment 1 at the same SHAs";
  const accepted = authorizeCli({ correction: true, changed: true });
  expect(accepted.status, accepted.stderr + accepted.stdout).toBe(0);
  expect(accepted.stdout).toContain(notice);
  expect(accepted.stdout).toContain(`NOTICE head ${"2".repeat(40)} allowed shape: only configured paths`);
  const refused = authorizeCli({ correction: true, red: true });
  expect(refused.status, refused.stderr + refused.stdout).toBe(1);
  expect(refused.stdout).toContain(notice);
  expect(refused.stdout).toMatch(/FAIL ci verify .*failure/);
});
