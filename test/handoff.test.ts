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
      if (apiPath.startsWith("/repos/BeniCheni/elenchus/git/ref/tags/")) throw new Error("gh: Not Found (HTTP 404)");
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

  it.each([
    ["existing tag", null, "tag v2 already exists"],
    ["unreadable tag", "gh: Forbidden (HTTP 403)", "cannot establish whether tag v2 exists"],
    ["mixed diagnostic", "connection failed after (HTTP 404)", "cannot establish whether tag v2 exists"],
  ] as const)("refuses an %s at print time", async (_scenario, failure, message) => {
    const inner = gh({ headVersion: "2", baseVersion: "1" });
    const client: GhClient = { async get(apiPath, options) {
      if (apiPath === "/repos/BeniCheni/elenchus/git/ref/tags/v2") {
        if (failure) throw new Error(failure);
        return { ref: "refs/tags/v2" };
      }
      return inner.get(apiPath, options);
    } };
    await expect(buildHandoff(client, "BeniCheni/elenchus", 1, kickoffConfig(), "Release")).rejects.toThrow(message);
  });

  it.each(["section_heading", "merge_command", "merge_message", "tag_message", "tag", "green"] as const)(
    "names the handoff field %s when its template contains a control", async (field) => {
      const config = kickoffConfig();
      if (field === "green") config.handoff!.green[0] += "\u009b";
      else config.handoff![field] += "\u009b";
      const client = gh({ headVersion: "2", baseVersion: "1" });
      await expect(buildHandoff(client, "BeniCheni/elenchus", 1, config, "Release"))
        .rejects.toThrow("config.handoff." + (field === "green" ? "green[0]" : field) + " contains a control character");
    },
  );

  it("folds record, changelog and version controls wherever they enter the block", async () => {
    const config = kickoffConfig();
    config.passes = [{ id: "0", role: "brief", seat: "operator" }];
    config.handoff!.merge_command += " {subject} {version} {tag}";
    const record = { ...seat("0"), model: { requested: "haiku", observed: null, source: "log\x1b\0end" } };
    const version = "2\u0085\u2029x";
    const client = gh({ headVersion: version, baseVersion: "1", records: [record],
      changelog: "## [" + version + "]\n\nRelease\x1b[1A\x1b[2K\x07now.\n" });
    const block = await buildHandoff(client, "BeniCheni/elenchus", 1, config);
    expect(block).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/);
    expect(block).toContain("source: log end)");
    expect(block).toContain("--subject 'v2 x — Release [1A [2K now.'");
    expect(block).toContain("-m 'v2 x — Release [1A [2K now.'");
    expect(block).toContain("'Release [1A [2K now.' '2 x' 'v2 x'");
    expect(block).toContain("refs/tags/v2 x");
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

  it.each([{ total_commits: 0 }, { commits: [], total_commits: 2 }])("refuses incomplete commit attribution %j", async (range) => {
    const inner = gh({ headVersion: "2", baseVersion: "1" });
    const partial: GhClient = { async get(apiPath, options) {
      if (apiPath.includes("/compare/") && options?.paginate) return range;
      return inner.get(apiPath, options);
    } };
    await expect(buildHandoff(partial, "BeniCheni/elenchus", 1, kickoffConfig(), "Release"))
      .rejects.toThrow("incomplete PR comparison");
  });

  it("prints absent legacy route evidence and ends at the last pass when nobody has a trailer", async () => {
    const config = kickoffConfig();
    config.passes = [{ id: "0", role: "brief", seat: "operator" }];
    config.vendors.claude!.authors = [];
    const record = { ...seat("0"), model: { requested: null, observed: null } };
    const block = await buildHandoff(gh({ headVersion: "2", baseVersion: "1", records: [record] }),
      "BeniCheni/elenchus", 1, config, "Release");
    expect(block).toContain("--body 'Pass 0 — brief, seat operator — Claude Code, model unspecified requested (observed: null, source: absent), effort xhigh' &&\n");
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
  "Pass ship — ruling, seat owner — Grok, model grok-4.7 requested (observed: null, source: chat log), effort medium",
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
  cursor.authors[0] = "Cursor\n<cursoragent@cursor.com>";
  cursor.authors.push(alias);
  config.vendors = {
    cursor, other: { ...cursor, runtimes: [] },
    codex: config.vendors.codex!, claude: config.vendors.claude!,
    xai: config.vendors.xai!,
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
    ...seat("ship"), schema_version: "1.2", runtime: "Grok",
    model: { requested: "grok-4.7", observed: null, source: "chat log" },
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

function blockCheckout() {
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
  echo called >> "$LOG/merge-calls"
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
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (block: string, fail = "0", queued = "0") => execFileSync("sh", ["-c", block], {
    cwd: checkout, env: { ...env, FAIL_MERGE: fail, QUEUED: queued }, stdio: "pipe",
  });
  return { dir, checkout, bare, base, feature, run };
}

describe("the printed block", () => {
  it.each(["base in another worktree", "dirty file changed by merge"])("pushes the squash tag before handling a %s", async (scenario) => {
    const { dir, checkout, bare, run } = blockCheckout();
    if (scenario === "base in another worktree") git(checkout, ["worktree", "add", path.join(dir, "second"), "replay/main"]);
    else writeFileSync(path.join(checkout, "README.md"), "uncommitted edit\n");
    const block = await releaseReview();
    expect(() => run(block)).toThrow();
    const squash = readFileSync(path.join(dir, "squash"), "utf8");
    expect(git(bare, ["rev-parse", "refs/tags/v0.5.5^{}"]).trim()).toBe(squash);
  });

  it.each(["local tag", "late origin tag", "unreadable origin", "separate push URL", "two push URLs",
    "push URL with trailing LF", "shared URL with embedded LF", "shared URL with horizontal tab",
    "shared URL with C1 control", "shared URL with Unicode line separator"])("stops before merge for %s", async (scenario) => {
    const { dir, checkout, bare, base, run } = blockCheckout();
    const block = await releaseReview();
    const tag = "refs/tags/v0.5.5";
    const other = path.join(dir, "publish.git");
    switch (scenario) {
      case "local tag": git(checkout, ["update-ref", tag, base]); break;
      case "late origin tag": git(bare, ["update-ref", tag, base]); break;
      case "unreadable origin": git(checkout, ["remote", "set-url", "origin", other]); break;
      case "separate push URL":
        git(dir, ["clone", "--bare", bare, other]);
        git(other, ["update-ref", tag, base]);
        git(checkout, ["remote", "set-url", "--push", "origin", other]);
        break;
      case "two push URLs":
        for (const url of [bare, other]) git(checkout, ["remote", "set-url", "--add", "--push", "origin", url]);
        break;
      case "push URL with trailing LF": git(checkout, ["remote", "set-url", "--push", "origin", bare + "\n"]); break;
      default: {
        const separator = { "shared URL with embedded LF": "\n", "shared URL with horizontal tab": "\t",
          "shared URL with C1 control": "\u009b", "shared URL with Unicode line separator": "\u2028" }[scenario]!;
        const shared = path.join(dir, "origin" + separator + "repo.git");
        git(dir, ["clone", "--bare", bare, shared]);
        git(checkout, ["remote", "set-url", "origin", shared]);
      }
    }
    expect(() => run(block, "1")).toThrow();
    expect(existsSync(path.join(dir, "merge-calls"))).toBe(false);
  });

  it("passes the standing records as one body and tags the PR squash even when the base advances", async () => {
    const { dir, checkout, bare, feature, run } = blockCheckout();
    const block = await releaseReview();
    const tags = () => git(checkout, ["tag", "--list"]);
    expect(tags()).toBe("");
    expect(() => run(block, "1")).toThrow();
    expect(() => run(block, "0", "1")).toThrow();
    expect(tags()).toBe("");
    expect(existsSync(path.join(dir, "npm"))).toBe(false);
    expect(readFileSync(path.join(dir, "git"), "utf8")).not.toMatch(/^(fetch|switch|merge|tag|push) /m);

    run(block);
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
