import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GhClient } from "../src/gh.js";
import { formatCheck, formatStatus } from "../src/format.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";

const dir = fileURLToPath(new URL("./fixtures/replay-p9/", import.meta.url));

function fixtureGh(): GhClient {
  return {
    async get(apiPath) {
      const file = path.join(dir, `${encodeURIComponent(apiPath)}.json`);
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    },
  };
}

describe("captured replay at P9", () => {
  it("reproduces status and check without GitHub", async () => {
    const state = await loadReview(fixtureGh(), "BeniCheni/elenchus", 1, undefined, { gateStatus: true });
    const status = formatStatus(buildStatus(state));
    const check = formatCheck(buildCheck(state));
    expect(status).toBe(readFileSync(path.join(dir, "status.txt"), "utf8"));
    expect(check).toBe(readFileSync(path.join(dir, "check.txt"), "utf8"));
    expect(check).not.toMatch(/FAIL /);
    expect(status).toContain("next: authorize");
    expect(state.passes.every((pass) => pass.outcome.kind === "recorded")).toBe(true);
  });
});
