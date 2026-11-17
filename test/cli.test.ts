import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fenced } from "./graph.js";
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
