import { execFile } from "node:child_process";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

type AppRequest = {
  method: string;
  path: string;
  credential: "jwt" | "installation";
  body?: unknown;
};

type StatusTarget = {
  repo: string;
  pr: number;
  context: string;
};

type RequestScope = StatusTarget & { installationId?: number };

type AuthorizationTarget = StatusTarget & {
  appId: number;
  sha: string;
  keychainService: string;
};

const SHA = /^[0-9a-f]{40}$/i;

export function assertAppRequest(request: AppRequest, scope: RequestScope): void {
  const root = `/repos/${scope.repo}`;
  const statusPrefix = `${root}/statuses/`;
  const repoIsSafe = /^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(scope.repo) && !/\/\.{1,2}$/.test(scope.repo);
  if (repoIsSafe) {
    if (request.method === "GET" && request.path === `${root}/installation` &&
        request.credential === "jwt" && request.body === undefined) return;
    if (isPositiveId(scope.installationId) && request.method === "POST" &&
        request.path === `/app/installations/${scope.installationId}/access_tokens` &&
        request.credential === "jwt" && request.body === undefined) return;
    if (request.method === "POST" && request.path.startsWith(statusPrefix) &&
        SHA.test(request.path.slice(statusPrefix.length)) && request.credential === "installation" &&
        validStatusBody(request.body, scope)) return;
  }
  throw new Error("App request refused by the allowlist");
}

function validStatusBody(body: unknown, target: StatusTarget): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  if (Object.keys(body).sort().join(",") !== "context,description,state,target_url") return false;
  const value = body as Record<string, unknown>;
  return value.state === "success" && typeof value.context === "string" && value.context.length > 0 &&
    value.context === target.context && typeof value.description === "string" &&
    value.description.length > 0 && value.description.length <= 140 &&
    isPositiveId(target.pr) && value.target_url === pullUrl(target);
}

function pullUrl(target: StatusTarget): string {
  return `https://github.com/${target.repo}/pull/${target.pr}`;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The App's only operation. The origin and key reader are injectable for local tests. */
export class AppStatusClient {
  constructor(
    private origin = "https://api.github.com",
    private readKey = keychainPrivateKey,
  ) {}

  async post(target: AuthorizationTarget): Promise<void> {
    const installationRequest = this.prepare({
      method: "GET",
      path: `/repos/${target.repo}/installation`,
      credential: "jwt",
    }, target);
    const statusRequest = this.prepare({
      method: "POST",
      path: `/repos/${target.repo}/statuses/${target.sha}`,
      credential: "installation",
      body: {
        state: "success",
        context: target.context,
        description: "Review complete at this commit",
        target_url: pullUrl(target),
      },
    }, target);

    if (!isPositiveId(target.appId)) throw new Error("config.gate.app_id must identify the installed App");
    if (!target.keychainService) throw new Error("authorize requires --app-keychain-service");
    const jwt = appJwt(target.appId, await this.readKey(target.keychainService));
    const installation = await installationRequest(jwt) as { id?: number; app_id?: number } | null;
    if (!isPositiveId(installation?.id) || installation?.app_id !== target.appId) {
      throw new Error("GitHub returned no installation for the configured App");
    }
    const installationId = installation.id;
    const tokenRequest = this.prepare({
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      credential: "jwt",
    }, { ...target, installationId });
    const { token } = await tokenRequest(jwt) as { token?: string };
    if (typeof token !== "string" || token.length === 0) throw new Error("GitHub returned no installation token");
    await statusRequest(token);
  }

  private prepare(request: AppRequest, scope: RequestScope): (token: string) => Promise<unknown> {
    assertAppRequest(request, scope);
    const url = new URL(request.path, this.origin);
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    return async (token) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: request.method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body,
        });
      } catch {
        throw new Error(`GitHub App ${request.method} ${request.path} could not connect`);
      }
      if (!response.ok) throw new Error(`GitHub App ${request.method} ${request.path} returned HTTP ${response.status}`);
      return response.json().catch(() => {
        throw new Error(`GitHub App ${request.method} ${request.path} returned invalid JSON`);
      });
    };
  }
}

function appJwt(id: number, key: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(id) })}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
}

function keychainPrivateKey(service: string): Promise<KeyObject> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { encoding: "buffer" }, (error, data) => {
      try {
        if (error) throw error;
        resolve(decodeKeychainPrivateKey(data));
      } catch {
        reject(new Error("could not open the App private key from macOS Keychain"));
      } finally {
        data.fill(0);
      }
    });
  });
}

/** Consume SecurityTool's lowercase hex plus one newline, clearing both buffers. */
export function decodeKeychainPrivateKey(output: Buffer): KeyObject {
  let decoded: Buffer | undefined;
  try {
    const length = output.length - 1;
    if (output[length] !== 10 || length <= 0 || length % 2 !== 0) throw new Error();
    const hex = output.subarray(0, length);
    if (!hex.every((byte) => (byte >= 48 && byte <= 57) || (byte >= 97 && byte <= 102))) {
      throw new Error();
    }
    decoded = Buffer.alloc(length / 2);
    const digit = (byte: number) => byte <= 57 ? byte - 48 : byte - 87;
    for (let i = 0; i < length; i += 2) {
      decoded[i / 2] = digit(hex[i]!) * 16 + digit(hex[i + 1]!);
    }
    return createPrivateKey(decoded);
  } catch {
    throw new Error("could not open the App private key from macOS Keychain");
  } finally {
    decoded?.fill(0);
    output.fill(0);
  }
}
