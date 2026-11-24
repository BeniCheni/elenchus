import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

it("lists the CLI entry point and record schema in the tarball from an unbuilt source tree", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "elenchus-package-"));
  try {
    for (const file of ["package.json", "tsconfig.json", "tsconfig.build.json", "src", "schema"]) {
      cpSync(path.join(root, file), path.join(cwd, file), { recursive: true });
    }
    symlinkSync(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "dir");
    execFileSync("npm", ["pack", "--offline", "--silent"], { cwd });
    const files = execFileSync("tar", ["-tzf", "elenchus-0.0.0.tgz"], { cwd, encoding: "utf8" }).split("\n");
    expect(files).toContain("package/dist/cli.js");
    expect(files).toContain("package/schema/seat-record-1.2.json");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
