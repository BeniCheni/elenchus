import type { GhClient } from "./gh.js";
import { loadReview } from "./load.js";
import { buildCheck } from "./report.js";
import { formatCheck } from "./format.js";
import { shellQuote } from "./quote.js";
import { sameSha } from "./sha.js";
import type { Config, GhContent, HandoffConfig } from "./types.js";

export async function buildHandoff(
  gh: GhClient,
  repo: string,
  pr: number,
  config?: Config,
  subjectOverride?: string,
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
  const last = state.passes[state.passes.length - 1];
  const lastOutput = last?.outcome.kind === "recorded" ? last.outcome.record.output_sha : "";
  if (!lastOutput || !sameSha(state.head, lastOutput)) {
    throw new Error(`head ${state.head} is not the last recorded output_sha ${lastOutput || "none"}`);
  }
  const headVersion = readVersion(await readContents(gh, repo, handoff.version_file, state.head));
  const baseVersion = readVersion(await readContents(gh, repo, handoff.version_file, state.baseSha));
  if (headVersion === baseVersion) {
    throw new Error(`version did not change: ${handoff.version_file} is ${headVersion} at the head and the base`);
  }
  const heading = substitute(handoff.section_heading, { version: headVersion }, (value) => value);
  const subject = subjectOverride?.trim()
    ? subjectOverride.trim()
    : changelogSubject(await readContents(gh, repo, handoff.changelog, state.head), heading);
  if (!subject) throw new Error(`changelog has no section for ${headVersion}`);
  return renderBlock(handoff, pr, headVersion, subject, repo, state.head);
}

const ABBREVIATIONS = new Set(["vs", "e.g", "i.e", "mr", "mrs", "ms", "dr", "st", "jr", "sr", "etc", "fig", "al", "prof"]);

export function changelogSubject(changelog: string, headingPrefix: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (index < 0) return null;
  const paragraph: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#{3,6}\s/.test(trimmed)) continue;
    if (/^#{1,2}\s/.test(trimmed)) break;
    paragraph.push(trimmed);
  }
  const text = paragraph.join(" ");
  if (!text) return null;
  return firstSentence(text);
}

/** The first sentence, skipping a period that belongs to an abbreviation such as "vs.". */
function firstSentence(text: string): string {
  for (let i = 0; i < text.length; i += 1) {
    const mark = text[i];
    if (mark !== "." && mark !== "!" && mark !== "?") continue;
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    if (mark === "." && abbreviationBefore(text.slice(0, i))) continue;
    return text.slice(0, i + 1);
  }
  return text;
}

function abbreviationBefore(before: string): boolean {
  const word = before.match(/([A-Za-z]+(?:\.[A-Za-z]+)*)$/);
  if (!word?.[1]) return false;
  return ABBREVIATIONS.has(word[1].toLowerCase());
}

export function renderBlock(
  handoff: HandoffConfig,
  pr: number,
  version: string,
  subject: string,
  repo: string,
  head: string,
): string {
  const values = { version, subject, repo, head };
  const tag = fillRaw(handoff.tag, values);
  const tagMessage = fillRaw(handoff.tag_message, values);
  const mergeMessage = fillRaw(handoff.merge_message, values);
  const merge = fillCommand(handoff.merge_command, { ...values, pr: String(pr), merge_message: mergeMessage, tag });
  const lines = [
    merge,
    "git fetch origin main",
    "git merge --ff-only origin/main",
    `git tag -a ${shellQuote(tag)} "$(git rev-parse origin/main)" -m ${shellQuote(tagMessage)}`,
    `git push origin ${shellQuote(`refs/tags/${tag}`)}`,
    ...handoff.green,
  ];
  return `${lines.join(" &&\n")}\n`;
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
