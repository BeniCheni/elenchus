import { describe, expect, it } from "vitest";
import { profilePath, renderProfile } from "../src/profile.js";

const forbidden = ["git tag", "git push --force", "git push -f", "git push +", "gh pr merge", "gh release"];

describe("deny profiles", () => {
  it("renders each vendor's form, and adds file-write denies for a read-only seat", () => {
    expect(profilePath("claude")).toBe(".claude/settings.local.json");
    expect(profilePath("cursor")).toBe(".cursor/cli.json");
    expect(profilePath("codex")).toBe("seat.rules");

    const claude = JSON.parse(renderProfile("claude", forbidden, "writing")) as { permissions: { deny: string[] } };
    expect(claude.permissions.deny).toEqual([
      "Bash(git tag *)",
      "Bash(git push --force *)",
      "Bash(git push -f *)",
      "Bash(git push +*)",
      "Bash(gh pr merge *)",
      "Bash(gh release *)",
    ]);
    const claudeRead = JSON.parse(renderProfile("claude", forbidden, "read-only")) as { permissions: { deny: string[] } };
    expect(claudeRead.permissions.deny).toContain("Write");
    expect(claudeRead.permissions.deny).toContain("Edit");

    const cursor = JSON.parse(renderProfile("cursor", forbidden, "writing")) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(cursor.permissions.allow).toEqual([]);
    expect(cursor.permissions.deny).toContain("Shell(git tag)");
    expect(cursor.permissions.deny).toContain("Shell(git push --force)");
    expect(cursor.permissions.deny).toContain("Shell(gh pr merge)");
    expect(cursor.permissions.deny).not.toContain("Write");
    const cursorRead = JSON.parse(renderProfile("cursor", forbidden, "read-only")) as { permissions: { deny: string[] } };
    expect(cursorRead.permissions.deny).toContain("Write");

    const codex = renderProfile("codex", forbidden, "read-only");
    expect(codex).toContain('pattern = ["git", "tag"]');
    expect(codex).toContain('pattern = ["git", "push", "--force"]');
    expect(codex).toContain('pattern = ["git", "push", "+"]');
    expect(codex).toContain('pattern = ["gh", "pr", "merge"]');
    expect(codex).toContain('pattern = ["gh", "release"]');
    expect(codex).toContain('pattern = ["apply_patch"]');
    expect(renderProfile("codex", forbidden, "writing")).not.toContain("apply_patch");
  });
});
