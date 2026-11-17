import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type GhGetOptions = { paginate?: boolean };

export interface GhClient {
  get(apiPath: string, options?: GhGetOptions): Promise<unknown>;
}

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

/**
 * Allow exactly `api --method GET [--paginate --slurp] /path`.
 * Anything else is refused before gh is spawned.
 */
export function assertGhReadOnly(args: string[]): void {
  if (readPath(args) === null) throw new Error(`gh write refused: ${args.join(" ")}`);
}

function readPath(args: string[]): string | null {
  if (args[0] !== "api" || args[1] !== "--method" || args[2] !== "GET") return null;
  if (args.length === 4) return args[3]?.startsWith("/") ? args[3] : null;
  if (args.length === 6 && args[3] === "--paginate" && args[4] === "--slurp") return args[5]?.startsWith("/") ? args[5] : null;
  return null;
}

export function ghApiArgs(apiPath: string, options?: GhGetOptions): string[] {
  const args = ["api", "--method", "GET"];
  if (options?.paginate) args.push("--paginate", "--slurp");
  args.push(apiPath);
  assertGhReadOnly(args);
  return args;
}

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || out.trim() || `${command} exited ${code}`));
        return;
      }
      resolve(out);
    });
  });
}

export function cliGh(run: CommandRunner = runCommand): GhClient {
  return {
    async get(apiPath, options) {
      const args = ghApiArgs(apiPath, options);
      const stdout = await run("gh", args);
      const result = JSON.parse(stdout) as unknown;
      return options?.paginate ? combinePages(result, apiPath) : result;
    },
  };
}

function combinePages(value: unknown, apiPath: string): unknown {
  if (!Array.isArray(value)) throw new Error("gh pagination did not return pages");
  if (value.every(Array.isArray)) return value.flat();
  const key = apiPath.includes("/compare/") ? "commits" : apiPath.includes("/check-runs?") ? "check_runs" : null;
  if (!key || !value.every((page) => page && typeof page === "object" && Array.isArray(page[key]))) {
    throw new Error("gh pagination returned an unexpected page shape");
  }
  return { ...value[0], [key]: value.flatMap((page) => page[key]) };
}

export function recordingGh(inner: GhClient, dir: string): GhClient {
  mkdirSync(dir, { recursive: true });
  return {
    async get(apiPath, options) {
      const value = await inner.get(apiPath, options);
      const file = path.join(dir, `${encodeURIComponent(apiPath)}.json`);
      writeFileSync(file, JSON.stringify(slimCompare(value)));
      return value;
    },
  };
}

/** Compare responses carry the whole diff. Records keep each file's name, previous name and status. */
function slimCompare(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.commits) || !Array.isArray(record.files)) return value;
  return {
    ...record,
    files: record.files.map((file) => {
      if (!file || typeof file !== "object") return file;
      const raw = file as Record<string, unknown>;
      const slim: Record<string, unknown> = {};
      if ("filename" in raw) slim.filename = raw.filename;
      if ("previous_filename" in raw) slim.previous_filename = raw.previous_filename;
      if ("status" in raw) slim.status = raw.status;
      return slim;
    }),
  };
}
