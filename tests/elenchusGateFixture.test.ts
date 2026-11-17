import { expect, it } from "vitest";

it("keeps the gate fixture red for the CI refusal probe", () => {
  expect("intentional gate fixture failure").toBe("green");
});
