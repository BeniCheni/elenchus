import { describe, expect, it } from "vitest";
import { assertGitAllowed, type GitScope } from "../src/git.js";

const scope: GitScope = {
  root: "/tmp/elenchus-root",
  places: ["/tmp/elenchus-root/cache.git", "/tmp/elenchus-root/BeniCheni/elenchus/pr-3-pass-1"],
};
const cache = scope.places[0] ?? "";
const seat = scope.places[1] ?? "";

const allowed = [
  ["clone", "--bare", "https://github.com/BeniCheni/elenchus.git", cache],
  ["clone", "--reference", cache, "--dissociate", "--no-checkout", "--branch", "feature", "/tmp/origin.git", seat],
  ["-C", seat, "checkout", "--force", "HEAD"],
  ["-C", cache, "fetch", "origin", "+refs/heads/*:refs/heads/*"],
  ["-C", seat, "rev-parse", "HEAD"],
  ["-C", seat, "merge-base", "origin/main", "abc1234"],
  ["-C", seat, "diff", "-z", "--name-status", "--no-renames", "abc1234", "def5678"],
  ["-C", seat, "ls-files", "--", ".claude/settings.local.json", ".elenchus/stamp.json"],
  ["-C", seat, "status", "--porcelain"],
  ["rev-parse", "--git-dir"],
];

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
  ["config", "--glob", "user.name", "x"],
  ["config", "-f", "/tmp/gitconfig", "a.b", "c"],
  ["-C", "/tmp/other-repo", "config", "user.name", "x"],
  ["config", "remote.origin.url", "https://example.invalid/repo.git"],
  ["config", "remote.origin.pushurl", "https://example.invalid/push.git"],
  ["config", "core.fsmonitor", "touch /tmp/pwned"],
  ["fetch", ".", "HEAD:refs/tags/v9.9.9"],
  ["fetch", ".", "+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/feature"],
  ["diff", "--output=/tmp/pwned", "abc1234", "def5678"],
  ["fetch", "--upload-pack=touch /tmp/pwned", "https://example.invalid/repo.git"],
  ["worktree", "add", "-B", "main", seat, "abc1234"],
  ["worktree", "add", "--force", "-b", "seat", seat, "abc1234"],
  ["worktree", "remove", seat],
  ["clone", "--config", "core.hooksPath=/tmp/hooks", "https://example.invalid/repo.git", seat],
  ["clone", "--template", "/tmp/template", "https://example.invalid/repo.git", seat],
  ["clone", "--template=/tmp/template", "https://example.invalid/repo.git", seat],
  ["-C", "/tmp/seat", "push"],
  ["-c", "user.name=x", "status"],
  ["--git-dir", "/tmp/repo", "status"],
  ["branch", "-D", "seat"],
  ["checkout", "main"],
  ["-C", seat, "config", "branch.feature.remote", "origin"],
  ["clone", "--reference", cache, "--dissociate", "--branch", "feature", "/tmp/origin.git", seat],
  ["-C", cache, "checkout", "--force", "HEAD"],
  ["-C", "/tmp/elenchus-root/stray", "status", "--porcelain"],
];

describe("git wrapper", () => {
  it("allows the exact invocations prep makes", () => {
    for (const args of allowed) expect(() => assertGitAllowed(args, scope), args.join(" ")).not.toThrow();
  });

  it("refuses every other shape, including the writes a subcommand list let through, without spawning", () => {
    for (const args of refused) {
      expect(() => assertGitAllowed(args, scope), args.join(" ")).toThrow(/git write refused/);
    }
  });
});
