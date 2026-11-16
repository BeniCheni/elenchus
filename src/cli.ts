#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseConfig } from "./config.js";
import { formatCheck, formatStatus } from "./format.js";
import { cliGh, recordingGh } from "./gh.js";
import { loadReview } from "./load.js";
import { buildCheck, buildStatus } from "./report.js";
import type { Config } from "./types.js";

type Target = { repo: string; pr: number };

function usage(): never {
  console.error("usage: elenchus status <owner/repo#n | pull-url> [--json] [--repo owner/repo] [--config file]");
  console.error("       elenchus check  <owner/repo#n | pull-url> [--repo owner/repo] [--config file]");
  process.exit(2);
}

function parseTarget(arg: string, repoFlag: string | undefined): Target {
  const url = arg.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) return { repo: `${url[1]}/${url[2]}`, pr: Number(url[3]) };
  const hash = arg.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (hash) return { repo: hash[1] ?? "", pr: Number(hash[2]) };
  if (/^\d+$/.test(arg)) {
    if (!repoFlag) usage();
    return { repo: repoFlag, pr: Number(arg) };
  }
  usage();
}

function readArgs(argv: string[]): { cmd: "status" | "check"; json: boolean; config?: Config; target: Target } {
  const [cmd, ...rest] = argv;
  if (cmd !== "status" && cmd !== "check") usage();
  let json = false;
  let configPath: string | undefined;
  let repoFlag: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (arg === "--json") {
      if (cmd !== "status") usage();
      json = true;
    } else if (arg === "--config") {
      configPath = rest[++i];
      if (!configPath) usage();
    } else if (arg === "--repo") {
      repoFlag = rest[++i];
      if (!repoFlag) usage();
    } else if (arg.startsWith("-")) {
      console.error(`unknown flag ${arg}`);
      usage();
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) usage();
  const target = parseTarget(positional[0] ?? "", repoFlag);
  const config = configPath ? parseConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown) : undefined;
  return { cmd, json, ...(config ? { config } : {}), target };
}

async function main(argv: string[]): Promise<void> {
  const args = readArgs(argv);
  const recordDir = process.env.ELENCHUS_RECORD_DIR;
  const gh = recordDir ? recordingGh(cliGh(), recordDir) : cliGh();
  const state = await loadReview(gh, args.target.repo, args.target.pr, args.config);
  if (args.cmd === "status") {
    const view = buildStatus(state);
    process.stdout.write(args.json ? `${JSON.stringify(view, null, 2)}\n` : formatStatus(view));
    return;
  }
  const items = buildCheck(state);
  process.stdout.write(formatCheck(items));
  if (items.some((item) => item.severity === "fail")) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
