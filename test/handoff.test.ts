import { describe, expect, it } from "vitest";
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
    expect(block).toBe(
      [
        `gh pr merge '1' --squash --subject '${subject}'`,
        `git tag -a 'v0.5.5' -m 'v0.5.5 — ${subject}'`,
        "git push origin 'v0.5.5'",
        "git pull",
        "npm run typecheck",
        "npm test",
        "npm run build",
        "",
      ].join("\n"),
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
});
