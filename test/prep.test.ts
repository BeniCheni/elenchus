import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { formatCheck } from "../src/format.js";
import type { GhClient } from "../src/gh.js";
import * as gitModule from "../src/git.js";
import { assertGitAllowed, type GitScope } from "../src/git.js";
import { loadReview } from "../src/load.js";
import { defaultRun, openSeatMessage, prepareSeat, prepGitEnv, type Runner } from "../src/prep.js";
import { seatCredentialArgs, withSeatToken } from "../src/seat-credentials.js";
import { buildCheck } from "../src/report.js";
import type { Config, GhComment, SeatRecord } from "../src/types.js";
import { comment, fenced, graphGh, kickoffConfig, replayConfig, type Node } from "./graph.js";

const dirs: string[] = [];
const seatService = "elenchus test seat";

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
  git(src, ["branch", "feature"]);
  const bare = path.join(dir, "origin.git");
  git(dir, ["clone", "--bare", src, bare]);
  return { url: bare, first, second, dir };
}

function publishFeature(made: { dir: string }): void {
  git(made.dir, ["--git-dir", path.join(made.dir, "origin.git"), "fetch", path.join(made.dir, "src"), "+main:feature"]);
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
        return {
          number: 3,
          head: { sha: head, ref: "feature", repo: { full_name: "BeniCheni/elenchus" } },
          base: { sha: baseSha, ref: "main", repo: { full_name: "BeniCheni/elenchus" } },
        };
      }
      if (apiPath.endsWith("/commits/heads%2Fmain")) return { sha: baseSha };
      if (apiPath.includes("/comments")) return comments;
      if (apiPath.includes("/compare/")) return { status: "ahead", total_commits: 0, commits: [], files: [] };
      throw new Error(`unexpected GET ${apiPath}`);
    },
  };
}

function scopeFor(root: string, pass: string): GitScope {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    seatKeychainService: seatService,
    places: [
      path.join(resolved, "BeniCheni__elenchus.git"),
      path.join(resolved, "BeniCheni/elenchus", `pr-3-pass-${pass}`),
    ],
  };
}

function runner(root: string, pass = "1", symlinkOutside?: string): Runner {
  const scope = scopeFor(root, pass);
  return async (command, args, cwd) => {
    if (command === "git") {
      assertGitAllowed(args, scope);
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
  configOverride?: Config;
}) {
  return prepareSeat({
    seatKeychainService: seatService,
    gh: client(over.head, over.records ?? []),
    repo: "BeniCheni/elenchus",
    pr: 3,
    pass: over.pass ?? "1",
    runtime: over.runtime ?? route.runtime,
    model: over.model ?? route.model,
    effort: over.effort ?? route.effort,
    confirmedBy: route.confirmedBy,
    root: over.root,
    config: over.configOverride ?? config(),
    cloneUrl: over.url,
    run: runner(over.root, over.pass ?? "1", over.symlinkOutside),
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
    expect(existsSync(path.join(made.dir, "seats", "BeniCheni/elenchus/pr-3-pass-1"))).toBe(false);
  });

  it("refuses a Cursor route for a read-only pass, and a route that is not in the table", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    await expect(
      prep({ head: made.second, url: made.url, root, pass: "0", runtime: "cursor", model: "grok-4.7-low", effort: "low" }),
    ).rejects.toThrow(/cursor may not hold a read-only seat/);
    await expect(
      prep({
        head: made.second,
        url: made.url,
        root,
        model: "no-such-model",
        records: [seat("0", made.second)],
      }),
    ).rejects.toThrow(/model no-such-model is not in the claude table/);
    await expect(
      prep({
        head: made.second,
        url: made.url,
        root,
        effort: "no-such-effort",
        records: [seat("0", made.second)],
      }),
    ).rejects.toThrow(/effort no-such-effort is not in the claude table/);
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        runtime: "",
        model: "",
        effort: "",
        confirmedBy: "",
        root,
        config: config(),
        cloneUrl: made.url,
        run: runner(root),
      }),
    ).rejects.toThrow(/prep requires --runtime, --model, --effort and --confirmed-by/);
    await expect(prep({ head: made.second, url: made.url, root, pass: "3" })).rejects.toThrow(/pass 3 has no seat/);
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
      `cd '${codex.seat}' && ${withSeatToken(seatService, "'/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' -m 'gpt-6.1-sol' -c 'model_reasoning_effort=low' --sandbox 'workspace-write'")}`,
    );
    expect(codex.profileNote).toBe("the Codex profile is not known to load");
    expect(codex.profile).toContain(".codex/rules/seat.rules");
    const cursor = await prep({
      head: made.second,
      url: made.url,
      root: path.join(made.dir, "seats-cursor"),
      runtime: "cursor",
      model: "grok-4.7-low",
      effort: "low",
      records: [seat("0", made.second)],
    });
    expect(cursor.launch).toBe(`cd '${cursor.seat}' && ${withSeatToken(seatService, "agent --model 'grok-4.7-low'")}`);
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
    ).rejects.toThrow(/cursor effort is the model id suffix/);
  });

  it("refuses a root inside a git working tree", async () => {
    const made = origin();
    const inside = path.join(made.dir, "src", "new-seats");
    await expect(prep({ head: made.second, url: made.url, root: inside })).rejects.toThrow(/inside a git directory/);
    expect(existsSync(inside)).toBe(false);
    const bareChild = path.join(made.url, "new-seats");
    await expect(prep({ head: made.second, url: made.url, root: bareChild })).rejects.toThrow(/inside a git directory/);
    expect(existsSync(bareChild)).toBe(false);
    const gitChild = path.join(made.dir, "src", ".git", "new-seats");
    await expect(prep({ head: made.second, url: made.url, root: gitChild })).rejects.toThrow(/inside a git directory/);
    expect(existsSync(gitChild)).toBe(false);
  });

  it("prepares a writing seat, then refuses the open worktree and a later pass that names 1.5", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    const report = await prep({ head: made.second, url: made.url, root, records: [seat("0", made.second)] });
    expect(report.head).toBe(made.second);
    expect(report.launch).toBe(`cd '${report.seat}' && ${withSeatToken(seatService, "claude --model 'claude-fable-5-2' --effort 'xhigh'")}`);
    expect(report.launch).not.toContain("--permission-mode");
    const stamp = JSON.parse(readFileSync(report.stamp, "utf8")) as {
      by_hand: boolean;
      confirmed_by: string;
      expected_sha: string;
      runtime: string;
      model: string;
      effort: string;
    };
    expect(stamp.by_hand).toBe(true);
    expect(stamp.confirmed_by).toBe("Beni");
    expect(stamp.expected_sha).toBe(made.second);
    expect(stamp.runtime).toBe("Claude Code");
    const manifest = JSON.parse(readFileSync(report.manifest, "utf8")) as { merge_base: string };
    expect(manifest.merge_base).toBe(made.second);
    const profile = JSON.parse(readFileSync(report.profile, "utf8")) as { permissions: { deny: string[] } };
    expect(profile.permissions.deny).toContain("Bash(git tag *)");
    expect(git(report.seat, ["status", "--porcelain"])).toBe("");
    expect(git(report.seat, ["check-ignore", "-v", ".claude/settings.local.json"])).toMatch(/exclude/);
    expect(existsSync(path.join(report.seat, ".git", "objects", "info", "alternates"))).toBe(false);
    expect(git(report.seat, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature");
    expect(git(report.seat, ["rev-parse", "--abbrev-ref", "@{upstream}"]).trim()).toBe("origin/feature");
    expect(git(report.seat, ["config", "--get", "remote.origin.fetch"]).trim()).toBe("+refs/heads/*:refs/remotes/origin/*");

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
    ).rejects.toThrow(/resolves outside the seat/);
  });

  it("refuses to overwrite a profile that is tracked, and prints a read-only launch line", async () => {
    const made = origin();
    const planRoot = path.join(made.dir, "seats-plan");
    const readOnly = await prepareSeat({
      seatKeychainService: seatService,
      gh: client(made.second, [seat("0", made.second), seat("1", made.second)]),
      repo: "BeniCheni/elenchus",
      pr: 3,
      pass: "1.5",
      runtime: "claude",
      model: "claude-fable-5-2",
      effort: "xhigh",
      confirmedBy: "Beni",
      root: planRoot,
      config: config(),
      cloneUrl: made.url,
      run: runner(planRoot, "1.5"),
    });
    expect(readOnly.launch).toBe(
      `cd '${readOnly.seat}' && ${withSeatToken(seatService, "claude --model 'claude-fable-5-2' --effort 'xhigh' --permission-mode plan")}`,
    );

    const src = path.join(made.dir, "src");
    mkdirSync(path.join(src, ".claude"));
    writeFileSync(path.join(src, ".claude", "settings.local.json"), "{}\n");
    git(src, ["add", "-f", ".claude/settings.local.json"]);
    git(src, ["commit", "-m", "track the profile"]);
    const third = git(src, ["rev-parse", "HEAD"]).trim();
    publishFeature(made);
    const root = path.join(made.dir, "seats-tracked");
    await expect(prep({ head: third, url: made.url, root, records: [seat("0", third)] })).rejects.toThrow(/is tracked at/);
  });

  it("prepares Pass 0 from the pull request head when nothing is recorded", async () => {
    const made = origin();
    const report = await prep({ head: made.second, url: made.url, root: path.join(made.dir, "seats"), pass: "0" });
    expect(report.head).toBe(made.second);
    expect(report.launch).toContain("--permission-mode plan");
  });

  it("quotes a model id that contains a space", async () => {
    const made = origin();
    const report = await prep({
      head: made.second,
      url: made.url,
      root: path.join(made.dir, "seats"),
      model: "Opus 5.5",
      configOverride: { ...config(), vendors: replayConfig().vendors },
      records: [seat("0", made.second)],
    });
    expect(report.launch).toContain("claude --model 'Opus 5.5' --effort 'xhigh'");
  });

  it("refuses a fork, a prototype model name, and a duplicate prep after the named removal", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    const forked = client(made.second, [seat("0", made.second)]);
    const original = forked.get.bind(forked);
    forked.get = async (apiPath, options) => {
      const value = (await original(apiPath, options)) as { head?: { repo?: { full_name?: string } } };
      if (apiPath.endsWith("/pulls/3") && value.head?.repo) value.head.repo.full_name = "other/elenchus";
      return value;
    };
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: forked,
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root,
        config: config(),
        cloneUrl: made.url,
        run: runner(root),
      }),
    ).rejects.toThrow(/pull requests from forks are not supported/);

    await expect(
      prep({
        head: made.second,
        url: made.url,
        root,
        model: "constructor",
        effort: "toString",
        records: [seat("0", made.second)],
      }),
    ).rejects.toThrow(/model constructor is not in the claude table/);
  });

  it("lets the operator remove the named seat and prepare it again", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    const first = await prep({ head: made.second, url: made.url, root, records: [seat("0", made.second)] });
    await expect(prep({ head: made.second, url: made.url, root, records: [seat("0", made.second)] })).rejects.toThrow(
      openSeatMessage("1", first.seat),
    );
    const command = openSeatMessage("1", first.seat).match(/`rm -rf '([^']+)'`/);
    expect(command?.[1]).toBe(first.seat);
    execFileSync("rm", ["-rf", command?.[1] ?? ""]);
    const again = await prep({ head: made.second, url: made.url, root, records: [seat("0", made.second)] });
    expect(again.head).toBe(made.second);
    execFileSync("rm", ["-rf", again.seat]);
  });

  it("refuses a half-made seat on retry, and a head that the clone does not match", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    const base = runner(root);
    const failing: Runner = async (command, args, cwd) => {
      if (command === "npm") throw new Error("npm ci failed");
      return base(command, args, cwd);
    };
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root,
        config: config(),
        cloneUrl: made.url,
        run: failing,
      }),
    ).rejects.toThrow(/npm ci failed/);
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root,
        config: config(),
        cloneUrl: made.url,
        run: base,
      }),
    ).rejects.toThrow(/open seat for pass 1 at/);

    const other = path.join(made.dir, "seats-lie");
    const lyingBase = runner(other);
    const lying: Runner = async (command, args, cwd) => {
      const out = await lyingBase(command, args, cwd);
      if (command === "git" && args.at(-2) === "rev-parse" && args.at(-1) === "HEAD") {
        return `${"1".repeat(40)}\n`;
      }
      return out;
    };
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root: other,
        config: config(),
        cloneUrl: made.url,
        run: lying,
      }),
    ).rejects.toThrow(new RegExp(`head ${"1".repeat(40)} is not the expected ${made.second}`));
  });

  it("pushes the seat's branch onto the pull request head and nowhere else", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    const report = await prep({ head: made.second, url: made.url, root, records: [seat("0", made.second)] });
    const before = git(made.url, ["for-each-ref", "--format=%(refname)", "refs/heads"]).trim().split("\n").sort();
    writeFileSync(path.join(report.seat, "pushed.txt"), "pushed\n");
    git(report.seat, ["add", "pushed.txt"]);
    git(report.seat, ["-c", "user.email=cursoragent@cursor.com", "-c", "user.name=Cursor", "commit", "-m", "from the seat"]);
    expect(git(report.seat, ["status", "-sb"])).toMatch(/ahead 1/);
    git(report.seat, ["push"]);
    const after = git(made.url, ["for-each-ref", "--format=%(refname)", "refs/heads"]).trim().split("\n").sort();
    expect(after).toEqual(before);
    expect(git(made.url, ["rev-parse", "refs/heads/feature"]).trim()).toBe(git(report.seat, ["rev-parse", "HEAD"]).trim());
    expect(git(made.url, ["rev-parse", "refs/heads/main"]).trim()).toBe(made.second);
  });

  it("keeps a non-ASCII path and counts a file that became a symlink as a modification", async () => {
    const made = origin();
    const src = path.join(made.dir, "src");
    writeFileSync(path.join(src, "link-me"), "text\n");
    git(src, ["add", "link-me"]);
    git(src, ["commit", "-m", "add the file"]);
    git(made.dir, ["--git-dir", path.join(made.dir, "origin.git"), "fetch", src, "+main:main"]);
    writeFileSync(path.join(src, "café notes.md"), "café\n");
    rmSync(path.join(src, "link-me"));
    symlinkSync("package.json", path.join(src, "link-me"));
    git(src, ["add", "café notes.md", "link-me"]);
    git(src, ["commit", "-m", "the file becomes a symlink"]);
    const head = git(src, ["rev-parse", "HEAD"]).trim();
    publishFeature(made);
    const report = await prep({ head, url: made.url, root: path.join(made.dir, "seats"), records: [seat("0", head)] });
    const paths = new Map(report.paths.map((entry) => [entry.path, entry.status]));
    expect(paths.get("café notes.md")).toBe("A");
    expect(paths.get("link-me")).toBe("M");
    expect(JSON.stringify(report.paths)).not.toContain("\\");
  });

  it("does not treat a recorded pass's directory, or another pull request's seat, as open", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    mkdirSync(path.join(root, "BeniCheni/elenchus/pr-3-pass-1"), { recursive: true });
    mkdirSync(path.join(root, "BeniCheni/elenchus/pr-9-pass-1.5"), { recursive: true });
    const report = await prep({
      head: made.second,
      url: made.url,
      root,
      pass: "1.5",
      records: [seat("0", made.second), seat("1", made.second)],
    });
    expect(report.seat).toContain("pr-3-pass-1.5");
  });

  it("refuses an install that leaves the seat, a symlink node_modules, a dirty status, and an empty install list", async () => {
    const made = origin();
    const root = path.join(made.dir, "seats");
    const outside = config();
    outside.installs = [{ dir: "..", lockfile: "package-lock.json" }];
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root,
        config: outside,
        cloneUrl: made.url,
        run: runner(root),
      }),
    ).rejects.toThrow(/install \.\. is outside the seat/);

    const escaped = config();
    escaped.installs = [{ dir: ".", lockfile: "../package-lock.json" }];
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root: path.join(made.dir, "seats-lock"),
        config: escaped,
        cloneUrl: made.url,
        run: runner(path.join(made.dir, "seats-lock")),
      }),
    ).rejects.toThrow(/lockfile \.\.\/package-lock.json escapes \./);

    const dirtyRoot = path.join(made.dir, "seats-dirty");
    const dirty = runner(dirtyRoot);
    const writing: Runner = async (command, args, cwd) => {
      const out = await dirty(command, args, cwd);
      if (command === "npm" && cwd) writeFileSync(path.join(cwd, "stray.txt"), "stray\n");
      return out;
    };
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root: dirtyRoot,
        config: config(),
        cloneUrl: made.url,
        run: writing,
      }),
    ).rejects.toThrow(/git status is not empty/);

    const bareConfig = config();
    bareConfig.installs = [];
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root: path.join(made.dir, "seats-empty"),
        config: bareConfig,
        cloneUrl: made.url,
        run: runner(path.join(made.dir, "seats-empty")),
      }),
    ).rejects.toThrow(/config has no installs/);
    bareConfig.installs = [{ dir: ".", lockfile: "package-lock.json" }];
    bareConfig.forbidden = [];
    await expect(
      prepareSeat({
      seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root: path.join(made.dir, "seats-forbidden"),
        config: bareConfig,
        cloneUrl: made.url,
        run: runner(path.join(made.dir, "seats-forbidden")),
      }),
    ).rejects.toThrow(/config has no forbidden commands/);

    const src = path.join(made.dir, "src");
    symlinkSync(path.join(made.dir, "outside-modules"), path.join(src, "node_modules"));
    git(src, ["add", "-f", "node_modules"]);
    git(src, ["commit", "-m", "symlink the install"]);
    const head = git(src, ["rev-parse", "HEAD"]).trim();
    publishFeature(made);
    await expect(
      prep({ head, url: made.url, root: path.join(made.dir, "seats-symlink"), records: [seat("0", head)] }),
    ).rejects.toThrow(/install at \. is a symlink/);
  });

  it("copies the stamp's runtime into a record that passes the author rule", async () => {
    const made = origin();
    const report = await prep({
      head: made.second,
      url: made.url,
      root: path.join(made.dir, "seats"),
      records: [seat("0", made.second)],
    });
    const stamp = JSON.parse(readFileSync(report.stamp, "utf8")) as {
      runtime: string;
      model: string;
      effort: string;
      confirmed_by: string;
      by_hand: boolean;
    };
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    const nodes: Record<string, Node> = {
      [A]: { parents: [], author: "Claude <noreply@anthropic.com>" },
      [B]: { parents: [A], author: "Claude <noreply@anthropic.com>" },
    };
    const record = (runtime: string): SeatRecord => ({
      ...seat("1", B),
      pr: 1,
      runtime,
      model: { requested: stamp.model, observed: stamp.model, source: "stamp" },
      effort: { requested: stamp.effort, observed: stamp.effort, source: "stamp" },
      route: { recommended_by: "PM", confirmed_by: stamp.confirmed_by, by_hand: stamp.by_hand },
      input_sha: A,
      output_sha: B,
      commits: [B],
    });
    const run = async (runtime: string) => {
      const comments = [
        comment(1, fenced({ ...seat("0", A), pr: 1, input_sha: A, output_sha: A }), "2026-11-14T00:00:01Z"),
        comment(2, fenced(record(runtime)), "2026-11-14T00:00:02Z"),
      ];
      const state = await loadReview(graphGh({ head: B, baseSha: A, comments, nodes }), "BeniCheni/elenchus", 1, kickoffConfig());
      return formatCheck(buildCheck(state));
    };
    expect(await run(stamp.runtime)).not.toMatch(/FAIL authors/);
    expect(await run("claude")).toMatch(/FAIL authors/);
  });

  it("refuses a seat kind that is not one of the three words", () => {
    const raw = JSON.parse(readFileSync(new URL("../examples/kickoff.elenchus.json", import.meta.url), "utf8")) as {
      passes: { seat_kind?: string }[];
    };
    const pass = raw.passes[0];
    if (!pass) throw new Error("config has no pass");
    pass.seat_kind = "both";
    expect(() => parseConfig(raw)).toThrow(/must be writing, read-only or none/);
  });

  it("runs prepareSeat through the real runner, so dropping the wrapper fails", async () => {
    const made = origin();
    const calls = vi.spyOn(gitModule, "assertGitAllowed");
    const root = path.join(made.dir, "seats-real");
    const marker = path.join(made.dir, "hook-ran");
    const template = path.join(made.dir, "template", "hooks");
    mkdirSync(template, { recursive: true });
    writeFileSync(path.join(template, "post-checkout"), `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(path.join(template, "post-checkout"), 0o755);
    const saved = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "init.templateDir";
    process.env.GIT_CONFIG_VALUE_0 = path.join(made.dir, "template");
    try {
      const report = await prepareSeat({
    seatKeychainService: seatService,
        gh: client(made.second, [seat("0", made.second)]),
        repo: "BeniCheni/elenchus",
        pr: 3,
        pass: "1",
        ...route,
        root,
        config: config(),
        cloneUrl: made.url,
      });
      expect(report.head).toBe(made.second);
      expect(existsSync(marker)).toBe(false);
      expect(calls).toHaveBeenCalled();
      await expect(defaultRun("bash", ["-c", "true"], undefined, { root, places: [] })).rejects.toThrow(/command refused: bash/);
      const env = prepGitEnv({ PATH: "/usr/bin" });
      expect(env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
      expect(env.GIT_CONFIG_VALUE_0).toBe("/dev/null");
    } finally {
      calls.mockRestore();
      if (saved.count === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = saved.count;
      if (saved.key === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = saved.key;
      if (saved.value === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = saved.value;
    }
  });
});

it("uses the preceding record's confirmed route with per-field flag overrides", async () => {
  const made = origin();
  const root = path.join(made.dir, "seats");
  const report = await prepareSeat({
    seatKeychainService: seatService,
    gh: client(made.second, [{
      ...seat("0", made.second),
      schema_version: "1.2",
      next_route: {
        runtime: "Claude Code",
        model: "claude-fable-5-2",
        effort: "medium",
        recommended_by: "planner",
        confirmed_by: "maintainer",
      },
    }]),
    repo: "BeniCheni/elenchus",
    pr: 3,
    pass: "1",
    runtime: "",
    model: "",
    effort: "high",
    confirmedBy: "",
    root,
    config: config(),
    cloneUrl: made.url,
    run: runner(root),
  });
  expect(report.launch).toContain("claude --model 'claude-fable-5-2' --effort 'high'");
  expect(JSON.parse(readFileSync(report.stamp, "utf8"))).toMatchObject({
    runtime: "Claude Code", recommended_by: "planner", confirmed_by: "maintainer",
    route_source: { runtime: "record", model: "record", effort: "flag", confirmed_by: "record" },
  });
});

it("stores only the reset and the configured seat helper and reads the pull request once", async () => {
  const made = origin();
  const root = path.join(made.dir, "seats");
  const underlying = client(made.second, [seat("0", made.second)]);
  let pulls = 0;
  const report = await prepareSeat({
    seatKeychainService: seatService,
    gh: { async get(path, options) {
      if (path.endsWith("/pulls/3")) pulls++;
      return underlying.get(path, options);
    } },
    repo: "BeniCheni/elenchus", pr: 3, pass: "1", ...route, root,
    config: config(), cloneUrl: made.url, run: runner(root),
  });
  expect(pulls).toBe(1);
  const helpers = git(report.seat, ["config", "--local", "--get-all", "credential.helper"]);
  expect(helpers.split("\n")).toEqual(["", seatCredentialArgs("--config", seatService)[3]!.slice("credential.helper=".length), ""]);
  expect(helpers).toContain("/usr/bin/security find-generic-password");
  expect(report.launch).toContain("GH_TOKEN=");
  expect(report.launch).toContain("set +x;");
  expect(report.launch).toContain("/usr/bin/security find-generic-password");
});

it("requires a named seat Keychain item before cloning", async () => {
  const made = origin();
  await expect(prepareSeat({
    gh: client(made.second, [seat("0", made.second)]),
    repo: "BeniCheni/elenchus", pr: 3, pass: "1", ...route,
    root: path.join(made.dir, "seats"), config: config(), cloneUrl: made.url, run: runner(path.join(made.dir, "seats")),
  })).rejects.toThrow(/prep requires --seat-keychain-service/);
});
