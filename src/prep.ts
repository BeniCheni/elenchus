import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GhClient } from "./gh.js";
import { runCommand } from "./gh.js";
import { assertGitAllowed, type GitScope } from "./git.js";
import { loadReview } from "./load.js";
import { manifestFromNameStatus, type ManifestPath } from "./manifest.js";
import { CODEX_PROFILE_LOADS, codexTrustConfig, profilePath, renderProfile, type VendorName } from "./profile.js";
import { shellQuote } from "./quote.js";
import { sameSha } from "./sha.js";
import type { Config, InstallConfig, ReviewState, SeatKind, VendorConfig } from "./types.js";

export type Runner = (command: string, args: string[], cwd?: string) => Promise<string>;

export type PrepRequest = {
  gh: GhClient;
  repo: string;
  pr: number;
  pass: string;
  runtime: string;
  model: string;
  effort: string;
  confirmedBy: string;
  root?: string;
  config?: Config;
  cloneUrl?: string;
  run?: Runner;
};

export type PrepReport = {
  seat: string;
  head: string;
  installs: string[];
  profile: string;
  /** Set when the profile file is written but is not known to be read. */
  profileNote?: string;
  launch: string;
  stamp: string;
  manifest: string;
  mergeBase: string;
  paths: ManifestPath[];
};

const STAMP = ".elenchus/stamp.json";
const MANIFEST = ".elenchus/manifest.json";
const FETCH = "+refs/heads/*:refs/heads/*";

const RUNTIME_NAMES: Record<VendorName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export function defaultSeatRoot(): string {
  return path.join(homedir(), ".elenchus", "seats");
}

/** Disable hooks for prep's git processes. The setting is the environment, not an argument. */
export function prepGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const parsed = Number(base.GIT_CONFIG_COUNT ?? "0");
  const count = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  return {
    ...base,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${count}`]: "/dev/null",
  };
}

export function cachePath(root: string, repo: string): string {
  return path.join(root, `${repo.replaceAll("/", "__")}.git`);
}

export function seatPath(root: string, repo: string, pr: number, pass: string): string {
  return path.join(root, repo, `pr-${pr}-pass-${pass}`);
}

export async function prepareSeat(request: PrepRequest): Promise<PrepReport> {
  const root = path.resolve(request.root ?? defaultSeatRoot());
  const scope: GitScope = { root, places: [] };
  const run = request.run ?? ((command, args, cwd) => defaultRun(command, args, cwd, scope));
  await refuseRootInsideGit(root, run);
  await mkdir(root, { recursive: true });

  const state = await loadReview(request.gh, request.repo, request.pr, request.config);
  const pass = state.passes.find((item) => item.id === request.pass);
  if (!pass) throw new Error(`pass ${request.pass} is not in the configuration`);
  const seatKind = passSeatKind(state, request.pass);
  if (seatKind === "none") throw new Error(`pass ${request.pass} has no seat`);

  const seat = seatPath(root, request.repo, request.pr, request.pass);
  const cache = cachePath(root, request.repo);
  scope.places.push(cache, seat);

  const open = await openSeats(root, state);
  const gap = firstUnstarted(state, request.pass, new Set(open.map((item) => item.pass)));
  const lines: string[] = [];
  if (open.length > 0) {
    const found = open[0];
    if (found) lines.push(openSeatMessage(found.pass, found.seat));
  }
  if (gap) lines.push(`no valid record for pass ${gap}`);
  if (lines.length > 0) throw new Error(lines.join("\n"));

  if (!request.runtime || !request.model || !request.effort || !request.confirmedBy) {
    throw new Error("prep requires --runtime, --model, --effort and --confirmed-by");
  }
  const vendorName = vendorNameOf(request.runtime);
  const vendor = state.config.vendors[vendorName];
  if (!vendor) throw new Error(`runtime ${request.runtime} is not a configured vendor`);
  if (!Object.hasOwn(vendor.models, request.model)) {
    throw new Error(`model ${request.model} is not in the ${request.runtime} table`);
  }
  if (!Object.hasOwn(vendor.efforts, request.effort)) {
    throw new Error(`effort ${request.effort} is not in the ${request.runtime} table`);
  }
  if (vendorName === "cursor") {
    const suffix = request.model.slice(request.model.lastIndexOf("-") + 1);
    if (suffix !== request.effort) {
      throw new Error(`cursor effort is the model id suffix: ${request.model} is not ${request.effort}`);
    }
  }
  if (seatKind === "read-only" && vendor.read_only_seat !== true) {
    throw new Error(`${request.runtime} may not hold a read-only seat`);
  }

  const expected = expectedSha(state, request.pass);
  if (!sameSha(state.head, expected)) {
    throw new Error(`head ${state.head} is not the expected ${expected}`);
  }

  const installs = state.config.installs;
  const forbidden = state.config.forbidden;
  if (!installs || installs.length === 0) throw new Error("config has no installs");
  if (!forbidden || forbidden.length === 0) throw new Error("config has no forbidden commands");

  const headRef = await headRefOf(request.gh, request.repo, request.pr);
  const cloneUrl = request.cloneUrl ?? `https://github.com/${request.repo}.git`;
  await ensureCache(cache, cloneUrl, run);
  await run("git", ["-C", cache, "fetch", "origin", FETCH]);
  await mkdir(path.dirname(seat), { recursive: true });
  await run("git", [
    "clone",
    "--reference",
    cache,
    "--dissociate",
    "--branch",
    headRef,
    cloneUrl,
    seat,
  ]);
  const head = (await run("git", ["-C", seat, "rev-parse", "HEAD"])).trim();
  if (!sameSha(head, expected)) {
    throw new Error(`head ${head} is not the expected ${expected}`);
  }

  const runtime = runtimeName(vendorName, vendor);
  const stampBody = `${JSON.stringify(
    {
      pr: request.pr,
      pass: request.pass,
      expected_sha: head,
      runtime,
      model: request.model,
      effort: request.effort,
      confirmed_by: request.confirmedBy,
      by_hand: true,
    },
    null,
    2,
  )}\n`;
  await writeExcluded(seat, [{ file: STAMP, body: stampBody }]);

  const profileRel = profilePath(vendorName);
  const tracked = (await run("git", ["-C", seat, "ls-files", "--", profileRel, STAMP, MANIFEST])).trim();
  if (tracked) throw new Error(`profile ${tracked.split("\n")[0]} is tracked at ${head}; refusing to overwrite it`);

  const installed = await installSeat(seat, installs, run);
  await assertSymlinksInside(seat);
  const launch = launchLine(seat, vendorName, request.model, request.effort, seatKind, vendor.binary);
  const mergeBase = (await run("git", ["-C", seat, "merge-base", `origin/${state.baseRef}`, head])).trim();
  const nameStatus = await run("git", [
    "-C",
    seat,
    "diff",
    "-z",
    "--name-status",
    "--no-renames",
    mergeBase,
    head,
  ]);
  const paths = manifestFromNameStatus(nameStatus);
  const manifestBody = `${JSON.stringify({ merge_base: mergeBase, sha: head, paths }, null, 2)}\n`;
  const profileBody = renderProfile(vendorName, forbidden, seatKind);
  await writeExcluded(seat, [
    { file: profileRel, body: profileBody },
    { file: MANIFEST, body: manifestBody },
  ]);
  const status = await run("git", ["-C", seat, "status", "--porcelain"]);
  if (status.length > 0) throw new Error(`git status is not empty:\n${status}`);

  const profileNote = vendorName === "codex" && !CODEX_PROFILE_LOADS ? "the Codex profile is not known to load" : undefined;
  return {
    seat,
    head,
    installs: installed,
    profile: path.join(seat, profileRel),
    ...(profileNote ? { profileNote } : {}),
    launch,
    stamp: path.join(seat, STAMP),
    manifest: path.join(seat, MANIFEST),
    mergeBase,
    paths,
  };
}

export function formatPrep(report: PrepReport): string {
  const counts = { A: 0, D: 0, M: 0 };
  for (const entry of report.paths) counts[entry.status] += 1;
  const lines = [
    `seat: ${report.seat}`,
    `head: ${report.head}`,
    ...report.installs.map((dir) => `install: ${dir}`),
    "symlinks: inside the seat",
    `profile: ${report.profile}`,
    ...(report.profileNote ? [report.profileNote] : []),
    "status: empty",
    `launch: ${report.launch}`,
    `stamp: ${report.stamp}`,
    `manifest: ${report.manifest} merge_base ${report.mergeBase} paths ${report.paths.length} (A ${counts.A}, D ${counts.D}, M ${counts.M})`,
  ];
  return `${lines.join("\n")}\n`;
}

export function openSeatMessage(pass: string, seat: string): string {
  return `open seat for pass ${pass} at ${seat}; removing it (\`rm -rf ${shellQuote(seat)}\`) is how the operator re-routes`;
}

export async function installSeat(seat: string, installs: InstallConfig[], run: Runner): Promise<string[]> {
  const root = await realpath(seat);
  const done: string[] = [];
  for (const install of installs) {
    const requested = path.resolve(seat, install.dir);
    const dir = await realpath(requested).catch(() => path.resolve(root, install.dir));
    if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
      throw new Error(`install ${install.dir} is outside the seat`);
    }
    const lock = path.resolve(dir, install.lockfile);
    if (lock !== dir && !lock.startsWith(`${dir}${path.sep}`)) {
      throw new Error(`lockfile ${install.lockfile} escapes ${install.dir}`);
    }
    const nodeModules = path.join(dir, "node_modules");
    const existing = await lstat(nodeModules).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error(`install at ${install.dir} is a symlink`);
    await assertInside(root, lock);
    await run("npm", ["ci"], dir);
    done.push(install.dir);
  }
  return done;
}

export async function assertSymlinksInside(seat: string): Promise<void> {
  const root = await realpath(seat);
  await walkForSymlinks(root, root);
}

async function walkForSymlinks(dir: string, root: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    const underModules = full.split(path.sep).includes("node_modules");
    if (entry.isSymbolicLink()) {
      if (!underModules) continue;
      const target = await resolvedLink(full);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`symlink ${full} resolves outside the seat (${target})`);
      }
      continue;
    }
    if (entry.isDirectory()) await walkForSymlinks(full, root);
  }
}

export async function writeExcluded(seat: string, files: { file: string; body: string }[]): Promise<void> {
  const gitDir = path.join(seat, ".git");
  const stat = await lstat(gitDir);
  if (!stat.isDirectory()) throw new Error(`seat ${seat} has no git directory of its own`);
  const excludeFile = path.join(gitDir, "info", "exclude");
  await mkdir(path.dirname(excludeFile), { recursive: true });
  const current = await readFile(excludeFile, "utf8").catch(() => "");
  const extras = files.map((entry) => `/${entry.file}`);
  const next = current.endsWith("\n") || current.length === 0 ? current : `${current}\n`;
  const missing = extras.filter((line) => !next.split("\n").includes(line));
  if (missing.length > 0) await writeFile(excludeFile, `${next}${missing.join("\n")}\n`);
  for (const entry of files) {
    const destination = path.join(seat, entry.file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.body);
  }
}

async function ensureCache(cache: string, cloneUrl: string, run: Runner): Promise<void> {
  const exists = await lstat(cache).catch(() => null);
  if (!exists) {
    await mkdir(path.dirname(cache), { recursive: true });
    await run("git", ["clone", "--bare", cloneUrl, cache]);
  }
}

async function headRefOf(gh: GhClient, repo: string, pr: number): Promise<string> {
  const pull = (await gh.get(`/repos/${repo}/pulls/${pr}`)) as {
    head?: { ref?: string; repo?: { full_name?: string } | null };
  };
  if (pull.head?.repo?.full_name !== repo) {
    throw new Error("pull requests from forks are not supported");
  }
  const ref = pull.head?.ref;
  if (!ref) throw new Error("pull request has no head ref");
  return ref;
}

function passSeatKind(state: ReviewState, passId: string): SeatKind {
  const configured = state.config.passes.find((pass) => pass.id === passId);
  if (!configured?.seat_kind) throw new Error(`pass ${passId} has no seat kind in the configuration`);
  return configured.seat_kind;
}

function vendorNameOf(runtime: string): VendorName {
  if (runtime === "claude" || runtime === "codex" || runtime === "cursor") return runtime;
  throw new Error(`runtime ${runtime} is not a configured vendor`);
}

function runtimeName(vendor: VendorName, configured: VendorConfig): string {
  const name = RUNTIME_NAMES[vendor];
  if (!configured.runtimes.includes(name)) throw new Error(`runtime ${name} is not configured for ${vendor}`);
  return name;
}

function expectedSha(state: ReviewState, passId: string): string {
  const index = state.passes.findIndex((pass) => pass.id === passId);
  if (index === 0) return state.head;
  const previous = [...state.passes.slice(0, index)].reverse().find((pass) => pass.outcome.kind === "recorded");
  if (!previous || previous.outcome.kind !== "recorded") {
    throw new Error(`pass ${passId} has no previous record to take a SHA from`);
  }
  return previous.outcome.record.output_sha;
}

/**
 * An open seat is that pass in progress. The sequence line names the first earlier
 * pass that has neither a valid record nor an open seat, so a later prep names the
 * pass that has not been started.
 */
function firstUnstarted(state: ReviewState, passId: string, openPasses: Set<string>): string | null {
  const index = state.passes.findIndex((pass) => pass.id === passId);
  const missing = state.passes
    .slice(0, index)
    .find((pass) => pass.outcome.kind !== "recorded" && !openPasses.has(pass.id));
  return missing?.id ?? null;
}

/**
 * A seat is open when its directory exists and that pass has no valid record.
 * The decision is the directory name and GitHub. Git is not run inside the seat.
 */
async function openSeats(root: string, state: ReviewState): Promise<{ pass: string; seat: string }[]> {
  const repoDir = path.join(root, state.repo);
  let entries;
  try {
    entries = await readdir(repoDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefix = `pr-${state.pr}-pass-`;
  const found: { pass: string; seat: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const passId = entry.name.slice(prefix.length);
    const pass = state.passes.find((item) => item.id === passId);
    if (!pass || pass.outcome.kind === "recorded") continue;
    found.push({ pass: passId, seat: path.join(repoDir, entry.name) });
  }
  return found;
}

function launchLine(
  seat: string,
  vendor: VendorName,
  model: string,
  effort: string,
  kind: SeatKind,
  binary?: string,
): string {
  const prefix = `cd ${shellQuote(seat)} && `;
  if (vendor === "claude") {
    const plan = kind === "read-only" ? " --permission-mode plan" : "";
    return `${prefix}claude --model ${shellQuote(model)} --effort ${shellQuote(effort)}${plan}`;
  }
  if (vendor === "codex") {
    if (!binary) throw new Error("codex binary is not in the configuration");
    const sandbox = kind === "read-only" ? "read-only" : "workspace-write";
    const trust = CODEX_PROFILE_LOADS ? ` -c ${shellQuote(codexTrustConfig(seat))}` : "";
    return `${prefix}${shellQuote(binary)} -m ${shellQuote(model)} -c ${shellQuote(`model_reasoning_effort=${effort}`)} --sandbox ${shellQuote(sandbox)}${trust}`;
  }
  return `${prefix}agent --model ${shellQuote(model)}`;
}

async function refuseRootInsideGit(root: string, run: Runner): Promise<void> {
  const parent = await nearestExisting(root);
  let inside = false;
  try {
    await run("git", ["rev-parse", "--git-dir"], parent);
    inside = true;
  } catch {
    inside = false;
  }
  if (inside) throw new Error(`root ${root} is inside a git directory`);
}

async function nearestExisting(target: string): Promise<string> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stat = await lstat(current);
      if (stat.isDirectory()) return current;
    } catch {
      // The path does not exist yet. Check its parent.
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function assertInside(root: string, file: string): Promise<void> {
  const resolved = await realpath(file).catch(() => null);
  if (!resolved) return;
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path ${file} resolves outside the seat`);
  }
}

async function resolvedLink(link: string): Promise<string> {
  try {
    return await realpath(link);
  } catch {
    const relative = await readlink(link);
    return path.resolve(path.dirname(link), relative);
  }
}

export async function defaultRun(
  command: string,
  args: string[],
  cwd: string | undefined,
  scope: GitScope,
): Promise<string> {
  if (command === "git") {
    assertGitAllowed(args, scope);
    return runCommand(command, args, { ...(cwd ? { cwd } : {}), env: prepGitEnv() });
  }
  if (command !== "npm") throw new Error(`command refused: ${command}`);
  return runCommand(command, args, cwd ? { cwd } : {});
}
