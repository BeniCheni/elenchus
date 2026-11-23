import { describe, expect, it } from "vitest";
import { commentBody, prepReplayRecord, replayRecords } from "../examples/replay/records.js";
import { formatCheck, formatStatus } from "../src/format.js";
import { loadReview } from "../src/load.js";
import { extractRecord } from "../src/records.js";
import { buildCheck, buildStatus } from "../src/report.js";
import { validateSeatRecord } from "../src/schema.js";
import type { SeatRecord } from "../src/types.js";
import { comment, graphGh, replayConfig, type Node } from "./graph.js";

const full = {
  ddd9a37: "ddd9a37efc68fc09709bda0c48895f952d805233",
  f7775c9: "f7775c9ab9170ffa7382c283320c9896b9a455e8",
  "0faf606": "0faf606a131133e050b2b599b5d0cdf75e545c6e",
  "961d320": "961d32096cb2a0b9a2dced50340af5cbcdb0fe38",
  b275a56: "b275a564511c98b043e42fbb8003ccf9b79ee61a",
  "9b3a90a": "9b3a90ad15c9d9cce7312d96e1753b58907a0a54",
  d1f32c0: "d1f32c0d40437d592e157ea4250d5ca412151b55",
  d737ceb: "d737ceb18b5fbecc4c43537a37223c963566bdd3",
  "89b8067": "89b8067b0c358cefbd37599d706d5c54eab3df97",
  "0c7bdd8": "0c7bdd8f968bd89c229e257bd913e52d6f7d23dc",
  c4afa12: "c4afa12246bb8ca57072924fbfab330a2558967b",
  "97200f3": "97200f35b6669063f78041dcd31f19d6e1739232",
  "09324fb": "09324fb82e77fbed15f07024e6903db0582286ab",
  "34d078b": "34d078bb4a12ab56f464cfc8e7cfbd947cc7dca3",
  "217189c": "217189c44e0e6c2aeafc16980e1c79eb3901b67f",
  "8ea93e2": "8ea93e2fe5d986a49778150e811a41a53516a837",
  "7b7da6b": "7b7da6b51a9d3b112ce5ee60233bf08fe9760c0e",
  "188b909": "188b9099749d60a0bcc67d4304002884fdfa7ad5",
  dcb914e: "dcb914e3724e0e6ed0462f52f248185f9e138d6a",
} as const;

const claude = "Claude <noreply@anthropic.com>";
const cursor = "Cursor <cursoragent@cursor.com>";
const codex = "Codex <noreply@openai.com>";
const bot = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
const beni = "Benjamin Chen <benjaminlchen@gmail.com>";

function node(parents: string[], author: string): Node {
  return { parents, author };
}

const nodes: Record<string, Node> = {
  [full.ddd9a37]: node([], codex),
  [full["0faf606"]]: node([full.ddd9a37], codex),
  [full["961d320"]]: node([full["0faf606"]], claude),
  [full.b275a56]: node([full["961d320"]], claude),
  [full["9b3a90a"]]: node([full.b275a56], claude),
  [full.d1f32c0]: node([full["9b3a90a"]], claude),
  [full.d737ceb]: node([full.d1f32c0], claude),
  [full["89b8067"]]: node([full.d737ceb], claude),
  [full["0c7bdd8"]]: node([full["89b8067"]], cursor),
  [full.c4afa12]: node([full["0c7bdd8"]], cursor),
  [full["97200f3"]]: node([full.c4afa12], cursor),
  [full["09324fb"]]: node([full["97200f3"]], cursor),
  [full.f7775c9]: node([full.ddd9a37], bot),
  [full["34d078b"]]: node([full.f7775c9], beni),
  [full["217189c"]]: node([full["09324fb"], full["34d078b"]], cursor),
  [full["8ea93e2"]]: node([full["217189c"]], cursor),
  [full["7b7da6b"]]: node([full["8ea93e2"]], cursor),
  [full["188b909"]]: node([full["7b7da6b"]], cursor),
  [full.dcb914e]: node([full["188b909"]], cursor),
};

async function checkRecords(records: SeatRecord[], head: string, baseSha: string): Promise<string> {
  const comments = records.map((record, index) =>
    comment(index + 1, `${replayRecords[0]?.firstLine ?? "note"}\n\n\`\`\`json\n${JSON.stringify({ ...record, pr: 1 }, null, 2)}\n\`\`\`\n`, `2026-11-14T00:00:${String(index).padStart(2, "0")}Z`),
  );
  const state = await loadReview(
    graphGh({ head, baseSha, comments, nodes }),
    "BeniCheni/elenchus",
    1,
    replayConfig(),
  );
  return formatCheck(buildCheck(state));
}

describe("transcribed #320 records", () => {
  it("each record validates and each comment ends with that record", () => {
    for (const entry of replayRecords) {
      expect(validateSeatRecord(entry.record).ok, entry.pass).toBe(true);
      const body = commentBody(entry);
      expect(body.startsWith(entry.firstLine)).toBe(true);
      expect(extractRecord(body)).toBe(JSON.stringify(entry.record, null, 2));
    }
  });

  it("passes check at the release head, with the merge's commits left out of the executor's range", async () => {
    const report = await checkRecords(
      replayRecords.map((entry) => entry.record),
      full.dcb914e,
      full["34d078b"],
    );
    expect(report).not.toMatch(/FAIL /);
    expect(report).toMatch(/UNVERIFIED route pass exec .*model not reported/);
  });

  it("T1 names pass 1.5 when that record is removed", async () => {
    const report = await checkRecords(
      replayRecords.filter((entry) => entry.pass !== "1.5").map((entry) => entry.record),
      full.dcb914e,
      full["34d078b"],
    );
    expect(report).toMatch(/FAIL sequence pass 2 .*skipped pass 1\.5/);
  });

  it("T3 names finding 7 when Pass 2 drops it, and passes when the record is restored", async () => {
    const without = replayRecords.map((entry) => {
      if (entry.pass !== "2") return entry.record;
      return { ...entry.record, findings: entry.record.findings.filter((item) => item.id !== "7") };
    });
    const broken = await checkRecords(without, full.dcb914e, full["34d078b"]);
    expect(broken).toMatch(/FAIL finding-carry pass 2 finding 7 .*finding 7 opened in pass 1 is missing/);
    const restored = await checkRecords(
      replayRecords.map((entry) => entry.record),
      full.dcb914e,
      full["34d078b"],
    );
    expect(restored).not.toMatch(/FAIL finding-carry/);
  });

  it("reports one commit on top of dcb914e without failing check", async () => {
    const child = "a".repeat(40);
    const comments = replayRecords.map((entry, index) =>
      comment(
        index + 1,
        `${entry.firstLine}\n\n\`\`\`json\n${JSON.stringify({ ...entry.record, pr: 1 }, null, 2)}\n\`\`\`\n`,
        `2026-11-14T00:00:${String(index).padStart(2, "0")}Z`,
      ),
    );
    const state = await loadReview(
      graphGh({
        head: child,
        baseSha: full["34d078b"],
        comments,
        nodes: { ...nodes, [child]: node([full.dcb914e], cursor) },
      }),
      "BeniCheni/elenchus",
      1,
      replayConfig(),
    );
    const status = formatStatus(buildStatus(state));
    const check = formatCheck(buildCheck(state));
    expect(status).toContain(`head ${child} does not equal last output_sha dcb914e`);
    expect(check).not.toMatch(/FAIL /);
  });
});

it("keeps replay PR numbers and source qualifications faithful to their fixtures", () => {
  expect(replayRecords.every(({ record }) => record.pr === 1)).toBe(true);
  expect(prepReplayRecord.record.pr).toBe(3);
  expect(validateSeatRecord(prepReplayRecord.record).ok).toBe(true);
  for (const pass of ["0", "1.5"]) {
    expect(replayRecords.find((entry) => entry.pass === pass)!.record.model.requested).toBe(null);
  }
  const rebuttal = replayRecords.find((entry) => entry.pass === "2")!.record;
  expect(rebuttal.findings.filter(({ id }) => id === "N1" || id === "N2").every(({ disposition }) => disposition === undefined)).toBe(true);
  const synthesis = replayRecords.find((entry) => entry.pass === "2.5")!.record;
  expect(synthesis.findings.find(({ id }) => id === "6")!.severity).toBe("medium, not fixed → low");
  expect(synthesis.findings.filter(({ id }) => ["7", "9", "N1", "N2"].includes(id))
    .every(({ disposition }) => disposition === undefined)).toBe(true);
  expect(replayRecords.at(-1)!.record.not_verified).not.toContain("vercel-smoke was left red until main carries the script.");
  for (const entry of [...replayRecords, prepReplayRecord]) {
    expect(commentBody(entry)).not.toContain("kickoff#");
  }
});
