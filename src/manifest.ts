import type { GhClient } from "./gh.js";

import type { GhCompare, GhCompareFile } from "./types.js";

export type ManifestPath = { status: "A" | "D" | "M"; path: string };

/**
 * GitHub's compare payload has no file total. The documented cap is 300 files,
 * and a list that long cannot be told from a truncated one, so it fails closed.
 */
export const FILE_LIST_CAP = 300;

export function manifestFromCompare(compare: GhCompare): { paths: string[]; error: string | null } {
  if (!Array.isArray(compare.files)) return { paths: [], error: "file list truncated" };
  if (compare.files.length >= FILE_LIST_CAP) return { paths: [], error: "file list truncated" };
  const paths: string[] = [];
  for (const file of compare.files) {
    const expanded = expandFile(file);
    if (typeof expanded === "string") return { paths: [], error: expanded };
    paths.push(...expanded);
  }
  return { paths, error: null };
}

/** A rename is a deletion of the old path and an addition of the new one, as `--no-renames` prints. */
function expandFile(file: GhCompareFile): string[] | string {
  const status = file.status;
  const name = file.filename;
  if (!status || !name) return "file list truncated";
  if (status === "renamed") {
    if (!file.previous_filename) return "file list truncated";
    return [file.previous_filename, name];
  }
  if (
    status === "added" ||
    status === "removed" ||
    status === "modified" ||
    status === "copied" ||
    status === "changed"
  ) {
    return [name];
  }
  return `file status ${status} is not a manifest status`;
}

export function manifestFromNameStatus(text: string): ManifestPath[] {
  if (text.includes("\0")) return parseNameStatus(text.split("\0"));
  const lines = text.split("\n").filter((line) => line.length > 0);
  const records: string[] = [];
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 0) throw new Error(`manifest line has no path: ${line}`);
    records.push(line.slice(0, tab), ...line.slice(tab + 1).split("\t"));
  }
  return parseNameStatus(records);
}

/** A type change is a modification. Paths are the raw names `-z` prints, quotes included nowhere. */
function parseNameStatus(records: string[]): ManifestPath[] {
  const entries: ManifestPath[] = [];
  let index = 0;
  while (index < records.length) {
    const status = records[index];
    if (status === undefined || status.length === 0) {
      index += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = records[index + 1];
      const to = records[index + 2];
      if (!from || !to) throw new Error(`manifest rename has no both paths: ${status}`);
      if (status.startsWith("R")) entries.push({ status: "D", path: from });
      entries.push({ status: "A", path: to });
      index += 3;
      continue;
    }
    const filePath = records[index + 1];
    if (!filePath) throw new Error(`manifest line has no path: ${status}`);
    if (status === "A" || status === "D" || status === "M" || status === "T") {
      entries.push({ status: status === "T" ? "M" : status, path: filePath });
      index += 2;
      continue;
    }
    throw new Error(`manifest status ${status} is not A, D or M`);
  }
  return entries;
}

type TreeEntry = { path: string; mode: string; type: string; sha: string };
type GitTree = { tree: TreeEntry[]; truncated: boolean };
type Manifest = { paths: string[]; error: string | null };

export async function readManifest(
  gh: GhClient,
  repo: string,
  compare: GhCompare,
  input: string,
): Promise<Manifest> {
  const direct = manifestFromCompare(compare);
  if (direct.error !== "file list truncated") return direct;
  const base = compare.merge_base_commit?.sha;
  if (!base) throw new Error("compare returned no merge base for the coverage manifest");
  const [from, to] = await Promise.all([readTree(gh, repo, base), readTree(gh, repo, input)]);
  if (from.truncated || to.truncated) return { paths: [], error: "recursive git tree truncated" };
  return { paths: diffTrees(from.tree, to.tree).map(({ path }) => path), error: null };
}

export async function readTree(gh: GhClient, repo: string, ref: string): Promise<GitTree> {
  return await gh.get(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`) as GitTree;
}

/** Compare the path, mode, and object of every file, symlink, and submodule. */
export function diffTrees(from: TreeEntry[], to: TreeEntry[]): ManifestPath[] {
  const before = leafEntries(from);
  const after = leafEntries(to);
  const changes: ManifestPath[] = [];
  for (const [path, entry] of before) {
    const next = after.get(path);
    if (!next) changes.push({ path, status: "D" });
    else if (next.sha !== entry.sha || next.mode !== entry.mode) changes.push({ path, status: "M" });
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changes.push({ path, status: "A" });
  }
  return changes;
}

function leafEntries(tree: TreeEntry[]): Map<string, TreeEntry> {
  return new Map(tree.filter((entry) => entry.type !== "tree").map((entry) => [entry.path, entry]));
}
