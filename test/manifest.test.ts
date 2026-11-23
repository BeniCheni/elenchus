import { describe, expect, it } from "vitest";
import { FILE_LIST_CAP, manifestFromCompare, manifestFromNameStatus } from "../src/manifest.js";

describe("coverage manifest", () => {
  it("counts a rename as a deletion and an addition", () => {
    const manifest = manifestFromCompare({
      status: "ahead",
      files: [
        { status: "renamed", filename: "new.ts", previous_filename: "old.ts" },
        { status: "modified", filename: "keep.ts" },
      ],
    });
    expect(manifest.error).toBeNull();
    expect(manifest.paths).toEqual(["old.ts", "new.ts", "keep.ts"]);
  });

  it("fails closed when the file list is missing or at the cap", () => {
    expect(manifestFromCompare({ status: "ahead" }).error).toBe("file list truncated");
    expect(
      manifestFromCompare({
        status: "ahead",
        files: Array.from({ length: FILE_LIST_CAP }, (_, index) => ({ status: "modified", filename: `f${index}` })),
      }).error,
    ).toBe("file list truncated");
  });

  it("reads name-status, including a rename git still printed", () => {
    const entries = manifestFromNameStatus("M\tkeep.ts\nR100\told.ts\tnew.ts\nD\tgone.ts\n");
    expect(entries).toEqual([
      { status: "M", path: "keep.ts" },
      { status: "D", path: "old.ts" },
      { status: "A", path: "new.ts" },
      { status: "D", path: "gone.ts" },
    ]);
  });

  it("splits a NUL record and keeps a non-ASCII path, and counts a type change as a modification", () => {
    const entries = manifestFromNameStatus("A\0café notes.md\0T\0link\0");
    expect(entries).toEqual([
      { status: "A", path: "café notes.md" },
      { status: "M", path: "link" },
    ]);
  });

  it("counts the compare API's changed status as a modification", () => {
    const manifest = manifestFromCompare({
      status: "ahead",
      files: [{ status: "changed", filename: "link" }],
    });
    expect(manifest.error).toBeNull();
    expect(manifest.paths).toEqual(["link"]);
  });

  it("fails closed on a rename with no previous name, an unknown status, and an entry with no name", () => {
    expect(
      manifestFromCompare({ status: "ahead", files: [{ status: "renamed", filename: "new.ts" }] }).error,
    ).toBe("file list truncated");
    expect(
      manifestFromCompare({ status: "ahead", files: [{ status: "weird", filename: "x.ts" }] }).error,
    ).toBe("file status weird is not a manifest status");
    expect(manifestFromCompare({ status: "ahead", files: [{ status: "modified" }] }).error).toBe("file list truncated");
  });
});

it("uses the full tree diff at the compare cap, including deletions, renames, modes and submodules", async () => {
  const { readManifest } = await import("../src/manifest.js");
  const trees = {
    old: {
      tree: [
        { path: "unchanged", sha: "same", mode: "100644", type: "blob" },
        { path: "removed", sha: "deleted", mode: "100644", type: "blob" },
        { path: "renamed-from", sha: "rename", mode: "100644", type: "blob" },
        { path: "mode", sha: "content", mode: "100644", type: "blob" },
        { path: "module", sha: "prior", mode: "160000", type: "commit" },
        { path: "directory", sha: "old-tree", mode: "040000", type: "tree" },
      ],
      truncated: false,
    },
    new: {
      tree: [
        { path: "unchanged", sha: "same", mode: "100644", type: "blob" },
        { path: "added", sha: "new", mode: "100644", type: "blob" },
        { path: "renamed-to", sha: "rename", mode: "100644", type: "blob" },
        { path: "mode", sha: "content", mode: "100755", type: "blob" },
        { path: "module", sha: "next", mode: "160000", type: "commit" },
        { path: "directory", sha: "new-tree", mode: "040000", type: "tree" },
      ],
      truncated: false,
    },
  };
  const calls: string[] = [];
  const gh = { async get(path: string) {
    calls.push(path);
    if (path === "/repos/team/repo/git/trees/old?recursive=1") return trees.old;
    if (path === "/repos/team/repo/git/trees/new?recursive=1") return trees.new;
    throw new Error(path);
  } };
  const result = await readManifest(gh, "team/repo", {
    status: "ahead", files: Array.from({ length: 300 }, () => ({ filename: "truncated", status: "added" })),
    merge_base_commit: { sha: "old" },
  }, "new");
  expect(result).toEqual({ paths: ["removed", "renamed-from", "mode", "module", "added", "renamed-to"], error: null });
  expect(calls).toHaveLength(2);
});
