import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { GhClient } from "./gh.js";
import { runCommand } from "./gh.js";
import { assertGitAllowed } from "./git.js";
import { loadReview } from "./load.js";
import { manifestFromNameStatus, type ManifestPath } from "./manifest.js";
import { profilePath, renderProfile, type VendorName } from "./profile.js";
import { sameSha } from "./sha.js";
import type { Config, InstallConfig, ReviewState, SeatKind } from "./types.js";

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
  worktree: string;
  head: string;
  installs: string[];
  profile: string;
  launch: string;
  stamp: string;
  manifest: string;
  mergeBase: string;
  paths: ManifestPath[];
};

const STAMP = ".elenchus/stamp.json";
const MANIFEST = ".elenchus/manifest.json";

export function defaultSeatRoot(): string {
  return path.join(homedir(), ".elenchus", "seats");
}

export async function prepareSeat(request: PrepRequest): Promise<PrepReport> {
  const run = request.run ?? defaultRun;
  const root = path.resolve(request.root ?? defaultSeatRoot());
  await mkdir(root, { recursive: true });
  await refuseRootInsideWorkTree(root, run);

  const state = await loadReview(request.gh, request.repo, request.pr, request.config);
  const pass = state.passes.find((item) => item.id === request.pass);
  if (!pass) throw new Error(`pass ${request.pass} is not in the configuration`);
  const seatKind = passSeatKind(state, request.pass);
  if (seatKind === "none") throw new Error(`pass ${request.pass} has no seat`);

  const open = await openSeats(root, state, run);
  const gap = firstUnstarted(state, request.pass, new Set(open.map((seat) => seat.pass)));
  const lines: string[] = [];
  if (open.length > 0) {
    const seat = open[0];
    if (seat) {
      lines.push(
        `open seat for pass ${seat.pass} at ${seat.worktree}; removing it (git worktree remove) is how the operator re-routes`,
      );
    }
  }
  if (gap) lines.push(`no valid record for pass ${gap}`);
  if (lines.length > 0) throw new Error(lines.join("\n"));

  if (!request.runtime || !request.model || !request.effort || !request.confirmedBy) {
    throw new Error("prep requires --runtime, --model, --effort and --confirmed-by");
  }
  const vendorName = vendorNameOf(request.runtime);
  const vendor = state.config.vendors[vendorName];
  if (!vendor) throw new Error(`runtime ${request.runtime} is not a configured vendor`);
  if (!vendor.models[request.model]) throw new Error(`model ${request.model} is not in the ${request.runtime} table`);
  if (!vendor.efforts[request.effort]) throw new Error(`effort ${request.effort} is not in the ${request.runtime} table`);
  if (vendorName === "cursor") {
    const suffix = request.model.slice(request.model.lastIndexOf("-") + 1);
    if (suffix !== request.effort) {
      throw new Error(`cursor effort is the model id suffix (S4): ${request.model} is not ${request.effort}`);
    }
  }
  if (seatKind === "read-only" && vendor.read_only_seat !== true) {
    throw new Error(`${request.runtime} may not hold a read-only seat (S7)`);
  }

  const expected = previousOutput(state, request.pass);
  if (!sameSha(state.head, expected)) {
    throw new Error(`head ${state.head} is not the expected ${expected}`);
  }

  const installs = state.config.installs;
  const forbidden = state.config.forbidden;
  if (!installs || installs.length === 0) throw new Error("config has no installs");
  if (!forbidden || forbidden.length === 0) throw new Error("config has no forbidden commands");

  const cloneUrl = request.cloneUrl ?? `https://github.com/${request.repo}.git`;
  const clone = await ensureClone(root, request.repo, cloneUrl, run);
  await run("git", ["-C", clone, "fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  const headRef = await headRefOf(request.gh, request.repo, request.pr);
  const sha = (await run("git", ["-C", clone, "rev-parse", state.head])).trim();
  const worktree = path.join(root, request.repo, `pr-${request.pr}-pass-${request.pass}`);
  const branch = `elenchus-pr-${request.pr}-pass-${request.pass.replaceAll(".", "-")}`;
  await addWorktree(clone, worktree, branch, sha, headRef, run);

  const profileRel = profilePath(vendorName);
  const tracked = (await run("git", ["-C", worktree, "ls-files", "--", profileRel, STAMP, MANIFEST])).trim();
  if (tracked) throw new Error(`profile ${tracked.split("\n")[0]} is tracked at ${sha}; refusing to overwrite it`);

  const installed = await installSeat(worktree, installs, run);
  await assertSymlinksInside(worktree);
  const launch = launchLine(vendorName, request.model, request.effort, seatKind, vendor.binary);
  const mergeBase = (
    await run("git", ["-C", worktree, "merge-base", `origin/${state.baseRef}`, sha])
  ).trim();
  const nameStatus = await run("git", [
    "-C",
    worktree,
    "diff",
    "--name-status",
    "--no-renames",
    mergeBase,
    sha,
  ]);
  const paths = manifestFromNameStatus(nameStatus);
  const stampBody = `${JSON.stringify(
    {
      pr: request.pr,
      pass: request.pass,
      expected_sha: sha,
      runtime: request.runtime,
      model: request.model,
      effort: request.effort,
      confirmed_by: request.confirmedBy,
      by_hand: true,
    },
    null,
    2,
  )}\n`;
  const manifestBody = `${JSON.stringify({ merge_base: mergeBase, sha, paths }, null, 2)}\n`;
  const profileBody = renderProfile(vendorName, forbidden, seatKind);
  await writeExcluded(worktree, [
    { file: profileRel, body: profileBody },
    { file: STAMP, body: stampBody },
    { file: MANIFEST, body: manifestBody },
  ], run);
  const status = await run("git", ["-C", worktree, "status", "--porcelain"]);
  if (status.length > 0) throw new Error(`git status is not empty:\n${status}`);

  return {
    worktree,
    head: sha,
    installs: installed,
    profile: path.join(worktree, profileRel),
    launch,
    stamp: path.join(worktree, STAMP),
    manifest: path.join(worktree, MANIFEST),
    mergeBase,
    paths,
  };
}

export function formatPrep(report: PrepReport): string {
  const counts = { A: 0, D: 0, M: 0 };
  for (const entry of report.paths) counts[entry.status] += 1;
  const lines = [
    `worktree: ${report.worktree}`,
    `head: ${report.head}`,
    ...report.installs.map((dir) => `install: ${dir}`),
    "symlinks: inside the worktree",
    `profile: ${report.profile}`,
    "status: empty",
    `launch: ${report.launch}`,
    `stamp: ${report.stamp}`,
    `manifest: ${report.manifest} merge_base ${report.mergeBase} paths ${report.paths.length} (A ${counts.A}, D ${counts.D}, M ${counts.M})`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function addWorktree(
  clone: string,
  worktree: string,
  branch: string,
  sha: string,
  upstream: string,
  run: Runner,
): Promise<void> {
  await mkdir(path.dirname(worktree), { recursive: true });
  await run("git", ["-C", clone, "worktree", "add", "-b", branch, worktree, sha]);
  await run("git", ["-C", clone, "config", `branch.${branch}.remote`, "origin"]);
  await run("git", ["-C", clone, "config", `branch.${branch}.merge`, `refs/heads/${upstream}`]);
}

export async function installSeat(worktree: string, installs: InstallConfig[], run: Runner): Promise<string[]> {
  const root = await realpath(worktree);
  const done: string[] = [];
  for (const install of installs) {
    const requested = path.resolve(worktree, install.dir);
    const dir = await realpath(requested).catch(() => path.resolve(root, install.dir));
    if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
      throw new Error(`install ${install.dir} is outside the worktree`);
    }
    const lock = path.resolve(dir, install.lockfile);
    if (lock !== dir && !lock.startsWith(`${dir}${path.sep}`)) throw new Error(`lockfile ${install.lockfile} escapes ${install.dir}`);
    const nodeModules = path.join(dir, "node_modules");
    const existing = await lstat(nodeModules).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error(`install at ${install.dir} is a symlink`);
    await assertInside(root, lock);
    await run("npm", ["ci"], dir);
    done.push(install.dir);
  }
  return done;
}

export async function assertSymlinksInside(worktree: string): Promise<void> {
  const root = await realpath(worktree);
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
        throw new Error(`symlink ${full} resolves outside the worktree (${target})`);
      }
      continue;
    }
    if (entry.isDirectory()) await walkForSymlinks(full, root);
  }
}

export async function writeExcluded(
  worktree: string,
  files: { file: string; body: string }[],
  run: Runner,
): Promise<void> {
  const commonRaw = (await run("git", ["-C", worktree, "rev-parse", "--git-common-dir"])).trim();
  const common = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(worktree, commonRaw);
  const excludeFile = path.join(common, "info", "exclude");
  await mkdir(path.dirname(excludeFile), { recursive: true });
  const current = await readFile(excludeFile, "utf8").catch(() => "");
  const extras = files.map((entry) => `/${entry.file}`);
  const next = current.endsWith("\n") || current.length === 0 ? current : `${current}\n`;
  const missing = extras.filter((line) => !next.split("\n").includes(line));
  if (missing.length > 0) await writeFile(excludeFile, `${next}${missing.join("\n")}\n`);
  for (const entry of files) {
    const destination = path.join(worktree, entry.file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.body);
  }
}

async function ensureClone(root: string, repo: string, cloneUrl: string, run: Runner): Promise<string> {
  const clone = path.join(root, `${repo.replaceAll("/", "__")}.git`);
  const exists = await lstat(clone).catch(() => null);
  if (!exists) {
    await mkdir(path.dirname(clone), { recursive: true });
    await run("git", ["clone", "--bare", cloneUrl, clone]);
  }
  return clone;
}

async function headRefOf(gh: GhClient, repo: string, pr: number): Promise<string> {
  const pull = (await gh.get(`/repos/${repo}/pulls/${pr}`)) as { head?: { ref?: string } };
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

function previousOutput(state: ReviewState, passId: string): string {
  const index = state.passes.findIndex((pass) => pass.id === passId);
  const previous = [...state.passes.slice(0, index)].reverse().find((pass) => pass.outcome.kind === "recorded");
  if (!previous || previous.outcome.kind !== "recorded") {
    throw new Error(`pass ${passId} has no previous record to take a SHA from`);
  }
  return previous.outcome.record.output_sha;
}

/**
 * An open worktree is that pass in progress. The sequence line names the first earlier
 * pass that has neither a valid record nor an open worktree, so a later prep names the
 * pass that has not been started.
 */
function firstUnstarted(state: ReviewState, passId: string, openPasses: Set<string>): string | null {
  const index = state.passes.findIndex((pass) => pass.id === passId);
  const missing = state.passes
    .slice(0, index)
    .find((pass) => pass.outcome.kind !== "recorded" && !openPasses.has(pass.id));
  return missing?.id ?? null;
}

async function openSeats(
  root: string,
  state: ReviewState,
  run: Runner,
): Promise<{ pass: string; worktree: string }[]> {
  const rootReal = await realpath(root).catch(() => path.resolve(root));
  const prefix = path.join(rootReal, state.repo);
  let listed = "";
  try {
    const clone = path.join(root, `${state.repo.replaceAll("/", "__")}.git`);
    const exists = await lstat(clone).catch(() => null);
    if (!exists) return [];
    listed = await run("git", ["-C", clone, "worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const found: { pass: string; worktree: string }[] = [];
  for (const block of listed.split("\n\n")) {
    const line = block.split("\n").find((item) => item.startsWith("worktree "));
    if (!line) continue;
    const worktree = await realpath(line.slice("worktree ".length)).catch(() => line.slice("worktree ".length));
    if (worktree !== prefix && !worktree.startsWith(`${prefix}${path.sep}`)) continue;
    const stampPath = path.join(worktree, STAMP);
    const raw = await readFile(stampPath, "utf8").catch(() => null);
    if (!raw) continue;
    let stamp: { pr?: unknown; pass?: unknown };
    try {
      stamp = JSON.parse(raw) as { pr?: unknown; pass?: unknown };
    } catch {
      continue;
    }
    if (stamp.pr !== state.pr || typeof stamp.pass !== "string") continue;
    const pass = state.passes.find((item) => item.id === stamp.pass);
    if (pass && pass.outcome.kind === "recorded") continue;
    found.push({ pass: stamp.pass, worktree });
  }
  return found;
}

function launchLine(vendor: VendorName, model: string, effort: string, kind: SeatKind, binary?: string): string {
  if (vendor === "claude") {
    const plan = kind === "read-only" ? " --permission-mode plan" : "";
    return `claude --model ${model} --effort ${effort}${plan}`;
  }
  if (vendor === "codex") {
    if (!binary) throw new Error("codex binary is not in the configuration");
    const sandbox = kind === "read-only" ? "read-only" : "workspace-write";
    return `${binary} -m ${model} -c model_reasoning_effort=${effort} --sandbox ${sandbox}`;
  }
  return `agent --model ${model}`;
}

async function refuseRootInsideWorkTree(root: string, run: Runner): Promise<void> {
  try {
    const inside = (await run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"])).trim();
    if (inside === "true") throw new Error(`root ${root} is inside a git working tree`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("root ")) throw error;
  }
}

async function assertInside(root: string, file: string): Promise<void> {
  const resolved = await realpath(file).catch(() => null);
  if (!resolved) return;
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path ${file} resolves outside the worktree`);
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

async function defaultRun(command: string, args: string[], cwd?: string): Promise<string> {
  if (command === "git") assertGitAllowed(args);
  else if (command !== "npm") throw new Error(`command refused: ${command}`);
  return runCommand(command, args, cwd ? { cwd } : {});
}
