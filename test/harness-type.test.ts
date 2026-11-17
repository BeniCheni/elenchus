import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("the T4 harness", () => {
  it("typechecks, and its vendor parameter names VendorName", () => {
    const source = readFileSync(new URL("../harness/t4.ts", import.meta.url), "utf8");
    expect(source).toMatch(/vendor: VendorName/);
    expect(source).not.toMatch(/vendor: Vendor[^A-Za-z]/);
    execFileSync(fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url)), ["-p", "harness", "--noEmit"], {
      cwd: root,
      encoding: "utf8",
    });
  });

  it("loads the sources through the harness resolver", () => {
    execFileSync(
      "node",
      [
        "--experimental-transform-types",
        "--import",
        "./harness/register.mjs",
        "-e",
        "import { prepareSeat } from './src/prep.ts'; if (typeof prepareSeat !== 'function') process.exit(1)",
      ],
      { cwd: root, encoding: "utf8" },
    );
  });
});
