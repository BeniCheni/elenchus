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

function gh(options: { headVersion: string; baseVersion: string; changelog?: string; passes?: string[]; fail?: boolean }): GhClient {
  const passes = options.passes ?? ["0", "1", "1.5", "2", "2.5", "3", "exec"];
  const comments: GhComment[] = passes.map((pass, index) =>
    comment(
      index + 1,
      fenced({
        ...seat(pass),
        ...(options.fail && pass === "1"
          ? { model: { requested: "haiku", observed: "claude-sonnet-5-5", source: "test" } }
          : {}),
      }),
      `2026-11-14T00:00:${String(index).padStart(2, "0")}Z`,
    ),
  );
  const inner = graphGh({ head: HEAD, baseSha: BASE, comments, nodes });
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
    expect(block).toBe(
      `${[
        `gh pr merge '1' --repo 'BeniCheni/elenchus' --squash --match-head-commit '${HEAD}' --subject '${mergeSubject}'`,
        "git fetch origin main",
        "git merge --ff-only origin/main",
        `git tag -a 'v0.5.5' "$(git rev-parse origin/main)" -m '${mergeSubject}'`,
        "git push origin 'refs/tags/v0.5.5'",
        "npm run typecheck",
        "npm test",
        "npm run build",
      ].join(" &&\n")}\n`,
    );
  });

  it("refuses a head whose version did not change", async () => {
    await expect(
      buildHandoff(gh({ headVersion: "0.5.4", baseVersion: "0.5.4" }), "BeniCheni/elenchus", 1, kickoffConfig()),
    ).rejects.toThrow(/version did not change/);
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

describe("the printed block", () => {
  it("tags the squash commit and stops when a line fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "elenchus-block-"));
    scratch.push(dir);
    const src = path.join(dir, "src");
    mkdirSync(src);
    git(src, ["init", "-b", "main"]);
    writeFileSync(path.join(src, "README.md"), "base\n");
    git(src, ["add", "README.md"]);
    git(src, ["commit", "-m", "base"]);
    const base = git(src, ["rev-parse", "HEAD"]).trim();
    writeFileSync(path.join(src, "README.md"), "feature\n");
    git(src, ["add", "README.md"]);
    git(src, ["commit", "-m", "feature"]);
    const feature = git(src, ["rev-parse", "HEAD"]).trim();
    git(src, ["branch", "feature"]);
    const bare = path.join(dir, "origin.git");
    git(dir, ["clone", "--bare", src, bare]);
    git(bare, ["update-ref", "refs/heads/main", base]);
    const checkout = path.join(dir, "checkout");
    git(dir, ["clone", bare, checkout]);
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const npmLog = path.join(dir, "npm.log");
    writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\nif [ "$FAIL_MERGE" = 1 ]; then exit 1; fi\nparent=$(git --git-dir="$ORIGIN" rev-parse refs/heads/main)\ntree=$(git --git-dir="$ORIGIN" rev-parse 'refs/heads/feature^{tree}')\nnew=$(git --git-dir="$ORIGIN" commit-tree "$tree" -p "$parent" -m squash)\ngit --git-dir="$ORIGIN" update-ref refs/heads/main "$new"\nexit 0\n`,
    );
    writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$NPM_LOG"\nexit 0\n`);
    chmodSync(path.join(bin, "gh"), 0o755);
    chmodSync(path.join(bin, "npm"), 0o755);
    const block = await buildHandoff(
      gh({ headVersion: "0.5.5", baseVersion: "0.5.4" }),
      "BeniCheni/elenchus",
      1,
      kickoffConfig(),
    );
    const env = {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      ORIGIN: bare,
      NPM_LOG: npmLog,
      FAIL_MERGE: "1",
    };
    expect(() => execFileSync("sh", ["-c", block], { cwd: checkout, env: { ...process.env, ...env } })).toThrow();
    expect(existsSync(npmLog)).toBe(false);
    expect(() => git(checkout, ["rev-parse", "refs/tags/v0.5.5"])).toThrow();

    env.FAIL_MERGE = "0";
    execFileSync("sh", ["-c", block], {
      cwd: checkout,
      env: {
        ...process.env,
        ...env,
        GIT_AUTHOR_NAME: "Cursor",
        GIT_AUTHOR_EMAIL: "cursoragent@cursor.com",
        GIT_COMMITTER_NAME: "Cursor",
        GIT_COMMITTER_EMAIL: "cursoragent@cursor.com",
      },
    });
    const tagged = git(checkout, ["rev-parse", "v0.5.5^{}"]).trim();
    const originMain = git(bare, ["rev-parse", "refs/heads/main"]).trim();
    const originTag = git(bare, ["rev-parse", "refs/tags/v0.5.5^{}"]).trim();
    expect(tagged).toBe(originMain);
    expect(originTag).toBe(originMain);
    expect(originMain).not.toBe(base);
    expect(originMain).not.toBe(feature);
    expect(readFileSync(npmLog, "utf8")).toBe("run typecheck\ntest\nrun build\n");
  });
});
