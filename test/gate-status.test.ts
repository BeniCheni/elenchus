import { expect, it } from "vitest";
import { readGateStatus } from "../src/gate-status.js";

it("names no status, a matching App and the non-counting statuses by creator", async () => {
  const gate = { context: "review/ready", app_id: 42, required_checks: [], blocking_unverified: [] };
  const make = (login: string, type: string) => ({
    context: gate.context, state: "success", creator: { login, type },
  });
  const statuses: object[] = [{ ...make("unrelated", "User"), context: "other" }];
  const gh = {
    async get(path: string) {
      if (path.includes("/statuses?")) return statuses;
      if (path === "/apps/controller") return { id: 42 };
      if (path === "/apps/other") return { id: 5 };
      throw new Error(`unexpected ${path}`);
    },
  };
  const head = "a".repeat(40);
  expect(await readGateStatus(gh, "team/repo", head, gate)).toBe("no status");
  statuses.push(make("admin", "User"), make("other[bot]", "Bot"), make("controller[bot]", "Bot"));
  expect(await readGateStatus(gh, "team/repo", head, gate)).toBe(
    "success by controller[bot] (App 42), success by admin (does not count), success by other[bot] (does not count)",
  );
});
