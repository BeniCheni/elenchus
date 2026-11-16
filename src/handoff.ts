import type { GhClient } from "./gh.js";
import { loadReview } from "./load.js";
import { buildCheck } from "./report.js";
import { formatCheck } from "./format.js";
import type { Config, GhContent, HandoffConfig } from "./types.js";

export async function buildHandoff(
  gh: GhClient,
  repo: string,
  pr: number,
  config?: Config,
): Promise<string> {
  const state = await loadReview(gh, repo, pr, config);
  const handoff = state.config.handoff;
  if (!handoff) throw new Error("config has no handoff");
  const missing = state.passes.find((pass) => pass.outcome.kind !== "recorded");
  if (missing) throw new Error(`no valid record for pass ${missing.id}`);
  const items = buildCheck(state);
  const failures = items.filter((item) => item.severity === "fail");
  if (failures.length > 0) {
    throw new Error(`check failed:\n${formatCheck(failures).trimEnd()}`);
  }
  const headVersion = readVersion(await readContents(gh, repo, handoff.version_file, state.head));
  const baseVersion = readVersion(await readContents(gh, repo, handoff.version_file, state.baseSha));
  if (headVersion === baseVersion) {
    throw new Error(`version did not change: ${handoff.version_file} is ${headVersion} at the head and the base`);
  }
  const changelog = await readContents(gh, repo, handoff.changelog, state.head);
  const heading = substitute(handoff.section_heading, { version: headVersion }, (value) => value);
  const subject = changelogSubject(changelog, heading);
  if (!subject) throw new Error(`changelog has no section for ${headVersion}`);
  return renderBlock(handoff, pr, headVersion, subject);
}

export function changelogSubject(changelog: string, headingPrefix: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (index < 0) return null;
  const paragraph: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.startsWith("## ")) break;
    paragraph.push(line.trim());
  }
  const text = paragraph.join(" ");
  if (!text) return null;
  const sentence = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return sentence?.[0] ?? text;
}

export function renderBlock(handoff: HandoffConfig, pr: number, version: string, subject: string): string {
  const values = { version, subject };
  const tag = fillRaw(handoff.tag, values);
  const tagMessage = fillRaw(handoff.tag_message, values);
  const mergeMessage = fillRaw(handoff.merge_message, values);
  const merge = fillCommand(handoff.merge_command, { ...values, pr: String(pr), merge_message: mergeMessage, tag });
  const lines = [
    merge,
    `git tag -a ${shellQuote(tag)} -m ${shellQuote(tagMessage)}`,
    `git push origin ${shellQuote(tag)}`,
    "git pull",
    ...handoff.green,
  ];
  return `${lines.join("\n")}\n`;
}

function fillRaw(template: string, values: Record<string, string>): string {
  return substitute(template, values, (value) => value);
}

function fillCommand(template: string, values: Record<string, string>): string {
  return substitute(template, values, shellQuote);
}

function substitute(template: string, values: Record<string, string>, encode: (value: string) => string): string {
  return template.replace(/\{(\w+)\}/g, (token, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`handoff template ${token} has no value`);
    return encode(value);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readVersion(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`version file is not JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { version?: unknown }).version !== "string") {
    throw new Error("version file has no version string");
  }
  const version = (parsed as { version: string }).version;
  if (version.length === 0) throw new Error("version file has no version string");
  return version;
}

async function readContents(gh: GhClient, repo: string, file: string, ref: string): Promise<string> {
  const payload = (await gh.get(`/repos/${repo}/contents/${file}?ref=${ref}`)) as GhContent;
  if (!payload.content) throw new Error(`no ${file} at ${ref}`);
  return Buffer.from(payload.content, "base64").toString("utf8");
}
