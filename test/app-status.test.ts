import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
import { assertAppRequest } from "../src/app-status.js";

const scope = { repo: "owner/repo", pr: 9, context: "review/ready", installationId: 42 };
const sha = "a".repeat(40);
const lookup = { method: "GET", path: "/repos/owner/repo/installation", credential: "jwt" } as const;
const token = { method: "POST", path: "/app/installations/42/access_tokens", credential: "jwt" } as const;
const status = {
  method: "POST", path: `/repos/owner/repo/statuses/${sha}`, credential: "installation",
  body: { state: "success", context: scope.context, description: "review complete", target_url: "https://github.com/owner/repo/pull/9" },
} as const;

describe("App request allowlist", () => {
  it.each([lookup, token, status])("allows $method $path with its own credential and body", (request) => {
    expect(() => assertAppRequest(request, scope)).not.toThrow();
  });

  it.each([
    { ...lookup, method: "POST" },
    { ...lookup, path: "/repos/owner/other/installation" },
    { ...lookup, credential: "installation" as const },
    { ...lookup, body: {} },
    { ...token, method: "GET" },
    { ...token, path: "/app/installations/43/access_tokens" },
    { ...token, credential: "installation" as const },
    { ...token, body: { permissions: { contents: "write" } } },
    { ...status, method: "PATCH" },
    { ...status, path: status.path.replace("owner/repo", "owner/other") },
    { ...status, path: status.path.slice(0, -1) },
    { ...status, path: status.path.slice(0, -1) + "z" },
    { ...status, path: status.path + "?query" },
    { ...status, credential: "jwt" as const },
    { ...status, body: null },
    { ...status, body: { ...status.body, extra: true } },
    { ...status, body: { ...status.body, target_url: "https://github.com/owner/repo/pull/10" } },
    { ...status, body: { ...status.body, context: "other" } },
    { ...status, body: { ...status.body, description: "" } },
    { ...status, body: { ...status.body, description: "x".repeat(141) } },
    { ...status, body: { ...status.body, state: "failure" } },
    { ...status, body: { ...status.body, state: "pending" } },
    { ...status, body: { state: "success", context: scope.context, description: "missing target" } },
  ])("refuses an unlisted request %#", (request) => {
    expect(() => assertAppRequest(request, scope)).toThrow(/App request refused/);
  });

  it("refuses unsafe scopes even if the requested path matches", () => {
    for (const repo of ["owner/..", "owner/repo?extra", "owner/repo/other", "owner/repo%2Forigin"]) {
      expect(() => assertAppRequest({ ...lookup, path: `/repos/${repo}/installation` }, { ...scope, repo }))
        .toThrow(/App request refused/);
    }
    expect(() => assertAppRequest({ ...token, path: "/app/installations/0/access_tokens" }, { ...scope, installationId: 0 }))
      .toThrow(/App request refused/);
    expect(() => assertAppRequest({
      ...status, body: { ...status.body, target_url: "https://github.com/owner/repo/pull/-4" },
    }, { ...scope, pr: -4 })).toThrow(/App request refused/);
  });
});

describe("Keychain private-key hex decoding", () => {
  it("consumes the hex form of a generated key and clears its input", async () => {
    const { generateKeyPairSync, createPublicKey } = await import("node:crypto");
    const { decodeKeychainPrivateKey } = await import("../src/app-status.js");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const output = Buffer.from(Buffer.from(pem).toString("hex") + "\n");
    const allocation = vi.spyOn(Buffer, "alloc");
    try {
      const decoded = decodeKeychainPrivateKey(output);
      const bytes = allocation.mock.results.find((result) =>
        result.type === "return" && Buffer.isBuffer(result.value) && result.value.length === Buffer.byteLength(pem),
      )?.value as Buffer | undefined;
      expect(createPublicKey(decoded).export({ type: "spki", format: "pem" }))
        .toBe(publicKey.export({ type: "spki", format: "pem" }));
      expect(output.every((byte) => byte === 0)).toBe(true);
      expect(bytes).toBeDefined();
      expect(bytes!.every((byte) => byte === 0)).toBe(true);
    } finally {
      allocation.mockRestore();
    }
  });

  it("refuses raw PEM and malformed hex with the existing message and clears every input", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { decodeKeychainPrivateKey } = await import("../src/app-status.js");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const hex = Buffer.from(pem).toString("hex");
    for (const value of [pem, "", "\n", "a\n", "0g\n", "AB\n", "aa \n", hex, hex + "\r\n", hex + "\n\n", "00\n"]) {
      const output = Buffer.from(value);
      expect(() => decodeKeychainPrivateKey(output))
        .toThrow("could not open the App private key from macOS Keychain");
      expect(output.every((byte) => byte === 0)).toBe(true);
    }
  });
});

it("decodes the key on the real Keychain reader path before signing", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { AppStatusClient } = await import("../src/app-status.js");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const output = Buffer.from(Buffer.from(pem).toString("hex") + "\n");
  const spawn = vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, out: Buffer, stderr: Buffer) => void;
    callback(null, output, Buffer.alloc(0));
    return {} as ReturnType<typeof execFile>;
  });
  const fetchStub = vi.fn(async (url: URL | RequestInfo) => {
    const response = String(url).endsWith("/installation") ? { id: 42, app_id: 10 } :
      String(url).endsWith("/access_tokens") ? { token: "synthetic-installation-token" } : {};
    return new Response(JSON.stringify(response), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchStub);
  try {
    await new AppStatusClient().post({
      repo: "owner/repo", pr: 9, context: "review/ready", sha,
      appId: 10, keychainService: "synthetic-key-service",
    });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/security", ["find-generic-password", "-s", "synthetic-key-service", "-w"],
      { encoding: "buffer" }, expect.any(Function),
    );
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(output.every((byte) => byte === 0)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});
