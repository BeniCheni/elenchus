import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHandoff, changelogSubject } from "../src/handoff.js";
import type { GhClient } from "../src/gh.js";
import type { GhComment, SeatRecord } from "../src/types.js";
import { comment, fenced, graphGh, kickoffConfig, type Node } from "./graph.js";

const CLAUDE = "Claude <noreply@anthropic.com>";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const nodes: Record<string, Node> = {
  [BASE]: { parents: [], author: CLAUDE },
  [HEAD]: { parents: [BASE], author: CLAUDE },
};

const changelog = `# Changelog

## [0.5.4] — 2026-11-14

The previous release.

## [0.5.5] — 2026-11-14

The clearing: the Broadcast lens, Where to Watch and the Monthly view are retired, and the fixtures start higher on the page.

### Changed

- A line.
`;

function seat(pass: string): SeatRecord {
  return {
    seat_record: 1,
    pr: 1,
    pass,
    runtime: "Claude Code",
    model: { requested: "claude-fable-5-2", observed: "claude-fable-5-2", source: "test" },
    effort: { requested: "xhigh", observed: "xhigh", source: "test" },
    route: { recommended_by: "PM", confirmed_by: "Beni", by_hand: true },
    posted_by: "BeniCheni",
    input_sha: HEAD,
    output_sha: HEAD,
    commits: [],
    findings: [],
    verdict: "ok",
  };
}

function gh(options: { headVersion: string; baseVersion: string; changelog?: string; passes?: string[]; fail?: boolean; records?: SeatRecord[]; nodes?: Record<string, Node> }): GhClient {
  const passes = options.passes ?? ["0", "1", "1.5", "2", "2.5", "3", "exec"];
  const records = options.records ?? passes.map((pass) => seat(pass));
  const comments: GhComment[] = records.map((record, index) =>
    comment(
      index + 1,
      fenced({
        ...record,
        ...(options.fail && record.pass === "1"
          ? { model: { requested: "haiku", observed: "claude-sonnet-5-5", source: "test" } }
          : {}),
      }),
      `2026-11-14T00:00:${String(index).padStart(2, "0")}Z`,
    ),
  );
  const inner = graphGh({ head: HEAD, baseSha: BASE, comments, nodes: options.nodes ?? nodes });
  const encoded = (text: string) => Buffer.from(text).toString("base64");
  return {
    async get(apiPath, getOptions) {
      if (apiPath.includes("/contents/package.json")) {
        const version = apiPath.includes(`ref=${HEAD}`) ? options.headVersion : options.baseVersion;
        return { content: encoded(JSON.stringify({ version })), encoding: "base64" };
      }
      if (apiPath.includes("/contents/CHANGELOG.md")) {
        return { content: encoded(options.changelog ?? changelog), encoding: "base64" };
      }
      return inner.get(apiPath, getOptions);
    },
  };
}

const subject = "The clearing: the Broadcast lens, Where to Watch and the Monthly view are retired, and the fixtures start higher on the page.";

describe("handoff", () => {
  it("prints the block and runs nothing", async () => {
    expect(changelogSubject(changelog, "## [0.5.5]")).toBe(subject);
    const block = await buildHandoff(gh({ headVersion: "0.5.5", baseVersion: "0.5.4" }), "BeniCheni/elenchus", 1, kickoffConfig());
    const mergeSubject = `v0.5.5 — ${subject}`;
    expect(block).toContain(`gh pr merge '1' --repo 'BeniCheni/elenchus' --squash --match-head-commit '${HEAD}' --subject '${mergeSubject}' --body 'Pass 0`);
    expect(block).toContain(`git tag -a 'v0.5.5' "$merge_commit" -m '${mergeSubject}'`);
    expect(block).toContain("git push origin 'refs/tags/v0.5.5'");
    expect(block).toMatch(/npm run typecheck &&\nnpm test &&\nnpm run build\n$/);
  });

  it("refuses a head whose version did not change", async () => {
    await expect(
      buildHandoff(gh({ headVersion: "0.5.4", baseVersion: "0.5.4" }), "BeniCheni/elenchus", 1, kickoffConfig()),
    ).rejects.toThrow(/version did not change/);
  });

  it("names the configuration field when the merge command omits the body", async () => {
    const config = kickoffConfig();
    config.handoff!.merge_command = "gh pr merge {pr} --subject {merge_message}";
    await expect(buildHandoff(gh({ headVersion: "2", baseVersion: "1" }), "BeniCheni/elenchus", 1, config))
      .rejects.toThrow("config.handoff.merge_command must include {merge_body}");
  });

  it("refuses incomplete commit attribution", async () => {
    const inner = gh({ headVersion: "2", baseVersion: "1" });
    const partial: GhClient = { async get(apiPath, options) {
      if (apiPath.includes("/compare/") && options?.paginate) return { commits: [], total_commits: 2 };
      return inner.get(apiPath, options);
    } };
    await expect(buildHandoff(partial, "BeniCheni/elenchus", 1, kickoffConfig(), "Release"))
      .rejects.toThrow("incomplete PR comparison");
  });

  it("refuses a review whose check fails, and a pass with no record", async () => {
    await expect(
      buildHandoff(gh({ headVersion: "0.5.5", baseVersion: "0.5.4", fail: true }), "BeniCheni/elenchus", 1, kickoffConfig()),
    ).rejects.toThrow(/check failed[\s\S]*FAIL route/);
    await expect(
      buildHandoff(
        gh({ headVersion: "0.5.5", baseVersion: "0.5.4", passes: ["0", "1", "2"] }),
        "BeniCheni/elenchus",
        1,
        kickoffConfig(),
      ),
    ).rejects.toThrow(/no valid record for pass 1\.5/);
  });

  it("refuses a changelog with no section for the new version", async () => {
    await expect(
      buildHandoff(
        gh({ headVersion: "0.5.5", baseVersion: "0.5.4", changelog: "## [0.5.4] — 2026-11-14\n\nOld.\n" }),
        "BeniCheni/elenchus",
        1,
        kickoffConfig(),
      ),
    ).rejects.toThrow(/changelog has no section for 0\.5\.5/);
  });

  it("skips a sub-heading and does not cut the sentence at vs.", () => {
    const text = "## [0.5.5] — 2026-11-14\n\n### Added\n\nBroadcast vs. the Monthly view stays.\n";
    expect(changelogSubject(text, "## [0.5.5]")).toBe("Broadcast vs. the Monthly view stays.");
  });

  it("uses a --subject override", async () => {
    const block = await buildHandoff(
      gh({ headVersion: "0.5.5", baseVersion: "0.5.4" }),
      "BeniCheni/elenchus",
      1,
      kickoffConfig(),
      "Chosen subject",
    );
    expect(block).toContain("--subject 'v0.5.5 — Chosen subject'");
    expect(block).toContain("-m 'v0.5.5 — Chosen subject'");
  });

  it("refuses a head that is not the last recorded output", async () => {
    const newer = "d".repeat(40);
    const passes = ["0", "1", "1.5", "2", "2.5", "3", "exec"];
    const comments: GhComment[] = passes.map((pass, index) =>
      comment(index + 1, fenced(seat(pass)), `2026-11-14T00:00:${String(index).padStart(2, "0")}Z`),
    );
    const moved: Record<string, Node> = { ...nodes, [newer]: { parents: [HEAD], author: CLAUDE } };
    await expect(
      buildHandoff(graphGh({ head: newer, baseSha: BASE, comments, nodes: moved }), "BeniCheni/elenchus", 1, kickoffConfig()),
    ).rejects.toThrow(new RegExp(`head ${newer} is not the last recorded output_sha ${HEAD}`));
  });
});

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Cursor",
      GIT_AUTHOR_EMAIL: "cursoragent@cursor.com",
      GIT_COMMITTER_NAME: "Cursor",
      GIT_COMMITTER_EMAIL: "cursoragent@cursor.com",
      ...env,
    },
  });
}

const releaseBody = [
  "Pass brief — cold read, seat reviewer — Claude Code, model claude-haiku-5-5, effort xhigh requested (observed: null, source: operator's log) (3 records)",
  "Pass ship — ruling, seat owner — Notes, model notes-model requested (observed: null, source: chat log), effort medium",
  "",
  "Co-authored-by: Cursor <cursoragent@cursor.com>",
  "Co-authored-by: Claude <noreply@anthropic.com>",
].join("\n");

function releaseReview() {
  const config = kickoffConfig();
  config.passes = [
    { id: "brief", role: "cold\r\nread", seat: "reviewer" },
    { id: "ship", role: "ruling", seat: "owner" },
  ];
  delete config.finding_flow;
  const alias = "Builder <builder@example.com>";
  const cursor = config.vendors.cursor!;
  cursor.authors.push(alias);
  config.vendors = {
    cursor, codex: config.vendors.codex!, claude: config.vendors.claude!,
    other: { ...cursor, runtimes: [] },
    notes: { authors: [], runtimes: ["Notes"], models: {}, efforts: { medium: ["medium"] } },
  };
  const early = "a".repeat(40);
  const original: SeatRecord = {
    ...seat("brief"), schema_version: "1.2", input_sha: early, output_sha: early, runtime: "Codex",
    model: { requested: "gpt-6.1-sol", observed: "gpt-6.1-sol" },
  };
  const reread: SeatRecord = {
    ...seat("brief"), schema_version: "1.2", reread: true,
    model: { requested: "haiku", observed: "claude-haiku-5-5" },
    effort: { requested: "xhigh", observed: null, source: "operator's log" },
  };
  const ship: SeatRecord = {
    ...seat("ship"), schema_version: "1.2", runtime: "Notes",
    model: { requested: "notes-model", observed: null, source: "chat log" },
    effort: { requested: "medium", observed: "medium" },
  };
  const client = gh({
    headVersion: "0.5.5", baseVersion: "0.5.4", records: [original, { ...original, verdict: "corrected" }, reread, ship],
    nodes: {
      [BASE]: { parents: [], author: "Codex <noreply@openai.com>" },
      [early]: { parents: [BASE], author: alias },
      [HEAD]: { parents: [early], author: "Owner <owner@example.com>" },
    },
  });
  return buildHandoff(client, "BeniCheni/elenchus", 1, config);
}

describe("the printed block", () => {
  it("passes the standing records as one body and tags the PR squash even when the base advances", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "elenchus-block-"));
    scratch.push(dir);
    const src = path.join(dir, "src");
    mkdirSync(src);
    git(src, ["init", "-b", "replay/main"]);
    writeFileSync(path.join(src, "README.md"), "base\n");
    git(src, ["add", "README.md"]);
    git(src, ["commit", "-m", "base"]);
    const base = git(src, ["rev-parse", "HEAD"]).trim();
    writeFileSync(path.join(src, "README.md"), "feature\n");
    git(src, ["commit", "-am", "feature"]);
    const feature = git(src, ["rev-parse", "HEAD"]).trim();
    git(src, ["branch", "feature"]);
    const bare = path.join(dir, "origin.git");
    git(dir, ["clone", "--bare", src, bare]);
    git(bare, ["update-ref", "refs/heads/replay/main", base]);
    const checkout = path.join(dir, "checkout");
    git(dir, ["clone", bare, checkout]);
    git(checkout, ["switch", "-c", "operator"]);
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const stub = (name: string, script: string) => {
      const file = path.join(bin, name);
      writeFileSync(file, "#!/bin/sh\nset -eu\n" + script);
      chmodSync(file, 0o755);
    };
    stub("gh", `
case "$1 $2" in
  "pr merge")
    [ "$FAIL_MERGE" = 0 ] || exit 1
    shift 2
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --body ]; then printf '%s' "$2" > "$LOG/body"; break; fi
      shift
    done
    [ "$QUEUED" = 0 ] || exit 0
    tree=$(git --git-dir="$ORIGIN" rev-parse 'feature^{tree}')
    squash=$(git --git-dir="$ORIGIN" commit-tree "$tree" -p "$BASE" -m squash)
    sync=$(git --git-dir="$ORIGIN" commit-tree "$tree" -p "$squash" -m sync)
    git --git-dir="$ORIGIN" update-ref refs/heads/replay/main "$sync"
    printf '%s' "$squash" > "$LOG/squash" ;;
  "pr view")
    [ "$#" = 9 ] && [ "$3" = 1 ] && [ "$4" = --repo ] && [ "$5" = BeniCheni/elenchus ] &&
      [ "$6" = --json ] && [ "$7" = mergeCommit ] && [ "$8" = --jq ] && [ "$9" = '.mergeCommit.oid // empty' ] || exit 2
    if [ "$QUEUED" = 0 ]; then cat "$LOG/squash"; fi ;;
  *) exit 2 ;;
esac
`);
    stub("git", `printf '%s\\n' "$*" >> "$LOG/git"\nexec "$REAL_GIT" "$@"\n`);
    stub("npm", `printf '%s\\n' "$*" >> "$LOG/npm"\n`);
    const env = {
      ...process.env,
      REAL_GIT: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, LOG: dir, ORIGIN: bare, BASE: base,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const block = await releaseReview();
    const tags = () => git(checkout, ["tag", "--list"]);
    expect(tags()).toBe("");
    const run = (fail: string, queued: string) => execFileSync("sh", ["-c", block], {
      cwd: checkout, env: { ...env, FAIL_MERGE: fail, QUEUED: queued },
    });
    expect(() => run("1", "0")).toThrow();
    expect(() => run("0", "1")).toThrow();
    expect(tags()).toBe("");
    expect(existsSync(path.join(dir, "npm"))).toBe(false);
    expect(existsSync(path.join(dir, "git"))).toBe(false);

    run("0", "0");
    const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
    expect(read("body")).toBe(releaseBody);
    const squash = read("squash");
    const tip = git(bare, ["rev-parse", "refs/heads/replay/main"]).trim();
    expect(tip).not.toBe(squash);
    expect(squash).not.toBe(feature);
    expect(read("git").split("\n")).toEqual(expect.arrayContaining([
      "fetch origin refs/heads/replay/main:refs/remotes/origin/replay/main",
      "merge --ff-only refs/remotes/origin/replay/main",
      `tag -a v0.5.5 ${squash} -m v0.5.5 — ${subject}`,
    ]));
    expect(git(checkout, ["branch", "--show-current"]).trim()).toBe("replay/main");
    expect(git(checkout, ["rev-parse", "HEAD"]).trim()).toBe(tip);
    expect(git(checkout, ["rev-parse", "v0.5.5^{}"]).trim()).toBe(squash);
    expect(git(bare, ["rev-parse", "refs/tags/v0.5.5^{}"]).trim()).toBe(squash);
    expect(read("npm")).toBe("run typecheck\ntest\nrun build\n");
  });
});
