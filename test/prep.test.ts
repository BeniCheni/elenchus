import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GhClient } from "../src/gh.js";
import { assertGitAllowed } from "../src/git.js";
import { prepareSeat, type Runner } from "../src/prep.js";
import type { Config, GhComment, SeatRecord } from "../src/types.js";
import { comment, fenced, kickoffConfig } from "./graph.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

function origin(): { url: string; first: string; second: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "elenchus-prep-"));
  dirs.push(dir);
  const src = path.join(dir, "src");
  mkdirSync(src);
  git(src, ["init", "-b", "main"]);
  git(src, ["config", "user.email", "cursoragent@cursor.com"]);
  git(src, ["config", "user.name", "Cursor"]);
  writeFileSync(path.join(src, "package.json"), '{"name":"seat","version":"0.0.0"}\n');
  writeFileSync(
    path.join(src, "package-lock.json"),
    '{"name":"seat","lockfileVersion":3,"requires":true,"packages":{"":{"name":"seat","version":"0.0.0"}}}\n',
  );
  writeFileSync(path.join(src, ".gitignore"), "node_modules/\n");
  git(src, ["add", "."]);
  git(src, ["commit", "-m", "first"]);
  const first = git(src, ["rev-parse", "HEAD"]).trim();
  writeFileSync(path.join(src, "README.md"), "second\n");
  git(src, ["add", "README.md"]);
  git(src, ["commit", "-m", "second"]);
  const second = git(src, ["rev-parse", "HEAD"]).trim();
  const bare = path.join(dir, "origin.git");
  git(dir, ["clone", "--bare", src, bare]);
  return { url: bare, first, second, dir };
}

function config(): Config {
  const parsed = kickoffConfig();
  parsed.installs = [{ dir: ".", lockfile: "package-lock.json" }];
  return parsed;
}

function seat(pass: string, sha: string): SeatRecord {
  return {
    seat_record: 1,
    pr: 3,
    pass,
    runtime: "Claude Code",
    model: { requested: "claude-fable-5-2", observed: "claude-fable-5-2", source: "test" },
    effort: { requested: "xhigh", observed: "xhigh", source: "test" },
    route: { recommended_by: "PM", confirmed_by: "Beni", by_hand: true },
    posted_by: "BeniCheni",
    input_sha: sha,
    output_sha: sha,
    commits: [],
    findings: [],
    verdict: "ok",
  };
}

function commentsFor(records: SeatRecord[]): GhComment[] {
  return records.map((record, index) => comment(index + 1, fenced(record), `2026-11-14T00:00:${String(index).padStart(2, "0")}Z`));
}

function client(head: string, records: SeatRecord[], baseSha = head): GhClient {
  const comments = commentsFor(records);
  return {
    async get(apiPath) {
      if (apiPath.endsWith("/pulls/3")) {
        return { number: 3, head: { sha: head, ref: "feature" }, base: { sha: baseSha, ref: "main" } };
      }
      if (apiPath.endsWith("/commits/main")) return { sha: baseSha };
      if (apiPath.includes("/comments")) return comments;
      if (apiPath.includes("/compare/")) return { status: "ahead", total_commits: 0, commits: [], files: [] };
      throw new Error(`unexpected GET ${apiPath}`);
    },
  };
}

function runner(symlinkOutside?: string): Runner {
  return async (command, args, cwd) => {
    if (command === "git") {
      assertGitAllowed(args);
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    }
    if (command === "npm") {
      const modules = path.join(cwd ?? ".", "node_modules");
      mkdirSync(modules, { recursive: true });
      if (symlinkOutside) symlinkSync(symlinkOutside, path.join(modules, "escape"));
      return "";
    }
    throw new Error(`command refused: ${command}`);
  };
}

const route = {
  runtime: "claude",
  model: "claude-fable-5-2",
  effort: "xhigh",
  confirmedBy: "Beni",
};

async function prep(over: {
  head: string;
  records?: SeatRecord[];
  url: string;
  root: string;
  pass?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  symlinkOutside?: string;
}) {
  return prepareSeat({
    gh: client(over.head, over.records ?? []),
    repo: "BeniCheni/elenchus",
    pr: 3,
    pass: over.pass ?? "1",
    runtime: over.runtime ?? route.runtime,
    model: over.model ?? route.model,
    effort: over.effort ?? route.effort,
    confirmedBy: route.confirmedBy,
    root: over.root,
    config: config(),
    cloneUrl: over.url,
    run: runner(over.symlinkOutside),
  });
}

describe("prep refusals", () => {
  it("names the first earlier pass that has no record", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    await expect(prep({ head: made.second, url: made.url, root })).rejects.toThrow(/no valid record for pass 0/);
    await expect(
      prep({ head: made.second, url: made.url, root, pass: "2", records: [seat("0", made.second)] }),
    ).rejects.toThrow(/no valid record for pass 1$/m);
    await expect(
      prep({
        head: made.second,
        url: made.url,
        root,
        pass: "2",
        records: [seat("0", made.second), seat("1", made.second)],
      }),
    ).rejects.toThrow(/no valid record for pass 1\.5/);
  });

  it("names both SHAs when the head has moved", async () => {
    const made = origin();
    await expect(
      prep({
        head: made.second,
        url: made.url,
        root: path.join(made.dir, "seats"),
        records: [seat("0", made.first)],
      }),
    ).rejects.toThrow(new RegExp(`head ${made.second} is not the expected ${made.first}`));
  });

  it("refuses a Cursor route for a read-only pass, and a route that is not in the table", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    await expect(
      prep({ head: made.second, url: made.url, root, pass: "0", runtime: "cursor", model: "grok-4.7-low", effort: "low" }),
    ).rejects.toThrow(/cursor may not hold a read-only seat \(S7\)/);
    await expect(
      prep({ head: made.second, url: made.url, root, model: "no-such-model" }),
    ).rejects.toThrow(/model no-such-model is not in the claude table/);
  });

  it("prints the Codex and Cursor launch lines, and refuses a Cursor effort that is not the model id suffix", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    const codex = await prep({
      head: made.second,
      url: made.url,
      root,
      runtime: "codex",
      model: "gpt-6.1-sol",
      effort: "low",
      records: [seat("0", made.second)],
    });
    expect(codex.launch).toBe(
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex -m gpt-6.1-sol -c model_reasoning_effort=low --sandbox workspace-write",
    );
    const cursor = await prep({
      head: made.second,
      url: made.url,
      root: path.join(made.dir, "seats-cursor"),
      runtime: "cursor",
      model: "grok-4.7-low",
      effort: "low",
      records: [seat("0", made.second)],
    });
    expect(cursor.launch).toBe("agent --model grok-4.7-low");
    await expect(
      prep({
        head: made.second,
        url: made.url,
        root: path.join(made.dir, "seats-mismatch"),
        runtime: "cursor",
        model: "grok-4.7-low",
        effort: "high",
        records: [seat("0", made.second)],
      }),
    ).rejects.toThrow(/cursor effort is the model id suffix \(S4\)/);
  });

  it("refuses a root inside a git working tree", async () => {
    const made = origin();
    await expect(prep({ head: made.second, url: made.url, root: path.join(made.dir, "src") })).rejects.toThrow(
      /inside a git working tree/,
    );
  });

  it("prepares a writing seat, then refuses the open worktree and a later pass that names 1.5", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    const report = await prep({ head: made.second, url: made.url, root, records: [seat("0", made.second)] });
    expect(report.head).toBe(made.second);
    expect(report.launch).toBe("claude --model claude-fable-5-2 --effort xhigh");
    expect(report.launch).not.toContain("--permission-mode");
    const stamp = JSON.parse(readFileSync(report.stamp, "utf8")) as { by_hand: boolean; confirmed_by: string; expected_sha: string };
    expect(stamp.by_hand).toBe(true);
    expect(stamp.confirmed_by).toBe("Beni");
    expect(stamp.expected_sha).toBe(made.second);
    const manifest = JSON.parse(readFileSync(report.manifest, "utf8")) as { merge_base: string };
    expect(manifest.merge_base).toBe(made.second);
    const profile = JSON.parse(readFileSync(report.profile, "utf8")) as { permissions: { deny: string[] } };
    expect(profile.permissions.deny).toContain("Bash(git tag *)");
    expect(git(report.worktree, ["status", "--porcelain"])).toBe("");
    expect(git(report.worktree, ["check-ignore", "-v", ".claude/settings.local.json"])).toMatch(/exclude/);

    await expect(prep({ head: made.second, url: made.url, root, records: [seat("0", made.second)] })).rejects.toThrow(
      /open seat for pass 1 at/,
    );
    await expect(
      prep({ head: made.second, url: made.url, root, pass: "2", records: [seat("0", made.second)] }),
    ).rejects.toThrow(/no valid record for pass 1\.5/);
  });

  it("fails when an install symlink resolves outside the worktree", async () => {
    const made = origin();
    const outside = path.join(made.dir, "outside");
    mkdirSync(outside);
    await expect(
      prep({
        head: made.second,
        url: made.url,
        root: path.join(made.dir, "seats"),
        records: [seat("0", made.second)],
        symlinkOutside: outside,
      }),
    ).rejects.toThrow(/resolves outside the worktree/);
  });

  it("refuses to overwrite a profile that is tracked, and prints a read-only launch line", async () => {
    const made = origin();
    const src = path.join(made.dir, "src");
    mkdirSync(path.join(src, ".claude"));
    writeFileSync(path.join(src, ".claude", "settings.local.json"), "{}\n");
    git(src, ["add", "-f", ".claude/settings.local.json"]);
    git(src, ["commit", "-m", "track the profile"]);
    const third = git(src, ["rev-parse", "HEAD"]).trim();
    git(made.dir, ["--git-dir", path.join(made.dir, "origin.git"), "fetch", src, "main:main"]);
    const root = path.join(made.dir, "seats-tracked");
    await expect(
      prep({ head: third, url: made.url, root, records: [seat("0", third)] }),
    ).rejects.toThrow(/is tracked at/);

    const readOnly = await prepareSeat({
      gh: client(made.second, [seat("0", made.second), seat("1", made.second)]),
      repo: "BeniCheni/elenchus",
      pr: 3,
      pass: "1.5",
      runtime: "claude",
      model: "claude-fable-5-2",
      effort: "xhigh",
      confirmedBy: "Beni",
      root: path.join(made.dir, "seats-plan"),
      config: config(),
      cloneUrl: made.url,
      run: runner(),
    });
    expect(readOnly.launch).toBe("claude --model claude-fable-5-2 --effort xhigh --permission-mode plan");
  });
});
