import path from "node:path";

/**
 * Allow only the exact git invocations prep makes. Anything else is refused
 * before git is spawned. `-C` may name only the fetch cache or the seat being
 * made, and only under the seat root. `config` is not among those invocations.
 */
export type GitScope = {
  root: string;
  /** Absolute paths `-C` may name: the fetch cache and the seat being made. */
  places: string[];
};

export function assertGitAllowed(args: string[], scope: GitScope): void {
  if (allowed(args, scope)) return;
  throw new Error(`git write refused: ${args.join(" ")}`);
}

function allowed(args: string[], scope: GitScope): boolean {
  if (args.length === 2 && args[0] === "rev-parse" && args[1] === "--git-dir") return true;
  if (args[0] === "clone" && args[1] === "--bare" && args.length === 4) {
    return isToken(args[2]) && underRoot(scope, args[3]);
  }
  if (
    args.length === 9 &&
    args[0] === "clone" &&
    args[1] === "--reference" &&
    args[3] === "--dissociate" &&
    args[4] === "--no-checkout" &&
    args[5] === "--branch" &&
    isToken(args[6]) &&
    isToken(args[7])
  ) {
    return underRoot(scope, args[2]) && underRoot(scope, args[8]);
  }
  if (args[0] !== "-C" || args.length < 3) return false;
  const place = args[1];
  if (!place || !isPlace(scope, place)) return false;
  const rest = args.slice(2);
  if (same(rest, ["fetch", "origin", "+refs/heads/*:refs/heads/*"])) return true;
  if (same(rest, ["rev-parse", "HEAD"])) return true;
  if (same(rest, ["checkout", "--force", "HEAD"])) return isSeat(scope, place);
  if (same(rest, ["status", "--porcelain"])) return true;
  if (rest.length === 3 && rest[0] === "merge-base" && isToken(rest[1]) && isToken(rest[2])) return true;
  if (
    rest.length === 6 &&
    rest[0] === "diff" &&
    rest[1] === "-z" &&
    rest[2] === "--name-status" &&
    rest[3] === "--no-renames" &&
    isToken(rest[4]) &&
    isToken(rest[5])
  ) {
    return true;
  }
  if (rest[0] === "ls-files" && rest[1] === "--" && rest.length >= 3) {
    return rest.slice(2).every(isRelativePath);
  }
  return false;
}

function same(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

function isToken(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("-");
}

function isRelativePath(value: string): boolean {
  if (!isToken(value) || value.startsWith("/") || value.includes("\0")) return false;
  return !value.split("/").includes("..");
}

function underRoot(scope: GitScope, target: string | undefined): boolean {
  if (!target || target.startsWith("-")) return false;
  const root = path.resolve(scope.root);
  const resolved = path.resolve(target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function isSeat(scope: GitScope, target: string): boolean {
  const seat = scope.places[scope.places.length - 1];
  return Boolean(seat) && scope.places.length > 1 && path.resolve(target) === path.resolve(seat);
}

function isPlace(scope: GitScope, target: string): boolean {
  if (!underRoot(scope, target)) return false;
  const resolved = path.resolve(target);
  return scope.places.some((place) => path.resolve(place) === resolved);
}
