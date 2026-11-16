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
});
