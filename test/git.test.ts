import { describe, expect, it } from "vitest";
import { assertGitAllowed } from "../src/git.js";

const refused = [
  ["push"],
  ["push", "--force", "origin", "HEAD"],
  ["push", "-f"],
  ["tag", "v9.9.9"],
  ["commit", "-m", "x"],
  ["merge", "main"],
  ["rebase", "main"],
  ["reset", "--hard"],
  ["remote", "add", "origin", "x"],
  ["remote", "set-url", "origin", "x"],
  ["remote", "remove", "origin"],
  ["config", "--global", "user.name", "x"],
  ["config", "--system", "user.name", "x"],
  ["config", "--file", "/tmp/gitconfig", "user.name", "x"],
  ["-C", "/tmp/seat", "push"],
  ["-c", "user.name=x", "status"],
  ["--git-dir", "/tmp/repo", "status"],
  ["worktree", "remove", "seat"],
  ["branch", "-D", "seat"],
  ["checkout", "main"],
];

describe("git wrapper", () => {
  it("allows the operations prep needs, including local config", () => {
    const allowed = [
      ["clone", "--bare", "https://github.com/BeniCheni/elenchus.git", "/tmp/clone"],
      ["-C", "/tmp/clone", "fetch", "origin"],
      ["-C", "/tmp/clone", "worktree", "add", "-b", "seat", "/tmp/seat", "abc1234"],
      ["-C", "/tmp/clone", "worktree", "list", "--porcelain"],
      ["-C", "/tmp/seat", "rev-parse", "HEAD"],
      ["-C", "/tmp/seat", "rev-parse", "--is-inside-work-tree"],
      ["-C", "/tmp/seat", "merge-base", "origin/main", "abc1234"],
      ["-C", "/tmp/seat", "diff", "--name-status", "--no-renames", "abc1234", "def5678"],
      ["-C", "/tmp/seat", "ls-files", "--", ".claude/settings.local.json"],
      ["-C", "/tmp/seat", "status", "--porcelain"],
      ["-C", "/tmp/clone", "config", "branch.seat.remote", "origin"],
      ["-C", "/tmp/clone", "config", "--local", "branch.seat.merge", "refs/heads/main"],
    ];
    for (const args of allowed) expect(() => assertGitAllowed(args)).not.toThrow();
  });

  it("refuses push, tag, commit, merge, rebase, reset, remote changes and global config, without spawning", () => {
    for (const args of refused) {
      expect(() => assertGitAllowed(args), args.join(" ")).toThrow(/git write refused/);
    }
  });
});
