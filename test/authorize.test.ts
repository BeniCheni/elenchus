import { generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { AppStatusClient } from "../src/app-status.js";
import { authorize } from "../src/authorize.js";
import type { GhClient } from "../src/gh.js";
import type { SeatRecord } from "../src/types.js";
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
} = {}) {
  const configured = kickoffConfig();
  configured.passes = (options.allPasses ?? ["cold"]).map((id) => ({
    id, role: id, seat: id, ...(options.covered ? { coverage: true } : {}),
  }));
  if (options.allPasses?.includes("ruling")) {
    configured.finding_flow = { opens: "cold", carries: ["reply", "synthesis"], ruling: "ruling" };
  } else delete configured.finding_flow;
  const gate = configured.gate!;
  if (options.changedPath) gate.allowed_changes!.reread_pass = "cold";
  else delete gate.allowed_changes;
  gate.app_id = options.configAppId ?? appId;
  if (options.blockRoute) gate.blocking_unverified.push("route");
  const head = options.head ?? sha;
  const pull = { number: 1, state: options.state ?? "open", head: { sha: head }, base: { ref: "trunk", sha: head } };
  const comments = (options.records ?? [record("cold")]).map((entry, i) =>
    comment(i + 1, fenced(entry), `2026-11-14T00:00:0${i}Z`),
  );
  const calls: string[] = [];
  const gh: GhClient = {
    async get(path, readOptions) {
      calls.push(path);
      const root = `/repos/${options.repo ?? repo}`;
      if (path === `${root}/pulls/1`) return pull;
      if (path === `${root}/commits/heads%2Ftrunk`) return { sha: head };
      if (path === `${root}/issues/1/comments?per_page=100` && readOptions?.paginate) return comments;
      if (path === `${root}/contents/.elenchus.json?ref=${head}`) {
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
        return { status: "ahead", total_commits: 1, commits: [{ sha: head, parents: [{ sha }] }] };
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

async function withLocalApp(test: (origin: string, requests: CapturedRequest[]) => Promise<void>, installationApp = appId) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const captured = { path: request.url, method: request.method, authorization: request.headers.authorization, body };
    requests.push(captured);
    response.setHeader("Content-Type", "application/json");
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
      expect(result).toEqual({ ok: true, posted: true, head: sha, context: "kickoff/360" });
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
      const { gh } = world({ head, records: [record("cold", { input_sha: head, output_sha: head })] });
      await expect(authorize(gh, repo, 1, { app: makeApp(origin, keys), keychainService: service }))
        .rejects.toThrow(/App request refused/);
      expect(requests).toEqual([]);
      expect(keys).toEqual([]);
    });
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
        .resolves.toEqual({ ok: true, posted: false, head: sha, context: "kickoff/360" });
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
    const finding = { id: "F7", severity: "high" };
    const records = [
      record("cold", { findings: [{ ...finding, status: "open" }] }),
      record("reply", { findings: [{ ...finding, status: "contested", disposition: "contest" }] }),
      record("synthesis", { findings: [{ ...finding, status: "contested" }] }),
    ];
    const pending = await authorize(world({ allPasses, records }).gh, repo, 1, { dryRun: true });
    expect(pending).toMatchObject({ ok: false, items: expect.arrayContaining([
      expect.objectContaining({ rule: "ruling", finding: "F7", message: "contested finding F7 needs a ruling in pass ruling" }),
    ]) });
    const resolved = await authorize(world({ allPasses, records: [...records, record("ruling")] }).gh, repo, 1, { dryRun: true });
    expect(resolved).toMatchObject({ ok: true, posted: false });
  });
});

it("authorizes an allowed docs commit without counting its classification notice as a blocker", async () => {
  const head = "b".repeat(40);
  expect(await authorize(world({ head, changedPath: "docs/release.md" }).gh, repo, 1, { dryRun: true }))
    .toMatchObject({ ok: true, head });
  expect(await authorize(world({ head, changedPath: "src/index.ts" }).gh, repo, 1, { dryRun: true }))
    .toMatchObject({ ok: false, items: expect.arrayContaining([expect.objectContaining({
      rule: "head", message: expect.stringContaining("needs a pass cold re-read"),
    })]) });
});
