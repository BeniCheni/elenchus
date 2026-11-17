import { expect, it } from "vitest";
import { readGateStatus } from "../src/gate-status.js";

const gate = { context: "review/ready", app_id: 42, required_checks: [], blocking_unverified: [] };
const head = "a".repeat(40);
const limitation = "; source UNVERIFIED because GitHub's status API does not report which App posted it; the review gate's ruleset decides whether it counts";

function statusesOnly(statuses: object[]) {
  return {
    async get(path: string, options?: { paginate?: boolean }) {
      expect(path).toBe(`/repos/team/repo/commits/${head}/statuses?per_page=100`);
      expect(options).toEqual({ paginate: true });
      return statuses;
    },
  };
}

it("names no status when the configured context is absent", async () => {
  expect(await readGateStatus(statusesOnly([]), "team/repo", head, gate)).toBe("no status");
  expect(await readGateStatus(statusesOnly([
    { context: "other", state: "success", creator: { login: "admin", type: "User" } },
  ]), "team/repo", head, gate)).toBe("no status");
});

it("names every matching status's state and creator without inferring its App integration", async () => {
  const statuses = [
    { context: "REVIEW/READY", state: "success", creator: { login: "controller[bot]", type: "Bot" } },
    { context: gate.context, state: "failure", creator: { login: "admin", type: "User" } },
    { context: gate.context, state: "pending", creator: { login: "controller[bot]", type: "Bot" } },
    { context: "other", state: "success", creator: { login: "unrelated", type: "User" } },
  ];
  expect(await readGateStatus(statusesOnly(statuses), "team/repo", head, gate)).toBe(
    "success by controller[bot] (Bot), failure by admin (User), pending by controller[bot] (Bot)" + limitation,
  );
});

it("keeps absent creator metadata unverified", async () => {
  expect(await readGateStatus(statusesOnly([
    { context: gate.context, state: "error" },
  ]), "team/repo", head, gate)).toBe("error by unknown (unknown)" + limitation);
});
