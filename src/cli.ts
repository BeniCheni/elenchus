#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseConfig } from "./config.js";
import { formatCheck, formatStatus } from "./format.js";
import { buildHandoff } from "./handoff.js";
import { cliGh, recordingGh } from "./gh.js";
import { loadReview } from "./load.js";
import { formatPrep, prepareSeat } from "./prep.js";
import { buildCheck, buildStatus } from "./report.js";
import type { Config } from "./types.js";

type Target = { repo: string; pr: number };

function usage(): never {
  console.error("usage: elenchus status <owner/repo#n | pull-url> [--json] [--repo owner/repo] [--config file]");
  console.error("       elenchus check  <owner/repo#n | pull-url> [--repo owner/repo] [--config file]");
  console.error("       elenchus prep <owner/repo#n | n> <pass> --runtime <vendor> --model <id> --effort <word> --confirmed-by <name> [--root <dir>] [--repo owner/repo] [--config file]");
  console.error("       elenchus handoff <owner/repo#n | n> [--repo owner/repo] [--config file] [--subject text]");
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

type Flags = {
  json: boolean;
  config?: Config;
  repoFlag?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  confirmedBy?: string;
  root?: string;
  subject?: string;
  positional: string[];
};

function readFlags(argv: string[], command: string): Flags {
  let json = false;
  let configPath: string | undefined;
  let repoFlag: string | undefined;
  let runtime: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let confirmedBy: string | undefined;
  let root: string | undefined;
  let subject: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const take = (name: string): string => {
      const value = argv[++i];
      if (!value) {
        console.error(`${command} requires ${name}`);
        usage();
      }
      return value;
    };
    if (arg === "--json") {
      if (command !== "status") usage();
      json = true;
    } else if (arg === "--config") configPath = take("--config");
    else if (arg === "--repo") repoFlag = take("--repo");
    else if (arg === "--runtime") runtime = take("--runtime");
    else if (arg === "--model") model = take("--model");
    else if (arg === "--effort") effort = take("--effort");
    else if (arg === "--confirmed-by") confirmedBy = take("--confirmed-by");
    else if (arg === "--root") root = take("--root");
    else if (arg === "--subject") {
      if (command !== "handoff") usage();
      subject = take("--subject");
    }
    else if (arg.startsWith("-")) {
      console.error(`unknown flag ${arg}`);
      usage();
    } else positional.push(arg);
  }
  const config = configPath ? parseConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown) : undefined;
  return {
    json,
    ...(config ? { config } : {}),
    ...(repoFlag ? { repoFlag } : {}),
    ...(runtime ? { runtime } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(confirmedBy ? { confirmedBy } : {}),
    ...(root ? { root } : {}),
    ...(subject ? { subject } : {}),
    positional,
  };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "check" && command !== "prep" && command !== "handoff") usage();
  const flags = readFlags(rest, command);
  const recordDir = process.env.ELENCHUS_RECORD_DIR;
  const gh = recordDir ? recordingGh(cliGh(), recordDir) : cliGh();
  if (command === "prep") {
    if (flags.positional.length !== 2) usage();
    const target = parseTarget(flags.positional[0] ?? "", flags.repoFlag);
    const report = await prepareSeat({
      gh,
      repo: target.repo,
      pr: target.pr,
      pass: flags.positional[1] ?? "",
      runtime: flags.runtime ?? "",
      model: flags.model ?? "",
      effort: flags.effort ?? "",
      confirmedBy: flags.confirmedBy ?? "",
      ...(flags.root ? { root: flags.root } : {}),
      ...(flags.config ? { config: flags.config } : {}),
    });
    process.stdout.write(formatPrep(report));
    return;
  }
  if (flags.positional.length !== 1) usage();
  const target = parseTarget(flags.positional[0] ?? "", flags.repoFlag);
  if (command === "handoff") {
    process.stdout.write(await buildHandoff(gh, target.repo, target.pr, flags.config, flags.subject));
    return;
  }
  const state = await loadReview(gh, target.repo, target.pr, flags.config);
  if (command === "status") {
    const view = buildStatus(state);
    process.stdout.write(flags.json ? `${JSON.stringify(view, null, 2)}\n` : formatStatus(view));
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
