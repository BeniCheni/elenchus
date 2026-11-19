import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { AppStatusClient } from "../src/app-status.js";
import { authorize } from "../src/authorize.js";
import type { GhClient } from "../src/gh.js";
import { loadReview } from "../src/load.js";
import { buildCheck, buildStatus } from "../src/report.js";
import type { Config, SeatRecord } from "../src/types.js";
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
  state?: string;
  repo?: string;
  changedPath?: string;
  boundary?: string;
  configure?: (config: Config) => void;
} = {}) {
  const configured = kickoffConfig();
  const allPasses = options.allPasses ?? ["cold", "synthesis", "ruling"];
  configured.passes = allPasses.map((id) => ({
    id, role: id, seat: id, ...(options.covered ? { coverage: true } : {}),
  }));
  configured.finding_flow = { opens: "cold", carries: ["reply", "synthesis"].filter((id) => allPasses.includes(id)), ruling: "ruling" };
  const gate = configured.gate!;
  gate.allowed_changes!.reread_pass = options.boundary ?? allPasses[0]!;
  gate.app_id = options.configAppId ?? appId;
  if (options.blockRoute) gate.blocking_unverified.push("route");
  options.configure?.(configured);
  const head = options.head ?? sha;
  const baseSha = options.changedPath ? sha : head;
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
      if (options.changedPath && path.startsWith(`${root}/compare/${sha}...${head}`)) {
        return {
          status: "ahead", total_commits: 1, commits: [{ sha: head, parents: [{ sha }], commit: {
            author: { name: "Claude", email: "noreply@anthropic.com" },
          } }],
        };
      }
      if (options.changedPath && path.startsWith(`${root}/git/trees/`)) {
        return {
          truncated: false,
          tree: path.includes(head) ? [{ path: options.changedPath, sha: "1".repeat(40), mode: "100644", type: "blob" }] : [],
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

it.each([[[]], [undefined]] as [string[] | undefined][])("refuses empty or missing carries (%j) while nonempty carries evaluate findings", async (carries) => {
  const finding = { id: "F1", severity: "blocking", status: "open" as const };
  const allPasses = ["cold", "reply", "synthesis", "ruling"];
  const records = allPasses.map((pass) => record(pass, { findings: pass === "ruling" ? [] : [finding] }));
  function setup(flow: string[] | undefined) {
    return world({ allPasses, records, configure(config) {
      if (!flow) Reflect.deleteProperty(config.finding_flow!, "carries");
      else config.finding_flow!.carries = flow;
    } }).gh;
  }
  expect(await authorize(setup(carries), repo, 1, { dryRun: true })).toMatchObject({
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
