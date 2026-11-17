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
      "--slurp",
      "/repos/BeniCheni/elenchus/issues/1/comments?per_page=100",
    ]);
    expect(() => assertGhReadOnly(["api", "--method", "GET", "/repos/BeniCheni/elenchus"])).not.toThrow();
    expect(() => assertGhReadOnly(["api", "/repos/BeniCheni/elenchus"])).toThrow(/gh write refused/);
  });

  it("refuses every method but GET and every field flag, without spawning", async () => {
    const spawned: string[] = [];
    const gh = cliGh(async (_command, args) => {
      spawned.push(args.join(" "));
      return "{}";
    });
    for (const method of methods) {
      expect(() => assertGhReadOnly(["api", "--method", method, "/repos/x"])).toThrow(/gh write refused/);
      expect(() => assertGhReadOnly(["api", "--method=" + method, "/repos/x"])).toThrow(/gh write refused/);
      expect(() => assertGhReadOnly(["api", "-X", method, "/repos/x"])).toThrow(/gh write refused/);
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

  it("refuses the write forms a denylist let through, and does not spawn", () => {
    const forms = [
      ["api", "-XPOST", "/x"],
      ["api", "-iXDELETE", "/x"],
      ["api", "/x", "-fbody=x"],
      ["api", "--method", "GET", "-XPATCH", "/x"],
      ["api", "-Fdraft=false", "/x"],
      ["api", "graphql", "-fquery=mutation { add }"],
      ["pr", "merge", "1"],
      ["pr", "comment", "1", "--body", "x"],
      ["repo", "delete", "BeniCheni/elenchus"],
      ["workflow", "run", "ci.yml"],
      ["label", "create", "fixture"],
      ["release", "create", "--title", "x"],
    ];
    for (const args of forms) {
      expect(() => assertGhReadOnly(args)).toThrow(/gh write refused/);
    }
  });

  it("refuses a non-read through GhClient before gh is spawned", async () => {
    let spawned = false;
    const gh = cliGh(async () => {
      spawned = true;
      return "{}";
    });
    await expect(gh.get("-XPOST")).rejects.toThrow(/gh write refused/);
    expect(spawned).toBe(false);
  });
});

it("joins all compare pages without losing the first page's files", async () => {
  const first = { status: "ahead", total_commits: 2, files: [{ filename: "first" }], commits: [{ sha: "a" }] };
  const next = { status: "ahead", total_commits: 2, commits: [{ sha: "b" }] };
  const gh = cliGh(async () => JSON.stringify([first, next]));
  const compared = await gh.get("/repos/test/repo/compare/a...b?per_page=100", { paginate: true });
  expect(compared).toEqual({ ...first, commits: [{ sha: "a" }, { sha: "b" }] });
});
