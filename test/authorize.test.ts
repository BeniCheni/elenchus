import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { AppStatusClient } from "../src/app-status.js";
import { authorize } from "../src/authorize.js";
import type { GhClient } from "../src/gh.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";
import type { Config, GateConfig, SeatRecord } from "../src/types.js";
import { comment, fenced, kickoffConfig } from "./graph.js";

const repo = "owner/repo";
const sha = "a".repeat(40);
const appId = 459;
const service = "test Keychain item";
const testInstallationToken = "stub-installation-token";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function record(pass: string, change: Partial<SeatRecord> = {}): SeatRecord {
  return {
    seat_record: 1, schema_version: "1.2", pr: 1, pass, runtime: "Claude Code",
    model: { requested: "claude-fable-5-2", observed: null, source: "not reported" },
    effort: { requested: "xhigh", observed: null, source: "not reported" },
    route: { recommended_by: null, confirmed_by: null },
    input_sha: sha, output_sha: sha, commits: [], findings: [], verdict: "ok",
    ...change,
  };
}

function world(options: {
  records?: SeatRecord[];
  allPasses?: string[];
  run?: "failure" | "pending" | "success";
  covered?: boolean;
  blockRoute?: boolean;
  configAppId?: number;
  head?: string;
  intermediateHead?: string;
  state?: string;
  repo?: string;
  changedPath?: string;
  boundary?: string;
  configure?: (config: Config) => void;
} = {}) {
  const configured = kickoffConfig();
  const allPasses = options.allPasses ?? ["cold", "synthesis", "ruling"];
  configured.passes = allPasses.map((id) => ({
    id, role: `role ${id}`, seat: `seat ${id}`, ...(options.covered ? { coverage: true } : {}),
  }));
  configured.finding_flow = { opens: "cold", carries: ["reply", "synthesis"].filter((id) => allPasses.includes(id)), ruling: "ruling" };
  const gate = configured.gate!;
  gate.allowed_changes!.reread_pass = options.boundary ?? allPasses[0]!;
  gate.app_id = options.configAppId ?? appId;
  if (options.blockRoute) gate.blocking_unverified.push("route");
  options.configure?.(configured);
  const head = options.head ?? sha;
  const baseSha = options.changedPath ? sha : head;
  const heads = options.intermediateHead ? [baseSha, options.intermediateHead, head] : [baseSha, head];
  const pull = { number: 1, state: options.state ?? "open", head: { sha: head }, base: { ref: "trunk", sha: baseSha } };
  const comments = (options.records ?? allPasses.map((pass) => record(pass))).map((entry, i) =>
    comment(i + 1, fenced(entry), `2026-11-14T00:00:${String(i).padStart(2, "0")}Z`),
  );
  const calls: string[] = [];
  const gh: GhClient = {
    async get(path, readOptions) {
      calls.push(path);
      const root = `/repos/${options.repo ?? repo}`;
      if (path === `${root}/pulls/1`) return pull;
      if (path === `${root}/commits/heads%2Ftrunk`) return { sha: baseSha };
      if (path === `${root}/issues/1/comments?per_page=100` && readOptions?.paginate) return comments;
      if (path === `${root}/contents/.elenchus.json?ref=${baseSha}`) {
        return { content: Buffer.from(JSON.stringify(configured)).toString("base64") };
      }
      if (path === `${root}/commits/${head}/check-runs?filter=latest&per_page=100` && readOptions?.paginate) {
        return { check_runs: [{
          name: "verify", status: options.run === "pending" ? "in_progress" : "completed",
          conclusion: options.run === "pending" ? null : options.run ?? "success",
          head_sha: head, app: { id: 15368 },
        }] };
      }
      if (options.changedPath && path.startsWith(`${root}/compare/`)) {
        const [from, to] = path.slice(`${root}/compare/`.length).split("?")[0]!.split("...");
        const start = heads.indexOf(from!);
        const end = heads.indexOf(to!);
        if (start >= 0 && end > start) {
          const commits = heads.slice(start + 1, end + 1).map((commit, index) => ({
            sha: commit, parents: [{ sha: heads[start + index] }],
            commit: { author: { name: "Claude", email: "noreply@anthropic.com" } },
          }));
          return { status: "ahead", total_commits: commits.length, commits };
        }
      }
      if (options.changedPath && path.startsWith(`${root}/git/trees/`)) {
        const changed = heads.slice(1).findIndex((commit) => path.includes(commit));
        return {
          truncated: false,
          tree: changed < 0 ? [] : [{ path: options.changedPath, sha: String(changed + 1).repeat(40), mode: "100644", type: "blob" }],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    },
  };
  return { gh, calls };
}

function makeApp(origin: string, keys: string[]) {
  return new AppStatusClient(origin, async (name) => {
    keys.push(name);
    return privateKey;
  });
}

async function withLocalApp(
  test: (origin: string, requests: CapturedRequest[]) => Promise<void>, installationApp = appId, redirect?: number,
) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const captured = { path: request.url, method: request.method, authorization: request.headers.authorization, body };
    requests.push(captured);
    response.setHeader("Content-Type", "application/json");
    if (redirect && request.url?.endsWith("/installation")) {
      response.writeHead(redirect, { Location: "/redirected" });
      return response.end();
    }
    if (request.url?.endsWith("/installation")) return response.end(JSON.stringify({ id: 987, app_id: installationApp }));
    if (request.url === "/app/installations/987/access_tokens") return response.end(JSON.stringify({ token: testInstallationToken }));
    response.statusCode = 201;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local server has no address");
    await test(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.close();
    await once(server, "close");
  }
}

type CapturedRequest = { path?: string; method?: string; authorization?: string; body: string };

describe("authorize with its real App client", () => {
  it("signs the JWT and makes exactly three requests ending in the one success status", async () => {
    await withLocalApp(async (origin, requests) => {
      const keys: string[] = [];
      const { gh, calls } = world();
      const result = await authorize(gh, repo, 1, { app: makeApp(origin, keys), keychainService: service });
      expect(result).toEqual({ ok: true, posted: true, head: sha, context: "kickoff/360", baseRef: "trunk", baseSha: sha, items: [] });
      expect(calls.filter((path) => path.endsWith("/pulls/1"))).toHaveLength(1);
      expect(calls.filter((path) => path.includes("/comments"))).toHaveLength(1);
      expect(keys).toEqual([service]);
      expect(requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/repos/owner/repo/installation"],
        ["POST", "/app/installations/987/access_tokens"],
        ["POST", `/repos/owner/repo/statuses/${sha}`],
      ]);
      const jwt = requests[0]?.authorization?.replace(/^Bearer /, "") ?? "";
      const [header, claims, signature] = jwt.split(".");
      expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
      expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ iss: String(appId) });
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
      expect(requests[1]?.authorization).toBe(`Bearer ${jwt}`);
      expect(requests[2]?.authorization).toBe(`Bearer ${testInstallationToken}`);
      expect(requests[0]?.body).toBe("");
      expect(requests[1]?.body).toBe("");
      expect(JSON.parse(requests[2]!.body)).toEqual({
        state: "success", context: "kickoff/360", description: "Review complete at this commit",
        target_url: "https://github.com/owner/repo/pull/1",
      });
    });
  });

  it("rejects an invalid status request through authorize before reading the key or sending anything", async () => {
    await withLocalApp(async (origin, requests) => {
      const keys: string[] = [];
      const head = sha.slice(0, 7);
      const { gh } = world({ head });
      await expect(authorize(gh, repo, 1, { app: makeApp(origin, keys), keychainService: service }))
        .rejects.toThrow(/App request refused/);
      expect(requests).toEqual([]);
      expect(keys).toEqual([]);
    });
  });

  it.each([302, 307, 308])("refuses a %s from the local App server without following it", async (status) => {
    await withLocalApp(async (origin, requests) => {
      await expect(makeApp(origin, []).post({ repo, pr: 1, context: "kickoff/360", sha, appId, keychainService: service }))
        .rejects.toThrow(/could not connect/);
      expect(requests.map(({ path }) => path)).toEqual(["/repos/owner/repo/installation"]);
    }, appId, status);
  });

  it("never proceeds to a token or status when the installation belongs to a different App", async () => {
    await withLocalApp(async (origin, requests) => {
      const { gh } = world();
      await expect(authorize(gh, repo, 1, { app: makeApp(origin, []), keychainService: service }))
        .rejects.toThrow(/no installation for the configured App/);
      expect(requests).toHaveLength(1);
    }, appId + 1);
  });

  it("dry-run returns the same decision without a key read or network write", async () => {
    await withLocalApp(async (origin, requests) => {
      const keys: string[] = [];
      const { gh } = world();
      await expect(authorize(gh, repo, 1, { app: makeApp(origin, keys), dryRun: true }))
        .resolves.toEqual({ ok: true, posted: false, head: sha, context: "kickoff/360", baseRef: "trunk", baseSha: sha, items: [] });
      expect(requests).toEqual([]);
      expect(keys).toEqual([]);
    });
  });

  it.each([
    { options: { records: [] }, error: /no valid record/ },
    { options: { run: "failure" as const }, error: /verify .* failure/ },
    { options: { run: "pending" as const }, error: /verify .* in_progress/ },
    { options: { covered: true }, error: /coverage not reported/ },
    { options: { blockRoute: true }, error: /model not reported/ },
    { options: { state: "closed" }, error: /pull request is closed/ },
    { options: { records: [record("cold", { pr: 2 })] }, error: /record pr 2 does not match/ },
  ])("reports a blocker without prompting or touching the App API %#", async ({ options, error }) => {
    await withLocalApp(async (origin, requests) => {
      const keys: string[] = [];
      const { gh } = world(options);
      const result = await authorize(gh, repo, 1, { app: makeApp(origin, keys), keychainService: service });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.items.map(({ message }) => message).join("\n")).toMatch(error);
      expect(requests).toEqual([]);
      expect(keys).toEqual([]);
    });
  });

  it("T5 names the contested finding until the ruling is recorded", async () => {
    const allPasses = ["cold", "reply", "synthesis", "ruling"];
    const findings = ["F7", "F8"].map((id) => ({ id, severity: "should-fix", status: "contested" as const }));
    const records = [
      record("cold", { findings: findings.map((finding) => ({ ...finding, status: "open" })) }),
      record("reply", { findings }),
      record("synthesis", { findings }),
    ];
    const pending = await authorize(world({ allPasses, records }).gh, repo, 1, { dryRun: true });
    expect(pending).toMatchObject({ ok: false, items: expect.arrayContaining([
      expect.objectContaining({ rule: "ruling", finding: "F7", message: "contested finding F7 needs a ruling in pass ruling" }),
    ]) });
    const decide = (answers: SeatRecord["findings"]) => authorize(
      world({ allPasses, records: [...records, record("ruling", { findings: answers })] }).gh, repo, 1, { dryRun: true },
    );
    for (const answers of [[], [{ ...findings[0]!, status: "fixed" as const }], findings]) {
      expect(await decide(answers)).toMatchObject({ ok: false, items: expect.arrayContaining([
        expect.objectContaining({ rule: "ruling", finding: "F8" }),
      ]) });
    }
    const resolved = await decide(findings.map((finding) => ({ ...finding, status: "fixed" })));
    expect(resolved).toMatchObject({ ok: true, posted: false });
  });

  it("requires the ruling to follow the standing synthesis re-read", async () => {
    const head = "b".repeat(40);
    const allPasses = ["cold", "reply", "synthesis", "ruling"];
    const finding = { id: "F7", severity: "note", status: "contested" as const };
    const records = [
      record("cold", { findings: [finding] }), record("reply", { findings: [finding] }),
      record("synthesis", { findings: [finding] }),
      record("ruling", { findings: [{ ...finding, status: "fixed" }] }),
      record("synthesis", { input_sha: head, output_sha: head, reread: true, findings: [finding] }),
    ];
    const result = await authorize(world({ head, allPasses, records, changedPath: "docs/notes.md" }).gh, repo, 1, { dryRun: true });
    expect(result).toMatchObject({ ok: false, items: expect.arrayContaining([expect.objectContaining({ rule: "ruling", finding: "F7" })]) });
  });
});

it("authorizes an allowed docs commit without counting its classification notice as a blocker", async () => {
  const head = "b".repeat(40);
  expect(await authorize(world({ head, changedPath: "docs/release.md" }).gh, repo, 1, { dryRun: true }))
    .toMatchObject({ ok: true, head, items: [expect.objectContaining({ rule: "head", message: expect.stringContaining("only configured paths") })] });
  expect(await authorize(world({ head, changedPath: "src/index.ts" }).gh, repo, 1, { dryRun: true }))
    .toMatchObject({ ok: false, items: expect.arrayContaining([expect.objectContaining({
      rule: "head", message: expect.stringContaining("needs a pass cold re-read"),
    })]) });
});

it("refuses a matching abbreviated legacy boundary output SHA without touching the App client", async () => {
  const head = `abc1234${"0".repeat(33)}`;
  const short = head.slice(0, 7);
  const allPasses = ["1", "synthesis", "3"];
  const records = [
    record("1", { input_sha: short, output_sha: short }),
    ...allPasses.slice(1).map((pass) => record(pass, { input_sha: head, output_sha: head })),
  ];
  delete records[0]!.schema_version;
  const { gh } = world({ head, allPasses, records, configure: (config) => {
    config.finding_flow = { opens: "1", carries: ["synthesis"], ruling: "3" };
  } });
  const result = await authorize(gh, repo, 1, { dryRun: true });
  expect(result).toMatchObject({ ok: false, items: [expect.objectContaining({
    rule: "head", message: expect.stringContaining("output_sha abc1234 must be a full 40-digit SHA"),
  })] });
});

const fullPasses = ["brief", "cold", "plan", "reply", "synthesis", "ruling", "exec"];

it("requires allowed_changes before classifying a seven-pass writing executor", async () => {
  const head = "b".repeat(40);
  const records = fullPasses.map((pass) => record(pass, pass === "exec" ? { output_sha: head, commits: [head] } : {}));
  const options = { head, allPasses: fullPasses, records, boundary: "synthesis" };
  const bad = world({
    ...options, changedPath: "src/other.ts", configure: (config) => { delete config.gate!.allowed_changes; },
  });
  expect(await authorize(bad.gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: false, items: [{ rule: "config", message: "config.gate.allowed_changes is required" }],
  });
  expect(await authorize(world({ ...options, changedPath: "docs/notes.md" }).gh, repo, 1, { dryRun: true }))
    .toMatchObject({ ok: true, head, items: [expect.objectContaining({ rule: "head", message: expect.stringContaining("only configured paths") })] });
});

it.each(["configured last", "chronologically latest"])("reports a short output outside the boundary on the %s pass", async (caseName) => {
  const short = sha.slice(0, 7);
  const legacy = record(caseName === "configured last" ? "exec" : "3", { input_sha: short, output_sha: short });
  delete legacy.schema_version;
  const allPasses = ["cold", "synthesis", "3", "exec"];
  const head = caseName === "configured last" ? "b".repeat(40) : sha;
  const records = caseName === "configured last"
    ? [record("cold"), record("synthesis"), record("3"), legacy, record("3", { reread: true, input_sha: head, output_sha: head })]
    : [record("cold"), record("synthesis"), record("exec"), legacy];
  const { gh } = world({ allPasses, records, head, changedPath: "docs/notes.md", configure: (config) => {
    config.finding_flow!.ruling = "3";
  } });
  const result = await authorize(gh, repo, 1, { dryRun: true });
  expect(result).toMatchObject({ ok: false, items: expect.arrayContaining([
    expect.objectContaining({ rule: "head", message: `output_sha ${short} must be a full 40-digit SHA for authorize` }),
  ]) });
});

it.each([
  ["blocking", "contested", "blocking", "open", false],
  ["blocking", "contested", "blocking", "fixed", true],
  ["blocking", "contested", "blocking", "killed", true],
  ["blocking", "contested", "note", "open", false],
  ["blocking", "contested", "note", "fixed", true],
  ["blocking", "open", "note", "open", false],
  ["note", "contested", "note", "open", true],
  ["blocking", "open", null, null, false],
  ["blocking", "open", "blocking", "killed", true],
  ["blocking", "fixed", null, null, true],
  ["should-fix", "open", "blocking", "open", false],
] as const)("adjudicates a %s %s finding when the ruling has %s %s", async (severity, status, ruledSeverity, ruledStatus, ok) => {
  const allPasses = ["cold", "reply", "synthesis", "ruling"];
  const finding = { id: "F1", severity, status };
  const records = [
    ...allPasses.slice(0, -1).map((pass) => record(pass, { findings: [finding] })),
    record("ruling", { findings: ruledSeverity && ruledStatus ? [{ id: finding.id, severity: ruledSeverity, status: ruledStatus }] : [] }),
  ];
  const result = await authorize(world({ allPasses, records }).gh, repo, 1, { dryRun: true });
  expect(result.ok).toBe(ok);
  expect(result.items).toEqual(ok ? [] : [expect.objectContaining({ rule: "ruling", finding: "F1" })]);
});

it("refuses an open blocking ID introduced only by an on-time ruling (A15)", async () => {
  const records = [
    record("cold"), record("synthesis"),
    record("ruling", { findings: [{ id: "F9", severity: "blocking", status: "open" }] }),
  ];
  const { gh } = world({ records });
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: false, items: [expect.objectContaining({ rule: "ruling", pass: "ruling", finding: "F9" })],
  });
});

it.each([["2.5", "high"], ["3", "high"], ["2.5", "blocking"], ["3", "blocking"]])(
  "refuses a v1.1 pass %s with full SHAs for its schema (severity %s)", async (pass, severity) => {
  const allPasses = ["1", "2.5", "3"];
  const records = allPasses.map((id) => record(id));
  const legacy = records.find((entry) => entry.pass === pass)!;
  delete legacy.schema_version;
  legacy.findings = [{ id: "F1", severity, status: "open" }];
  const { gh } = world({ allPasses, records, configure(config) {
    config.finding_flow = { opens: "1", carries: ["2.5"], ruling: "3" };
  } });
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: false, items: [expect.objectContaining({ rule: "schema", pass, message: expect.stringContaining("requires a schema v1.2") })],
  });
  },
);

it("refuses empty carries while nonempty carries evaluate findings", async () => {
  const finding = { id: "F1", severity: "blocking", status: "open" as const };
  const allPasses = ["cold", "reply", "synthesis", "ruling"];
  const records = allPasses.map((pass) => record(pass, { findings: pass === "ruling" ? [] : [finding] }));
  function setup(flow: string[]) {
    return world({ allPasses, records, configure(config) {
      config.finding_flow!.carries = flow;
    } }).gh;
  }
  expect(await authorize(setup([]), repo, 1, { dryRun: true })).toMatchObject({
    ok: false, items: [expect.objectContaining({ rule: "config", message: expect.stringContaining("config.finding_flow.carries") })],
  });
  for (const flow of [["synthesis"], ["reply", "synthesis"]]) {
    expect(await authorize(setup(flow), repo, 1, { dryRun: true })).toMatchObject({
      ok: false, items: [expect.objectContaining({ rule: "ruling", finding: "F1" })],
    });
  }
});

it.each([
  ["A16", "F31", false, true],
  ["A17", "F7", true, true],
  ["A17b", "F7", true, false],
] as const)("%s requires an ID named before the synthesis re-read", async (_case, id, introducedBySynthesis, namedInRuling) => {
  const finding = { id, severity: "blocking", status: "open" as const };
  const records = [
    ...fullPasses.slice(0, 4).map((pass) => record(pass)),
    record("synthesis", { findings: introducedBySynthesis ? [finding] : [] }),
    record("ruling", { findings: namedInRuling ? [finding] : [] }),
  ];
  const { gh } = rereadReview(records, []);
  const expected = expect.objectContaining({
    rule: "finding-carry", pass: "synthesis", finding: id,
    message: expect.stringContaining(`record https://github.com/BeniCheni/elenchus/pull/1#issuecomment-${introducedBySynthesis ? 5 : 6}`),
  });
  expect(buildCheck(await loadReview(gh, repo, 1))).toContainEqual(expected);
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: false, items: expect.arrayContaining([expected]),
  });
  const fresh = rereadReview(records, [], { freshRuling: true });
  expect(await authorize(fresh.gh, repo, 1, { dryRun: true })).toMatchObject({ ok: false, items: [expected] });
});

const rereadHead = "b".repeat(40);
const thirdHead = "c".repeat(40);

function rereadReview(records: SeatRecord[], findings: SeatRecord["findings"], options: { freshRuling?: boolean; executor?: boolean } = {}) {
  const executor = options.executor ?? true;
  return world({
    allPasses: fullPasses, boundary: "synthesis", head: rereadHead, changedPath: "docs/notes.md",
    records: [
      ...records,
      record("synthesis", { reread: true, input_sha: rereadHead, output_sha: rereadHead, findings }),
      ...(options.freshRuling ? [record("ruling", { reread: true, input_sha: rereadHead, output_sha: rereadHead })] : []),
      ...(executor ? [record("exec", { input_sha: rereadHead, output_sha: rereadHead })] : []),
    ],
  });
}

const stale = expect.objectContaining({
  rule: "ruling", pass: "ruling",
  message: expect.stringMatching(/issuecomment-6 precedes the standing synthesis .*issuecomment-7/),
});

it("carries IDs named in an accepted correction once the synthesis re-reads", async () => {
  const finding = { id: "F32", severity: "note", status: "open" as const };
  const earlier = fullPasses.slice(0, 5).map((pass) => record(pass));
  const { gh } = rereadReview([...earlier, record("synthesis", { findings: [finding] }), record("ruling")], []);
  const carry = buildCheck(await loadReview(gh, repo, 1)).filter(({ rule }) => rule === "finding-carry");
  expect(carry).toEqual([expect.objectContaining({ finding: "F32", message: expect.stringContaining("issuecomment-6") })]);
});

it("allows an early same-range synthesis correction to drop an ID it introduced", async () => {
  const finding = { id: "F32", severity: "note", status: "open" as const };
  const records = [record("cold"), record("synthesis", { findings: [finding] }), record("synthesis"), record("ruling")];
  const { gh } = world({ records });
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: true, items: [expect.objectContaining({ rule: "record replacement" })],
  });
});

const rulingFinding = { id: "F9", severity: "blocking", status: "open" } as const;
const replayPasses = ["0", "1", "1.5", "2", "2.5", "3", "exec"];

function legacyRecord(pass: string, change: Partial<SeatRecord> = {}): SeatRecord {
  const entry = record(pass, change);
  delete entry.schema_version;
  return entry;
}

it.each(["2.5", "3"] as const)("pass %s carries a legacy ID when its marked re-read returns to an older range", async (pass) => {
  const atHead = { input_sha: rereadHead, output_sha: rereadHead };
  const writing = { output_sha: rereadHead, commits: [rereadHead] };
  const records = replayPasses.slice(0, 3).map((id) => record(id));
  if (pass === "2.5") {
    records.push(
      legacyRecord("2", writing),
      legacyRecord("2.5", { ...atHead, findings: [rulingFinding] }),
      legacyRecord("2"),
      legacyRecord("2.5"),
      record("2.5", { ...atHead, reread: true }),
      record("3", atHead),
    );
  } else {
    records.push(
      record("2"),
      record("2.5"),
      legacyRecord("3", { ...writing, findings: [rulingFinding] }),
      legacyRecord("3"),
      record("3", { ...writing, reread: true }),
    );
  }
  records.push(record("exec", atHead));
  const { gh } = world({
    records, allPasses: replayPasses, boundary: "2.5", head: rereadHead, changedPath: "docs/notes.md",
    configure(config) { config.finding_flow = { opens: "1", carries: ["2", "2.5"], ruling: "3" }; },
  });
  const carry = expect.objectContaining({
    severity: "fail", rule: "finding-carry", pass, finding: "F9",
    message: expect.stringContaining(`record https://github.com/BeniCheni/elenchus/pull/1#issuecomment-${pass === "2.5" ? 5 : 6}`),
  });
  const check = buildCheck(await loadReview(gh, repo, 1));
  expect(check.filter(({ severity }) => severity === "fail")).toEqual([carry]);
  const result = await authorize(gh, repo, 1, { dryRun: true });
  expect(result).toMatchObject({ ok: false });
  expect(result.items.filter(({ severity }) => severity === "fail")).toEqual([carry]);
});

it.each(["synthesis", "ruling"])("defers the whole replacement chain for the standing %s", async (pass) => {
  const records = fullPasses.flatMap((id) => id === pass
    ? [record(id, { findings: [rulingFinding] }), record(id, { findings: [{ ...rulingFinding, id: "F10" }] }), record(id)]
    : [record(id)]);
  const { gh } = world({ records, allPasses: fullPasses });
  const result = await authorize(gh, repo, 1, { dryRun: true });
  expect(result).toMatchObject({ ok: true, posted: false });
  expect(result.items.map(({ rule }) => rule)).toEqual(["record replacement", "record replacement"]);
});

function rulingReread(findings: SeatRecord["findings"], executorWrites: boolean, introducedByCorrection = false) {
  const records = [
    ...fullPasses.slice(0, 5).map((pass) => record(pass)),
    ...(introducedByCorrection ? [record("ruling")] : []),
    record("ruling", { findings: [rulingFinding] }),
  ];
  if (executorWrites) records.push(record("exec", { output_sha: rereadHead, commits: [rereadHead] }));
  records.push(record("ruling", { reread: true, input_sha: rereadHead, output_sha: rereadHead, findings }));
  if (!executorWrites) records.push(record("exec", { input_sha: rereadHead, output_sha: rereadHead }));
  return world({ allPasses: fullPasses, boundary: "synthesis", head: rereadHead, changedPath: "docs/notes.md", records });
}

it.each([
  { scenario: "RR1 executor docs commit", executorWrites: true, findings: [] },
  { scenario: "RR2 executor docs commit and another ID fixed", executorWrites: true, findings: [{ id: "F1", severity: "note", status: "fixed" as const }] },
  { scenario: "RR6 unrecorded docs push", executorWrites: false, findings: [] },
])("$scenario requires the ruling re-read to carry F9", async ({ executorWrites, findings }) => {
  const { gh } = rulingReread(findings, executorWrites);
  const carry = {
    rule: "finding-carry", pass: "ruling", finding: "F9",
    message: "finding F9 from pass ruling record https://github.com/BeniCheni/elenchus/pull/1#issuecomment-6 is missing",
  };
  const state = await loadReview(gh, repo, 1);
  expect(buildCheck(state).filter(({ rule }) => rule === "finding-carry")).toEqual([expect.objectContaining(carry)]);
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({ ok: false, items: expect.arrayContaining([expect.objectContaining(carry)]) });
  expect(buildStatus(state).next).toMatchObject({ step: "authorize", blocked: "authorization required" });
});

type CarryCase = {
  scenario: string;
  side: "ruling" | "synthesis";
  source: string;
  id: string;
  namedIn?: string[];
  earlierReread: boolean;
  sourcePass?: "1" | "2.5" | "3";
  kind?: "legacy" | "correction" | "replaced" | "returning";
  raised?: Pick<SeatRecord["findings"][number], "severity" | "status">;
};

it.each(([
  { scenario: "SX7", side: "ruling", source: "an opener ID", id: "F1", namedIn: ["1", "2", "2.5"], earlierReread: false },
  { scenario: "SZ2a", side: "ruling", source: "a pass 2 ID", id: "F2", namedIn: ["2", "2.5"], earlierReread: false },
  { scenario: "SZ2b", side: "ruling", source: "a synthesis ID", id: "F3", namedIn: ["2.5"], earlierReread: false },
  { scenario: "SM1", side: "ruling", source: "an earlier ruling re-read's ID", id: "F4", namedIn: [], earlierReread: true },
  { scenario: "SM1s", side: "synthesis", source: "an earlier synthesis re-read's ID", id: "F5", namedIn: [], earlierReread: true },
  { scenario: "SM5", side: "ruling", source: "a pass 1.5 ID", id: "F6", namedIn: ["1.5"], earlierReread: false },
  { scenario: "SM5-0", side: "ruling", source: "a pass 0 ID", id: "F7", namedIn: ["0"], earlierReread: false },
  { scenario: "SM5-exec", side: "ruling", source: "an executor ID", id: "F8", namedIn: ["exec"], earlierReread: true },
  { scenario: "SM26", side: "synthesis", source: "an earlier ruling re-read's ID", id: "F26", sourcePass: "3", earlierReread: true },
  { scenario: "SM29a", side: "synthesis", source: "a legacy ruling's ID", id: "F30", kind: "legacy", earlierReread: false },
  { scenario: "SM29b", side: "synthesis", source: "a replaced ruling's ID", id: "F31", kind: "replaced", earlierReread: false },
  { scenario: "SM27a", side: "ruling", source: "an earlier ruling re-read's note", id: "F27", earlierReread: true, raised: { severity: "note", status: "open" } },
  { scenario: "SM27b", side: "ruling", source: "an earlier ruling re-read's blocking ID", id: "F28", earlierReread: true, raised: { severity: "blocking", status: "fixed" } },
  // Ruling 4 covers the remaining reachable source rounds.
  { scenario: "CarryOpenerReread", side: "synthesis", source: "the opener re-read's ID", id: "F33", sourcePass: "1", earlierReread: true },
  { scenario: "CarryOpenerCorrection", side: "synthesis", source: "the opener correction's ID", id: "F34", sourcePass: "1", kind: "correction", earlierReread: false },
  { scenario: "CarryReplacedSynthesis", side: "synthesis", source: "a replaced synthesis's ID", id: "F36", sourcePass: "2.5", kind: "replaced", earlierReread: false },
  { scenario: "CarryRulingCorrectionBefore", side: "synthesis", source: "a ruling correction's ID", id: "F37", kind: "correction", earlierReread: false },
  { scenario: "CarryReturningRulingBefore", side: "synthesis", source: "a ruling ID at the revisited range", id: "F38", kind: "returning", earlierReread: false },
  { scenario: "CarryReplacedRulingAfter", side: "ruling", source: "a replaced ruling's ID", id: "F39", kind: "replaced", earlierReread: false },
  // Eighth Pass 3, ruling 3: isolate each cell against the on-time, blocking, open source.
  { scenario: "CarryOpenerOnTime", side: "synthesis", source: "an on-time opener ID", id: "F40", sourcePass: "1", earlierReread: false },
  { scenario: "CarryOpenerLegacy", side: "synthesis", source: "a legacy opener ID", id: "F41", sourcePass: "1", kind: "legacy", earlierReread: false },
  { scenario: "CarryOpenerShouldFix", side: "synthesis", source: "an opener should-fix ID", id: "F42", sourcePass: "1", earlierReread: false, raised: { severity: "should-fix", status: "open" } },
  { scenario: "CarryOpenerFixed", side: "synthesis", source: "an opener ID", id: "F44", sourcePass: "1", earlierReread: false, raised: { severity: "blocking", status: "fixed" } },
  { scenario: "CarryOpenerContested", side: "synthesis", source: "an opener ID", id: "F45", sourcePass: "1", earlierReread: false, raised: { severity: "blocking", status: "contested" } },
  { scenario: "CarrySynthesisCorrection", side: "synthesis", source: "a synthesis correction's ID", id: "F46", sourcePass: "2.5", kind: "correction", earlierReread: false },
  { scenario: "CarrySynthesisLegacy", side: "synthesis", source: "an older legacy synthesis ID", id: "F47", sourcePass: "2.5", kind: "legacy", earlierReread: false },
  { scenario: "CarrySynthesisShouldFix", side: "synthesis", source: "a synthesis should-fix ID", id: "F48", sourcePass: "2.5", earlierReread: false, raised: { severity: "should-fix", status: "open" } },
  { scenario: "CarrySynthesisNote", side: "synthesis", source: "a synthesis note", id: "F49", sourcePass: "2.5", earlierReread: false, raised: { severity: "note", status: "open" } },
  { scenario: "CarrySynthesisFixed", side: "synthesis", source: "a synthesis ID", id: "F50", sourcePass: "2.5", earlierReread: false, raised: { severity: "blocking", status: "fixed" } },
  { scenario: "CarrySynthesisContested", side: "synthesis", source: "a synthesis ID", id: "F51", sourcePass: "2.5", earlierReread: false, raised: { severity: "blocking", status: "contested" } },
  { scenario: "CarryBeforeShouldFix", side: "synthesis", source: "an earlier ruling should-fix ID", id: "F52", earlierReread: false, raised: { severity: "should-fix", status: "open" } },
  { scenario: "CarryBeforeNote", side: "synthesis", source: "an earlier ruling note", id: "F53", earlierReread: false, raised: { severity: "note", status: "open" } },
  { scenario: "CarryBeforeFixed", side: "synthesis", source: "an earlier ruling ID", id: "F54", earlierReread: false, raised: { severity: "blocking", status: "fixed" } },
  { scenario: "CarryBeforeContested", side: "synthesis", source: "an earlier ruling ID", id: "F55", earlierReread: false, raised: { severity: "blocking", status: "contested" } },
  { scenario: "CarryAfterLegacy", side: "ruling", source: "an older legacy ruling ID", id: "F56", kind: "legacy", earlierReread: false },
  { scenario: "CarryAfterShouldFix", side: "ruling", source: "an earlier ruling should-fix ID", id: "F57", earlierReread: false, raised: { severity: "should-fix", status: "open" } },
  { scenario: "CarryAfterNote", side: "ruling", source: "an earlier ruling note", id: "F58", earlierReread: false, raised: { severity: "note", status: "open" } },
  { scenario: "CarryAfterFixed", side: "ruling", source: "an earlier ruling ID", id: "F59", earlierReread: false, raised: { severity: "blocking", status: "fixed" } },
  { scenario: "CarryAfterContested", side: "ruling", source: "an earlier ruling ID", id: "F60", earlierReread: false, raised: { severity: "blocking", status: "contested" } },
] satisfies CarryCase[]).map((row: CarryCase) => ({
  ...row,
  description: row.raised ? `marked ${row.raised.status}` : "raised to blocking",
})))("$scenario requires the $side re-read to carry $source $description", async ({
  side, id, namedIn = [], earlierReread, sourcePass = side === "synthesis" && earlierReread ? "2.5" : "3",
  kind, raised = { severity: "blocking", status: "open" },
}) => {
  const note = { id, severity: "note", status: "open" } as const;
  const pass = side === "synthesis" ? "2.5" : "3";
  const finding = { id, ...raised };
  const atSecondHead = { input_sha: rereadHead, output_sha: rereadHead };
  const usesLegacy = kind === "legacy" || kind === "returning";
  const source = (usesLegacy ? legacyRecord : record)(sourcePass, {
    findings: [finding],
    ...(earlierReread || kind === "returning" ? atSecondHead : {}),
    ...(earlierReread ? { reread: true } : {}),
  });
  const opener = sourcePass === "1";
  const records = replayPasses.slice(0, 6).flatMap((pass) => {
    if (pass === sourcePass && !earlierReread) {
      if (kind === "correction") return [record(pass), source];
      if (kind === "replaced") return [source, record(pass)];
      if (kind === "returning") return [source, legacyRecord(pass)];
      return [source];
    }
    const carriesOpener = opener && !earlierReread && pass === "2";
    return [record(pass, { findings: carriesOpener ? [finding] : namedIn.includes(pass) ? [note] : [] })];
  });
  const execFindings = namedIn.includes("exec") ? [note] : [];
  records.push(record("exec", { output_sha: rereadHead, commits: [rereadHead], findings: execFindings }));
  const head = earlierReread ? thirdHead : rereadHead;
  if (earlierReread) {
    if (side === "synthesis" && sourcePass === "3") {
      records.push(record("2.5", { ...atSecondHead, reread: true }));
    }
    records.push(source);
    if (opener) records.push(record("2", { ...atSecondHead, reread: true, findings: [finding] }));
    records.push(
      record("exec", { reread: true, input_sha: rereadHead, output_sha: head, commits: [head], findings: execFindings }),
    );
  }
  const atHead = { reread: true, input_sha: head, output_sha: head } as const;
  records.push(record(pass, atHead));
  if (side === "synthesis") records.push(record("3", atHead));
  const { gh } = world({
    records, allPasses: replayPasses, boundary: "2.5", head, changedPath: "docs/notes.md",
    ...(earlierReread ? { intermediateHead: rereadHead } : {}),
    configure(config) { config.finding_flow = { opens: "1", carries: ["2", "2.5"], ruling: "3" }; },
  });
  const carry = expect.objectContaining({
    severity: "fail", rule: "finding-carry", pass, finding: id,
    message: opener ? `finding ${id} opened in pass 1 is missing`
      : `finding ${id} from pass ${sourcePass} record https://github.com/BeniCheni/elenchus/pull/1#issuecomment-${records.indexOf(source) + 1} is missing`,
  });
  const check = buildCheck(await loadReview(gh, repo, 1));
  expect(check.filter(({ severity }) => severity === "fail")).toEqual([carry]);
  const result = await authorize(gh, repo, 1, { dryRun: true });
  expect(result.ok).toBe(false);
  expect(result.items.filter(({ severity }) => severity === "fail")).toEqual([carry]);
});

it("carries ruling IDs named in a correction to an earlier round", async () => {
  const { gh } = rulingReread([], true, true);
  const check = buildCheck(await loadReview(gh, repo, 1));
  expect(check.filter(({ rule }) => rule === "finding-carry")).toEqual([
    expect.objectContaining({ pass: "ruling", finding: "F9", message: expect.stringContaining("issuecomment-7") }),
  ]);
});

it.each([
  ["RR3 refuses", "open", false],
  ["RR4 admits", "killed", true],
] as const)("%s a ruling re-read with F9 %s", async (_scenario, status, ok) => {
  const { gh } = rulingReread([{ ...rulingFinding, status }], true);
  const result = await authorize(gh, repo, 1, { dryRun: true });
  expect(result.ok).toBe(ok);
  expect(result.items.filter(({ rule }) => rule === "finding-carry")).toEqual([]);
  expect(result.items.filter(({ rule }) => rule === "ruling")).toEqual(ok ? [] : [expect.objectContaining({ finding: "F9" })]);
});

it("RR5 admits a same-range ruling correction before the executor", async () => {
  const records = [
    ...fullPasses.slice(0, 5).map((pass) => record(pass)),
    record("ruling", { findings: [rulingFinding] }), record("ruling"), record("exec"),
  ];
  const { gh } = world({ allPasses: fullPasses, records });
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: true, posted: false, items: [expect.objectContaining({ rule: "record replacement" })],
  });
});

it("A16b carries F31 without a carry failure and requires a fresh ruling even after it is fixed", async () => {
  const finding = { id: "F31", severity: "blocking", status: "open" as const };
  const records = [
    ...fullPasses.slice(0, 5).map((pass) => record(pass)),
    record("ruling", { findings: [finding] }),
  ];
  const fixed = [{ ...finding, status: "fixed" as const }];
  const open = rereadReview(records, [finding]);
  expect(await authorize(open.gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: false, items: [stale, expect.objectContaining({ rule: "ruling", finding: "F31", message: expect.stringContaining("must be fixed or killed") })],
  });
  const staleButFixed = rereadReview(records, fixed);
  expect(buildCheck(await loadReview(staleButFixed.gh, repo, 1))).toEqual(expect.not.arrayContaining([expect.objectContaining({ rule: "finding-carry" })]));
  expect(await authorize(staleButFixed.gh, repo, 1, { dryRun: true })).toMatchObject({ ok: false, items: [stale] });
  const fresh = rereadReview(records, fixed, { freshRuling: true });
  expect(await authorize(fresh.gh, repo, 1, { dryRun: true })).toMatchObject({ ok: true, posted: false, items: [] });
});

it("routes a settled synthesis re-read to Pass 3 until its ruling is current", async () => {
  const records = fullPasses.slice(0, 6).map((pass) => record(pass));
  const pending = rereadReview(records, [], { executor: false });
  const step = async (gh: GhClient) => buildStatus(await loadReview(gh, repo, 1, undefined, { ranges: false })).next;
  expect(await step(pending.gh)).toMatchObject({ step: "ruling", blocked: expect.stringContaining("precedes the standing synthesis") });
  const recorded = rereadReview(records, []);
  expect(await step(recorded.gh)).toMatchObject({ step: "ruling" });
  expect(await authorize(recorded.gh, repo, 1, { dryRun: true })).toMatchObject({ ok: false, items: [stale] });
  const fresh = rereadReview(records, [], { freshRuling: true, executor: false });
  expect(await step(fresh.gh)).toMatchObject({ step: "exec" });
  const complete = rereadReview(records, [], { freshRuling: true });
  expect(await step(complete.gh)).toMatchObject({ step: "authorize" });
  expect(await authorize(complete.gh, repo, 1, { dryRun: true })).toMatchObject({ ok: true, posted: false, items: [] });
});

it("names the missing ruling for a settled synthesis even before an executor exists", async () => {
  const { gh } = world({ allPasses: fullPasses, records: fullPasses.slice(0, 5).map((pass) => record(pass)) });
  const message = expect.stringContaining("no valid ruling follows the standing synthesis");
  expect(buildStatus(await loadReview(gh, repo, 1)).next).toMatchObject({ step: "ruling", blocked: message });
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: false, items: expect.arrayContaining([expect.objectContaining({ rule: "ruling", pass: "ruling", message })]),
  });
});

it.each([
  { scenario: "E7 legacy ruling", legacy: "3", stale: false },
  { scenario: "E7b legacy synthesis", legacy: "2.5", stale: false },
  { scenario: "legacy synthesis with a stale ruling", legacy: "2.5", stale: true },
])("routes $scenario to the pass needing a schema v1.2 record", async ({ legacy, stale }) => {
  const records = replayPasses.map((pass) => pass === legacy ? legacyRecord(pass) : record(pass));
  if (stale) [records[4], records[5]] = [records[5]!, records[4]!];
  const { gh } = world({ records, allPasses: replayPasses, configure(config) {
    config.finding_flow = { opens: "1", carries: ["2", "2.5"], ruling: "3" };
  } });
  const message = "authorize requires a schema v1.2 record";
  const result = await authorize(gh, repo, 1, { dryRun: true });
  expect(result).toMatchObject({
    ok: false, items: expect.arrayContaining([expect.objectContaining({ rule: "schema", pass: legacy, message })]),
  });
  if (stale) expect(result.items.some(({ rule, message }) => rule === "ruling" && message.includes("precedes the standing synthesis"))).toBe(true);
  const state = await loadReview(gh, repo, 1, undefined, { ranges: false });
  expect(buildStatus(state).next).toMatchObject({ step: legacy, blocked: message });
});

it("routes an open blocking finding named only by the synthesis to the ruling", async () => {
  const records = fullPasses.map((pass) => record(pass, { findings: pass === "synthesis" ? [rulingFinding] : [] }));
  const { gh } = world({ records, allPasses: fullPasses });
  const message = "blocking finding F9 must be fixed or killed (status: open)";
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({
    ok: false, items: [expect.objectContaining({ rule: "ruling", pass: "synthesis", message })],
  });
  const state = await loadReview(gh, repo, 1, undefined, { ranges: false });
  expect(buildStatus(state).next).toMatchObject({ step: "ruling", blocked: message });
});

it("keeps retry handling for a rejected ruling record", async () => {
  const records = fullPasses.slice(0, 6).map((pass) => record(pass));
  records[5]!.findings = [{ id: "F9", severity: "high", status: "open" }];
  const { gh } = world({ records, allPasses: fullPasses });
  const state = await loadReview(gh, repo, 1, undefined, { ranges: false });
  expect(buildStatus(state).next).toMatchObject({
    step: "ruling", blocked: "record rejected after 1 failed attempt(s); back to the seat",
  });
});

const retry = "record rejected after 1 failed attempt(s); back to the seat";
const needsV12 = "authorize requires a schema v1.2 record";
const settledFinding = { id: "F1", severity: "note", status: "open" } as const;
const contestedFinding = { ...settledFinding, status: "contested" } as const;

it("routes an earlier pass in progress before the missing ruling", async () => {
  const records = ["0", "1", "2", "2.5"].map((pass) => record(pass));
  const { gh } = world({
    records, allPasses: replayPasses, head: rereadHead, changedPath: "docs/notes.md",
    configure(config) { config.finding_flow = { opens: "1", carries: ["2", "2.5"], ruling: "3" }; },
  });
  expect(buildStatus(await loadReview(gh, repo, 1)).next).toMatchObject({
    step: "1.5",
    blocked: "commits pushed after pass 1 and pass 1.5 has no record",
    options: ["wait", "re-route"],
  });
});

it("routes an earlier pass in progress before the legacy synthesis", async () => {
  const records = [record("0"), record("1"), record("2"), legacyRecord("2.5")];
  const { gh } = world({
    records, allPasses: replayPasses, head: rereadHead, changedPath: "docs/notes.md",
    configure(config) { config.finding_flow = { opens: "1", carries: ["2", "2.5"], ruling: "3" }; },
  });
  expect(buildStatus(await loadReview(gh, repo, 1)).next).toMatchObject({
    step: "1.5",
    blocked: "commits pushed after pass 1 and pass 1.5 has no record",
    options: ["wait", "re-route"],
  });
});

it.each([
  { scenario: "N1", missing: "1.5", rejected: 0, fresh: false, legacy: false, step: "1.5", blocked: "no record for pass 1.5" },
  { scenario: "N2", missing: "1.5", rejected: 1, fresh: false, legacy: false, step: "1.5", blocked: retry },
  { scenario: "N3", missing: "1.5", rejected: 3, fresh: false, legacy: false, step: "escalate to Beni", blocked: "pass 1.5 exceeded retry cap 2 after 3 failed attempts" },
  { scenario: "N1 (legacy synthesis)", missing: "1.5", rejected: 0, fresh: false, legacy: true, step: "1.5", blocked: "no record for pass 1.5" },
  { scenario: "N2 (legacy synthesis)", missing: "1.5", rejected: 1, fresh: false, legacy: true, step: "1.5", blocked: retry },
  { scenario: "N3 (legacy synthesis)", missing: "1.5", rejected: 3, fresh: false, legacy: true, step: "escalate to Beni", blocked: "pass 1.5 exceeded retry cap 2 after 3 failed attempts" },
  { scenario: "N3b", missing: "1.5", rejected: 3, fresh: true, legacy: false, step: "escalate to Beni", blocked: "pass 1.5 exceeded retry cap 2 after 3 failed attempts" },
  { scenario: "N4", missing: "3", rejected: 1, fresh: false, legacy: true, step: "2.5", blocked: needsV12 },
  { scenario: "N5", missing: "3", rejected: 3, fresh: false, legacy: true, step: "2.5", blocked: needsV12 },
  { scenario: "N6", missing: "3", rejected: 3, fresh: false, legacy: false, step: "escalate to Beni", blocked: "pass 3 exceeded retry cap 2 after 3 failed attempts" },
])("$scenario routes the first unrecorded pass and preserves schema and retry priority", async ({
  missing, rejected, fresh, legacy, step, blocked,
}) => {
  const records = replayPasses.slice(0, 6).flatMap((pass) => {
    if (pass === missing) {
      return Array.from({ length: rejected }, () => record(pass, {
        findings: [{ ...settledFinding, severity: "high" }],
      }));
    }
    if (pass === "3") return fresh ? [record(pass, { findings: [settledFinding] })] : [];
    if (pass === "2") return [record(pass, { findings: [contestedFinding] })];
    if (pass === "2.5") return [(legacy ? legacyRecord : record)(pass, { findings: [contestedFinding] })];
    return [record(pass, { findings: pass === "1" ? [settledFinding] : [] })];
  });
  const { gh } = world({ records, allPasses: replayPasses, configure(config) {
    config.finding_flow = { opens: "1", carries: ["2", "2.5"], ruling: "3" };
  } });
  expect(buildStatus(await loadReview(gh, repo, 1)).next).toMatchObject({ step, blocked });
});

it.each([
  { scenario: "G1", gate: false, legacy: true, exec: false, settled: true, step: "exec", blocked: "no record for pass exec" },
  { scenario: "G2", gate: false, legacy: true, exec: true, settled: true, step: "authorize", blocked: "no gate configured" },
  { scenario: "G3", gate: false, legacy: false, exec: false, settled: true, step: "exec", blocked: "no record for pass exec" },
  { scenario: "G4", gate: true, legacy: true, exec: false, settled: true, step: "2.5", blocked: needsV12 },
  { scenario: "no gate with an unsettled ruling", gate: false, legacy: true, exec: false, settled: false, step: "3", blocked: "contested finding F1 needs a ruling in pass 3" },
])("$scenario routes schema refusals only when a gate is configured", async ({
  gate, legacy, exec, settled, step, blocked,
}) => {
  const records = replayPasses.slice(0, exec ? 7 : 6).map((pass) => (legacy ? legacyRecord : record)(pass, {
    findings: pass === "3" && settled ? [settledFinding] : pass === "2.5" ? [contestedFinding] : [],
  }));
  const { gh } = world({ records, allPasses: replayPasses, configure(config) {
    config.finding_flow = { opens: "1", carries: ["2", "2.5"], ruling: "3" };
    if (!gate) delete config.gate;
  } });
  expect(buildStatus(await loadReview(gh, repo, 1)).next).toEqual({
    step,
    seat: replayPasses.includes(step) ? `seat ${step}` : null,
    role: replayPasses.includes(step) ? `role ${step}` : null,
    blocked, options: null,
  });
});

const unknownConfigKeyLocations: [string, string, (config: Config) => object][] = [
  ["top-level", "config", (config) => config],
  ["pass", "config.passes[0]", (config) => config.passes[0]!],
  ["finding_flow", "config.finding_flow", (config) => config.finding_flow!],
  ["required_checks", "config.gate.required_checks[0]", (config) => config.gate!.required_checks[0]!],
  ["allowed_changes", "config.gate.allowed_changes", (config) => config.gate!.allowed_changes!],
  ["version_only", "config.gate.allowed_changes.version_only", (config) => config.gate!.allowed_changes!.version_only!],
  ["vendor", "config.vendors.claude", (config) => config.vendors.claude!],
  ["install", "config.installs[0]", (config) => config.installs![0]!],
  ["handoff", "config.handoff", (config) => config.handoff!],
];

type ConfigSplitCase = {
  scenario: string;
  dryRun: boolean;
  change: (gate: GateConfig, config: Config) => void;
  message: string;
  currentSchema?: boolean;
  records?: SeatRecord[];
  docsPush?: boolean;
  expectedNext?: { step: string; blocked: string; options?: string[] };
};

const rejectedRuling = record("3", { findings: [{ id: "F1", severity: "high", status: "open" }] });

it.each(([
  {
    scenario: "with empty required_checks", dryRun: true,
    change(gate: GateConfig) { gate.required_checks = []; },
    message: "config.gate.required_checks must list at least one check",
  },
  {
    scenario: "with an unknown gate key", dryRun: true,
    change(gate: GateConfig) { Object.assign(gate, { unexpected: true }); },
    message: "unknown key config.gate.unexpected",
  },
  {
    scenario: "without allowed_changes", dryRun: true,
    change(gate: GateConfig) { delete gate.allowed_changes; },
    message: "config.gate.allowed_changes is required",
  },
  {
    scenario: "without app_id", dryRun: false,
    change(gate: GateConfig) { delete gate.app_id; },
    message: "authorize requires config.gate.app_id",
  },
  ...unknownConfigKeyLocations.map(([section, location, target]) => ({
    scenario: `with an unknown ${section} key`, dryRun: true,
    change(_gate: GateConfig, config: Config) { Object.assign(target(config), { unexpected: true }); },
    message: `unknown key ${location}.unexpected`,
  })),
  {
    scenario: "with an unknown top-level key (SM28)", dryRun: true, currentSchema: true,
    change(_gate: GateConfig, config: Config) { Object.assign(config, { unexpected: true }); },
    message: "unknown key config.unexpected",
  },
  // Eighth Pass 3, ruling 3: all remaining nextStep arms, with the SM28 control.
  ...[
    {
      scenario: "on a ruling finding",
      records: replayPasses.map((pass) => record(pass, pass === "2.5" ? {
        findings: [{ id: "F1", severity: "blocking", status: "open" }],
      } : {})),
      expectedNext: { step: "3", blocked: "blocking finding F1 must be fixed or killed (status: open)" },
    },
    {
      scenario: "past the retry cap",
      records: [...replayPasses.slice(0, 5).map((pass) => record(pass)), rejectedRuling, rejectedRuling, rejectedRuling],
      expectedNext: { step: "escalate to Beni", blocked: "pass 3 exceeded retry cap 2 after 3 failed attempts" },
    },
    {
      scenario: "within the retry cap",
      records: [...replayPasses.slice(0, 5).map((pass) => record(pass)), rejectedRuling],
      expectedNext: { step: "3", blocked: retry },
    },
    {
      scenario: "in progress",
      records: replayPasses.slice(0, 6).map((pass) => record(pass)),
      docsPush: true,
      expectedNext: { step: "exec", blocked: "commits pushed after pass 3 and pass exec has no record", options: ["wait", "re-route"] },
    },
    {
      scenario: "without a record",
      records: replayPasses.slice(0, 3).map((pass) => record(pass)),
      expectedNext: { step: "2", blocked: "no record for pass 2" },
    },
  ].map((row) => ({
    ...row,
    scenario: `${row.scenario} with an unknown key`,
    dryRun: true,
    change(_gate: GateConfig, config: Config) { Object.assign(config, { unexpected: true }); },
    message: "unknown key config.unexpected",
  })),
] satisfies ConfigSplitCase[]).map((row: ConfigSplitCase) => ({
  ...row,
  route: row.expectedNext ? `to ${row.expectedNext.step}` : row.currentSchema ? "to authorize" : "a legacy synthesis",
})))("routes $route when a gate exists $scenario", async ({
  dryRun, change, message, currentSchema, expectedNext, docsPush,
  records = replayPasses.map((pass) => (pass === "2.5" && !currentSchema ? legacyRecord : record)(pass)),
}) => {
  const options = {
    records, allPasses: replayPasses,
    ...(docsPush ? { head: rereadHead, changedPath: "docs/notes.md", boundary: "2.5" } : {}),
  };
  const configure = (config: Config) => {
    config.finding_flow = { opens: "1", carries: ["2", "2.5"], ruling: "3" };
  };
  const { gh } = world({ ...options, configure(config) {
    configure(config);
    change(config.gate!, config);
  } });
  const next = buildStatus(await loadReview(gh, repo, 1)).next;
  expect([next.seat, next.role]).toEqual(replayPasses.includes(next.step)
    ? [`seat ${next.step}`, `role ${next.step}`] : [null, null]);
  if (expectedNext || currentSchema) {
    const control = world({ ...options, configure });
    expect(next).toMatchObject(expectedNext ?? { step: "authorize", blocked: "authorization required" });
    expect(next).toEqual(buildStatus(await loadReview(control.gh, repo, 1)).next);
  } else {
    expect(next).toMatchObject({ step: "2.5", blocked: needsV12 });
    const control = world({ ...options, configure });
    expect(next).toEqual(buildStatus(await loadReview(control.gh, repo, 1)).next);
  }
  expect(next.options).toEqual(expectedNext?.options ?? null);
  const refusal = { ok: false, items: [{ rule: "config", message }] };
  if (dryRun) {
    expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject(refusal);
    return;
  }
  await withLocalApp(async (origin, requests) => {
    const keys: string[] = [];
    const result = await authorize(gh, repo, 1, { app: makeApp(origin, keys), keychainService: service });
    expect(result).toMatchObject(refusal);
    expect(keys).toEqual([]);
    expect(requests).toEqual([]);
  });
});

it.each(["contested", "omitted", "open"] as const)("routes F7 when a later ruling leaves its status %s", async (status) => {
  const finding = { id: "F7", severity: "note", status: "contested" as const };
  const records = [
    ...fullPasses.slice(0, 4).map((pass) => record(pass)),
    record("synthesis", { findings: [finding] }),
    record("ruling", { findings: status === "omitted" ? [] : [{ ...finding, status }] }),
  ];
  const { gh } = world({ records, allPasses: fullPasses });
  const next = buildStatus(await loadReview(gh, repo, 1, undefined, { ranges: false })).next;
  const complete = world({ records: [...records, record("exec")], allPasses: fullPasses });
  const authorization = await authorize(complete.gh, repo, 1, { dryRun: true });
  if (status === "open") {
    expect(next.step).toBe("exec");
    expect(buildStatus(await loadReview(complete.gh, repo, 1)).next.step).toBe("authorize");
    expect(authorization).toMatchObject({ ok: true, posted: false, items: [] });
  } else {
    const message = "contested finding F7 needs a ruling in pass ruling";
    expect(next).toMatchObject({ step: "ruling", blocked: message });
    expect(authorization).toMatchObject({ ok: false, items: [expect.objectContaining({ rule: "ruling", message })] });
  }
});

it("rejects synthesis and opener replacements posted after the executor", async () => {
  const contested = { id: "F1", severity: "blocking", status: "contested" as const };
  const note = { id: "F2", severity: "note", status: "open" as const };
  const records = fullPasses.map((pass) => record(pass, {
    findings: ["cold", "reply", "synthesis"].includes(pass) ? [contested, note] : [],
  }));
  const replacement = record("synthesis", { findings: [{ ...contested, status: "fixed" }, note] });
  for (const entries of [[replacement], [record("cold", { findings: [note] }), record("synthesis", { findings: [note] })]]) {
    const result = await authorize(world({ allPasses: fullPasses, records: [...records, ...entries], boundary: "synthesis" }).gh,
      repo, 1, { dryRun: true });
    expect(result).toMatchObject({ ok: false, items: expect.arrayContaining([
      expect.objectContaining({ rule: "ruling", finding: "F1" }),
    ]) });
    expect(result.items.filter(({ message }) => message.includes("later pass has recorded"))).toHaveLength(entries.length);
    expect(result.items.some(({ rule }) => rule === "record replacement")).toBe(false);
  }
});

it.each([
  { change: (config: Config) => Object.assign(config.gate!.required_checks[0]!, { app_ide: 15368 }), path: "config.gate.required_checks[0].app_ide" },
  { change: (config: Config) => { delete config.finding_flow!.ruling; }, path: "config.finding_flow.ruling" },
  { change: (config: Config) => { config.gate!.required_checks = []; }, path: "config.gate.required_checks" },
])("refuses invalid authorize policy at $path", async ({ change, path }) => {
  const { gh, calls } = world({ configure: change });
  expect(await authorize(gh, repo, 1, { dryRun: true })).toMatchObject({ ok: false, items: [
    expect.objectContaining({ rule: "config", message: expect.stringContaining(path) }),
  ], baseRef: "trunk", baseSha: sha });
  expect(calls.some((call) => call.includes("check-runs"))).toBe(false);
});
