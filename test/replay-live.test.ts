import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GhClient } from "../src/gh.js";
import { formatCheck, formatStatus } from "../src/format.js";
import { checkHead } from "../src/gate-review.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";

const dir = fileURLToPath(new URL("./fixtures/replay-p9/", import.meta.url));

function fixtureGh(calls: string[]): GhClient {
  return {
    async get(apiPath) {
      calls.push(apiPath);
      const file = path.join(dir, `${encodeURIComponent(apiPath)}.json`);
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    },
  };
}

describe("captured replay at P9", () => {
  it("reproduces status and check without GitHub", async () => {
    const calls: string[] = [];
    const gh = fixtureGh(calls);
    const state = await loadReview(gh, "BeniCheni/elenchus", 1, undefined, { gateStatus: true });
    const status = formatStatus(buildStatus(state));
    const check = formatCheck([...buildCheck(state), ...await checkHead(gh, state)]);
    // Keep the full comparison against the new decision until the separate P9 recapture.
    const oldStatus = readFileSync(path.join(dir, "status.txt"), "utf8");
    expect(status).toBe(oldStatus.replace(
      /next: 3\nseat: Beni\nrole: adjudication\nblocked: contested finding 6 needs a ruling in pass 3\n$/,
      "next: 2.5\nseat: PM\nrole: synthesis\nblocked: authorize requires a schema v1.2 record\n",
    ));
    expect(check).toBe(readFileSync(path.join(dir, "check.txt"), "utf8"));
    expect(check.match(/^FAIL head \w{7}/gm)).toEqual(["FAIL head 217189c", "FAIL head 188b909"]);
    expect(check.match(/^NOTICE head \w{7}/gm)).toEqual(["NOTICE head 8ea93e2", "NOTICE head 7b7da6b", "NOTICE head dcb914e"]);
    expect(calls.filter((path) => path.includes("/compare/09324fb...dcb914e"))).toHaveLength(1);
    expect(status).toMatch(/next: 2\.5\n[\s\S]*blocked: authorize requires a schema v1\.2 record\n$/);
    expect(state.passes.every((pass) => pass.outcome.kind === "recorded")).toBe(true);
  });
});
