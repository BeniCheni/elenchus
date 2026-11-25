import type { GhClient } from "./gh.js";
import { vendorForRuntime } from "./config.js";
import { loadReview } from "./load.js";
import { buildCheck } from "./report.js";
import { formatCheck } from "./format.js";
import { shellQuote } from "./quote.js";
import { sameSha } from "./sha.js";
import type { Config, GhContent, HandoffConfig, Observed, ReviewState } from "./types.js";

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
  if (!handoff.merge_command.includes("{merge_body}")) {
    throw new Error("config.handoff.merge_command must include {merge_body}");
  }
  for (const field of ["section_heading", "merge_command", "merge_message", "tag", "tag_message"] as const) {
    checkTemplate(field, handoff[field]);
  }
  handoff.green.forEach((command, i) => checkTemplate(`green[${i}]`, command));
  const standingVendors = new Set<string>();
  const lines = state.passes.map(({ id, role, seat, outcome }) => {
    if (outcome.kind !== "recorded") throw new Error(`no valid record for pass ${id}`);
    const { runtime, model, effort } = outcome.record;
    const holder = vendorForRuntime(state.config, runtime);
    if (holder) standingVendors.add(holder.name);
    const count = outcome.history.length > 1 ? ` (${outcome.postings.length} records)` : "";
    return oneLine(`Pass ${id} — ${role}, seat ${seat} — ${runtime}, model ${routeValue(model)}, effort ${routeValue(effort)}${count}`);
  });
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
  const trailers = await coAuthors(state, standingVendors);
  if (trailers.length) lines.push("", ...trailers);
  return renderBlock(gh, handoff, state, headVersion, subject, lines.join("\n"));
}

const controls = /[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g;

function oneLine(text: string): string {
  return text.replace(controls, " ");
}

function checkTemplate(field: string, template: string): void {
  if (oneLine(template) !== template) throw new Error(`config.handoff.${field} contains a control character`);
}

function routeValue(value: Observed): string {
  return value.observed ?? `${value.requested ?? "unspecified"} requested (observed: null, source: ${value.source ?? "absent"})`;
}

async function coAuthors(state: ReviewState, standingVendors: Set<string>): Promise<string[]> {
  // Build commits can predate the first seat. Include the whole PR, excluding the base history.
  const range = await state.compare(state.baseSha, state.head, true);
  if (!range.commits || range.commits.length !== range.total_commits) {
    throw new Error("handoff cannot identify commit authors from an incomplete PR comparison");
  }
  const authors = new Set(range.commits.map(({ commit }) => `${commit?.author?.name} <${commit?.author?.email}>`));
  const trailers = new Set<string>();
  for (const [name, vendor] of Object.entries(state.config.vendors)) {
    const first = vendor.authors[0];
    if (first && (standingVendors.has(name) || vendor.authors.some((author) => authors.has(author)))) {
      trailers.add(`Co-authored-by: ${oneLine(first)}`);
    }
  }
  return [...trailers];
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

// Keep Git's output terminator in the comparison. Command substitution drops trailing LFs.
const checkOrigin = "node -e " + shellQuote([
  'const git = (...args) => require("node:child_process").execFileSync("git", ["remote", "get-url", ...args, "origin"]);',
  'const fetch = git(), push = git("--push", "--all");',
  'const url = new TextDecoder("utf-8", { fatal: true }).decode(fetch.subarray(0, -1));',
  `if (!fetch.equals(push) || fetch.length < 2 || fetch.at(-1) !== 10 || ${controls}.test(url)) process.exit(1);`,
].join(" "));

async function requireAbsentTag(gh: GhClient, repo: string, tag: string): Promise<void> {
  try {
    await gh.get(`/repos/${repo}/git/ref/tags/${tag.split("/").map(encodeURIComponent).join("/")}`);
  } catch (error) {
    if (error instanceof Error && error.message === "gh: Not Found (HTTP 404)") return;
    throw new Error(`handoff cannot establish whether tag ${tag} exists`, { cause: error });
  }
  throw new Error(`tag ${tag} already exists`);
}

async function renderBlock(
  gh: GhClient,
  handoff: HandoffConfig,
  { pr, repo, head, baseRef }: ReviewState,
  version: string,
  subject: string,
  body: string,
): Promise<string> {
  const values = { version, subject, repo, head };
  const tag = oneLine(fillRaw(handoff.tag, values));
  const tagMessage = oneLine(fillRaw(handoff.tag_message, values));
  const mergeMessage = oneLine(fillRaw(handoff.merge_message, values));
  await requireAbsentTag(gh, repo, tag);
  const merge = fillCommand(handoff.merge_command, {
    version: oneLine(version), subject: oneLine(subject), repo: oneLine(repo), head: oneLine(head),
    pr: String(pr), merge_message: mergeMessage, merge_body: body, tag,
  });
  const tagRef = shellQuote(`refs/tags/${tag}`);
  baseRef = oneLine(baseRef);
  const lines = [
    `! git rev-parse -q --verify ${tagRef}`,
    checkOrigin,
    `{ git ls-remote --exit-code origin ${tagRef} >/dev/null; test $? -eq 2; }`,
    merge,
    `merge_commit=$(gh pr view ${shellQuote(String(pr))} --repo ${shellQuote(oneLine(repo))} --json mergeCommit --jq '.mergeCommit.oid // empty')`,
    'test -n "$merge_commit"',
    `git fetch origin ${shellQuote(`refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`)}`,
    `git tag -a ${shellQuote(tag)} "$merge_commit" -m ${shellQuote(tagMessage)}`,
    `git push origin ${tagRef}`,
    `git switch -- ${shellQuote(baseRef)}`,
    `git merge --ff-only ${shellQuote(`refs/remotes/origin/${baseRef}`)}`,
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
  const payload = (await gh.get(`/repos/${repo}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`)) as GhContent;
  if (!payload.content) throw new Error(`no ${file} at ${ref}`);
  return Buffer.from(payload.content, "base64").toString("utf8");
}
