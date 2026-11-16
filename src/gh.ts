import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

export type GhGetOptions = { paginate?: boolean };

export interface GhClient {
  get(apiPath: string, options?: GhGetOptions): Promise<unknown>;
}

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

/** Refuse any gh invocation that is not a GET, or that carries a field flag. */
export function assertGhReadOnly(args: string[]): void {
  for (const arg of args) {
    const name = arg.split("=", 1)[0] ?? arg;
    if (FIELD_FLAGS.has(name)) {
      throw new Error(`gh write refused: ${name}`);
    }
  }
  let method = "GET";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--method" || arg === "-X") {
      method = args[i + 1] ?? "";
    } else if (arg.startsWith("--method=") || arg.startsWith("-X=")) {
      method = arg.slice(arg.indexOf("=") + 1);
    }
  }
  if (method.toUpperCase() !== "GET") {
    throw new Error(`gh write refused: method ${method}`);
  }
}

export function ghApiArgs(apiPath: string, options?: GhGetOptions): string[] {
  const args = ["api", "--method", "GET"];
  if (options?.paginate) args.push("--paginate");
  args.push(apiPath);
  assertGhReadOnly(args);
  return args;
}

export function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      return JSON.parse(stdout) as unknown;
    },
  };
}

export function recordingGh(inner: GhClient, dir: string): GhClient {
  mkdirSync(dir, { recursive: true });
  return {
    async get(apiPath, options) {
      const value = await inner.get(apiPath, options);
      const file = path.join(dir, `${encodeURIComponent(apiPath)}.json`);
      writeFileSync(file, JSON.stringify(value));
      return value;
    },
  };
}
