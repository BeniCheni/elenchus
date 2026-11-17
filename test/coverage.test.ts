import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { formatCheck } from "../src/format.js";
import { recordingGh, type GhClient } from "../src/gh.js";
import { loadReview } from "../src/load.js";
import { buildCheck } from "../src/report.js";
import type { GhCompare, SeatRecord } from "../src/types.js";
import { comment, fenced, graphGh, kickoffConfig, type Node } from "./graph.js";

const CLAUDE = "Claude <noreply@anthropic.com>";
const A = "a".repeat(40);
const B = "b".repeat(40);
const nodes: Record<string, Node> = {
  [A]: { parents: [], author: CLAUDE },
  [B]: { parents: [A], author: CLAUDE },
};

const files = readFileSync(new URL("./fixtures/manifest-0faf606.txt", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const tab = line.indexOf("\t");
    const status = line.slice(0, tab);
    const filename = line.slice(tab + 1);
    const name = status === "A" ? "added" : status === "D" ? "removed" : "modified";
    return { status: name, filename };
  });

const deletions = files.filter((file) => file.status === "removed").map((file) => file.filename);
const month = "src/components/MonthView.tsx";

function seat(over: Partial<SeatRecord> & Pick<SeatRecord, "pass">): SeatRecord {
  return {
    seat_record: 1,
    pr: 1,
    runtime: "Claude Code",
    model: { requested: "claude-fable-5-2", observed: "claude-fable-5-2", source: "test" },
    effort: { requested: "xhigh", observed: "xhigh", source: "test" },
    route: { recommended_by: "PM", confirmed_by: "Beni", by_hand: true },
    posted_by: "BeniCheni",
    input_sha: A,
    output_sha: A,
    commits: [],
    findings: [],
    verdict: "ok",
    ...over,
  };
}

async function check(coverage?: SeatRecord["coverage"]): Promise<string> {
  const pass1 = seat({
    pass: "1",
    input_sha: B,
    output_sha: B,
    ...(coverage ? { coverage } : {}),
  });
  const comments = [
    comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
    comment(2, fenced(pass1), "2026-11-14T00:00:02Z"),
  ];
  const inner = graphGh({ head: B, baseSha: A, comments, nodes });
  const client: GhClient = {
    async get(apiPath, options) {
      const value = await inner.get(apiPath, options);
      if (apiPath.includes("/compare/") && coverage) return { ...(value as GhCompare), files };
      return value;
    },
  };
  const state = await loadReview(client, "BeniCheni/elenchus", 1, kickoffConfig());
  return formatCheck(buildCheck(state));
}

const matching = {
  total: files.length,
  reviewed: files.length - deletions.length,
  skipped: deletions.map((file) => ({ path: file, reason: "deleted" })),
};

describe("coverage rule", () => {
  it("passes a Pass 1 record that matches the 57-path manifest", async () => {
    expect(files).toHaveLength(57);
    expect(deletions).toHaveLength(3);
    const report = await check(matching);
    expect(report).not.toMatch(/FAIL coverage/);
  });

  it("fails and names a skipped path that was deleted from the record", async () => {
    const dropped = {
      ...matching,
      skipped: matching.skipped.filter((skip) => skip.path !== month),
    };
    const report = await check(dropped);
    expect(report).toMatch(/FAIL coverage pass 1/);
    expect(report).toContain(month);
    expect(report).toMatch(/reviewed 54 \+ skipped 2 is not total 57/);
  });

  it("names a skipped path that is not in the manifest, and an empty reason", async () => {
    const outsider = {
      ...matching,
      total: 58,
      reviewed: 54,
      skipped: [...matching.skipped, { path: "ghost.ts", reason: "not in the diff" }],
    };
    const named = await check(outsider);
    expect(named).toMatch(/FAIL coverage pass 1 .*skipped ghost\.ts is not in the manifest/);
    const empty = {
      ...matching,
      skipped: matching.skipped.map((skip) => (skip.path === month ? { path: month, reason: " " } : skip)),
    };
    const blank = await check(empty);
    expect(blank).toMatch(new RegExp(`FAIL coverage pass 1 .*skipped ${month} has no reason`));
  });

  it("fails a duplicate skipped path, and counts distinct paths", async () => {
    const duplicated = {
      ...matching,
      skipped: [...matching.skipped, { path: month, reason: "deleted again" }],
    };
    const report = await check(duplicated);
    expect(report).toMatch(new RegExp(`FAIL coverage pass 1 .*skipped ${month} is listed more than once`));
    expect(report).not.toMatch(/reviewed 54 \+ skipped/);
  });

  it("fails when the reported total is not the manifest's size", async () => {
    const report = await check({ ...matching, total: 999, reviewed: 996 });
    expect(report).toMatch(/total 999 is not the manifest's 57/);
  });

  it("leaves a marked record with no coverage unverified", async () => {
    const report = await check();
    expect(report).toMatch(/UNVERIFIED coverage pass 1 .*coverage not reported/);
    expect(report).not.toMatch(/FAIL coverage/);
  });

  it("fails closed when the compare has no file list", async () => {
    const comments = [
      comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({ pass: "1", input_sha: B, output_sha: B, coverage: matching })), "2026-11-14T00:00:02Z"),
    ];
    const state = await loadReview(graphGh({ head: B, baseSha: A, comments, nodes }), "BeniCheni/elenchus", 1, kickoffConfig());
    const report = formatCheck(buildCheck(state));
    expect(report).toMatch(/FAIL coverage pass 1 .*file list truncated/);
  });

  it("still checks a configuration that has none of the new fields", async () => {
    const raw = JSON.parse(readFileSync(new URL("../examples/kickoff.elenchus.json", import.meta.url), "utf8")) as {
      passes: Record<string, unknown>[];
      vendors: Record<string, Record<string, unknown>>;
      forbidden?: unknown;
      installs?: unknown;
      handoff?: unknown;
    };
    delete raw.forbidden;
    delete raw.installs;
    delete raw.handoff;
    for (const pass of raw.passes) {
      delete pass.seat_kind;
      delete pass.coverage;
    }
    for (const vendor of Object.values(raw.vendors)) {
      delete vendor.read_only_seat;
      delete vendor.binary;
    }
    const config = parseConfig(raw);
    const comments = [comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z")];
    const state = await loadReview(graphGh({ head: A, baseSha: A, comments, nodes }), "BeniCheni/elenchus", 1, config);
    expect(formatCheck(buildCheck(state))).not.toMatch(/coverage/);
  });

  it("records a covered review and replays the same check", async () => {
    const compared = [
      { filename: "new.ts", status: "renamed", previous_filename: "old.ts", patch: `diff --git a/old.ts\n${"x".repeat(80)}` },
      { filename: "keep.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" },
    ];
    const coverage = { total: 3, reviewed: 3, skipped: [] as { path: string; reason: string }[] };
    const comments = [
      comment(1, fenced(seat({ pass: "0" })), "2026-11-14T00:00:01Z"),
      comment(2, fenced(seat({ pass: "1", input_sha: B, output_sha: B, coverage })), "2026-11-14T00:00:02Z"),
    ];
    const inner = graphGh({ head: B, baseSha: A, comments, nodes });
    const full: GhClient = {
      async get(apiPath, options) {
        const value = await inner.get(apiPath, options);
        if (apiPath.includes("/compare/") && value && typeof value === "object") return { ...value, files: compared };
        return value;
      },
    };
    const dir = mkdtempSync(path.join(tmpdir(), "elenchus-record-"));
    try {
      const live = await loadReview(recordingGh(full, dir), "BeniCheni/elenchus", 1, kickoffConfig());
      const liveReport = formatCheck(buildCheck(live));
      const replay: GhClient = {
        async get(apiPath) {
          return JSON.parse(readFileSync(path.join(dir, `${encodeURIComponent(apiPath)}.json`), "utf8")) as unknown;
        },
      };
      const again = await loadReview(replay, "BeniCheni/elenchus", 1, kickoffConfig());
      expect(formatCheck(buildCheck(again))).toBe(liveReport);
      expect(liveReport).not.toMatch(/FAIL coverage/);
      const saved = readdirSync(dir)
        .filter((name) => name.includes("compare"))
        .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { files?: Record<string, unknown>[] });
      expect(saved.some((compare) => compare.files?.some((file) => file.previous_filename === "old.ts"))).toBe(true);
      expect(saved.every((compare) => (compare.files ?? []).every((file) => !("patch" in file)))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("holds v1.2 reviewed paths to the manifest independently of the numerical totals", async () => {
  const manifest = [{ status: "added", filename: "added" }, { status: "removed", filename: "deleted" }];
  const capture = async (reviewed_paths: string[]) => {
    const records = [
      seat({ pass: "0", input_sha: B, output_sha: B, schema_version: "1.2", coverage: {
        total: 2, reviewed: 1, skipped: [{ path: "deleted", reason: "deleted" }], reviewed_paths,
      } }),
    ];
    const inner = graphGh({ head: B, baseSha: A, comments: [comment(1, fenced(records[0]), "2026-11-14T00:00:01Z")], nodes });
    const gh: GhClient = {
      async get(apiPath, options) {
        const value = await inner.get(apiPath, options);
        return apiPath.includes("/compare/") ? { ...(value as GhCompare), files: manifest } : value;
      },
    };
    const state = await loadReview(gh, "BeniCheni/elenchus", 1, kickoffConfig());
    return formatCheck(buildCheck(state));
  };

  expect(await capture(["added"])).toBe("ok\n");
  expect(await capture(["deleted"])).toMatch(/deleted is both reviewed and skipped/);
  expect(await capture(["elsewhere"])).toMatch(/reviewed elsewhere is not in the manifest/);
  expect(await capture(["deleted"])).toMatch(/added is missing from reviewed and skipped paths/);
  expect(await capture([])).toMatch(/reviewed 1 is not the number of reviewed paths 0/);
});
