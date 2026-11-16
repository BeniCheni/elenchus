import { describe, expect, it } from "vitest";
import { assertGhReadOnly, cliGh, ghApiArgs } from "../src/gh.js";

const refused = ["-f", "-F", "--field", "--raw-field", "--input", "--field=body", "-f=name=a"];
const methods = ["POST", "PUT", "PATCH", "DELETE", "post"];

describe("gh read-only wrapper", () => {
  it("allows a GET, including a paginated list", () => {
    expect(ghApiArgs("/repos/BeniCheni/elenchus/pulls/1")).toEqual([
      "api",
      "--method",
      "GET",
      "/repos/BeniCheni/elenchus/pulls/1",
    ]);
    expect(ghApiArgs("/repos/BeniCheni/elenchus/issues/1/comments?per_page=100", { paginate: true })).toEqual([
      "api",
      "--method",
      "GET",
      "--paginate",
      "/repos/BeniCheni/elenchus/issues/1/comments?per_page=100",
    ]);
    expect(() => assertGhReadOnly(["api", "/repos/BeniCheni/elenchus"])).not.toThrow();
  });

  it("refuses every method but GET and every field flag, without spawning", async () => {
    const spawned: string[] = [];
    const gh = cliGh(async (_command, args) => {
      spawned.push(args.join(" "));
      return "{}";
    });
    for (const method of methods) {
      expect(() => assertGhReadOnly(["api", "--method", method, "/repos/x"])).toThrow(/gh write refused: method/);
      expect(() => assertGhReadOnly(["api", "--method=" + method, "/repos/x"])).toThrow(/gh write refused: method/);
      expect(() => assertGhReadOnly(["api", "-X", method, "/repos/x"])).toThrow(/gh write refused: method/);
    }
    for (const flag of refused) {
      expect(() => assertGhReadOnly(["api", "--method", "GET", flag, "name=value"])).toThrow(/gh write refused/);
    }
    await expect(gh.get("/repos/x")).resolves.toEqual({});
    await expect(
      cliGh(async () => {
        throw new Error("spawned");
      }).get("/repos/x"),
    ).rejects.toThrow(/spawned/);
    expect(spawned).toEqual(["api --method GET /repos/x"]);
  });
});
