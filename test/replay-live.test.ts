import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GhCompare } from "../src/types.js";
import type { GhClient } from "../src/gh.js";
import { formatCheck, formatStatus } from "../src/format.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";

const dir = fileURLToPath(new URL("./fixtures/replay-p9/", import.meta.url));

function archived<T>(apiPath: string): T {
  return JSON.parse(readFileSync(path.join(dir, `${encodeURIComponent(apiPath)}.json`), "utf8")) as T;
}

function fixtureGh(): GhClient {
  const repo = "/repos/BeniCheni/elenchus";
  const { sha: base } = archived<{ sha: string }>(`${repo}/commits/replay/main`);
  // The old capture answered ancestry one commit at a time. Adapt it until the new base is captured.
  return {
    async get(apiPath) {
      if (apiPath === `${repo}/commits/heads%2Freplay%2Fmain`) return { sha: base };
      if (apiPath === `${repo}/contents/.elenchus.json?ref=${base}`) {
        return archived(`${repo}/contents/.elenchus.json?ref=replay/main`);
      }
      const unpaged = apiPath.replace(/\?per_page=100$/, "");
      const tip = unpaged.startsWith(`${repo}/compare/${base}...`)
        ? unpaged.slice(`${repo}/compare/${base}...`.length)
        : null;
      if (tip) {
        const ranges = [["0faf606", "89b8067"], ["89b8067", "09324fb"], ["09324fb", "dcb914e"]];
        const commits: NonNullable<GhCompare["commits"]> = [];
        for (const [input, output] of ranges) {
          const range = archived<GhCompare>(`${repo}/compare/${input}...${output}`);
          for (const commit of range.commits ?? []) {
            const ancestry = archived<GhCompare>(`${repo}/compare/${commit.sha}...${base}`);
            if (ancestry.status !== "ahead" && ancestry.status !== "identical") commits.push(commit);
          }
          if (tip === output) break;
        }
        return { status: "diverged", commits, total_commits: commits.length };
      }
      return archived(apiPath.includes("/compare/") ? unpaged : apiPath);
    },
  };
}

describe("captured replay at P9", () => {
  it("reproduces status and check without GitHub", async () => {
    const state = await loadReview(fixtureGh(), "BeniCheni/elenchus", 1);
    const status = formatStatus(buildStatus(state));
    const check = formatCheck(buildCheck(state));
    expect(status).toBe(readFileSync(path.join(dir, "status.txt"), "utf8").replace("Sprint 3 builds authorize", "no gate configured"));
    const lines = check.split("\n");
    expect(lines.filter((line) => line.startsWith("FAIL pr "))).toHaveLength(7);
    expect(lines.filter((line) => !line.startsWith("FAIL pr ")).join("\n"))
      .toBe(readFileSync(path.join(dir, "check.txt"), "utf8"));
    expect(status).toContain("next: authorize");
    expect(state.passes.every((pass) => pass.outcome.kind === "recorded")).toBe(true);
  });
});
