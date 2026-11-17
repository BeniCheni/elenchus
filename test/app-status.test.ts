import { describe, expect, it } from "vitest";
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
