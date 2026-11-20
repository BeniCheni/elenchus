import path from "node:path";
import { seatCredentialArgs } from "./seat-credentials.js";

/**
 * Allow only the exact git invocations prep makes. Anything else is refused
 * before git is spawned. `-C` may name only the fetch cache or the seat being
 * made, and only under the seat root. `config` is not among those invocations.
 */
export type GitScope = {
  root: string;
  /** Absolute paths `-C` may name: the fetch cache and the seat being made. */
  places: string[];
  seatKeychainService?: string;
};

export function assertGitAllowed(args: string[], scope: GitScope): void {
  if (allowed(args, scope)) return;
  throw new Error(`git write refused: ${args.join(" ")}`);
}

function allowed(args: string[], scope: GitScope): boolean {
  if (args.length === 2 && args[0] === "rev-parse" && args[1] === "--git-dir") return true;
  if (args[0] === "clone") return allowClone(args.slice(1), scope);
  if (args[0] !== "-C" || args.length < 3) return false;
  const place = args[1];
  if (!place || !isPlace(scope, place)) return false;
  const rest = args.slice(2);
  const service = scope.seatKeychainService;
  if (service && isCache(scope, place) &&
      same(rest, [...seatCredentialArgs("-c", service), "fetch", "origin", "+refs/heads/*:refs/heads/*"])) return true;
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

function allowClone(args: string[], scope: GitScope): boolean {
  const service = scope.seatKeychainService;
  if (!service) return false;
  const expected = seatCredentialArgs("--config", service);
  if (!same(args.slice(0, expected.length), expected)) return false;
  const clone = args.slice(expected.length);
  if (clone.length === 3 && clone[0] === "--bare") {
    return isToken(clone[1]) && isCache(scope, clone[2]);
  }
  return clone.length === 8 && clone[0] === "--reference" && isCache(scope, clone[1]) &&
    clone[2] === "--dissociate" && clone[3] === "--no-checkout" && clone[4] === "--branch" &&
    isToken(clone[5]) && isToken(clone[6]) && isSeat(scope, clone[7]);
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

function isCache(scope: GitScope, target: string | undefined): boolean {
  const cache = scope.places[0];
  return Boolean(target && cache && underRoot(scope, target) && path.resolve(target) === path.resolve(cache));
}

function isSeat(scope: GitScope, target: string | undefined): boolean {
  const seat = scope.places[scope.places.length - 1];
  return Boolean(target && seat && scope.places.length > 1 && underRoot(scope, target) && path.resolve(target) === path.resolve(seat));
}

function isPlace(scope: GitScope, target: string): boolean {
  if (!underRoot(scope, target)) return false;
  const resolved = path.resolve(target);
  return scope.places.some((place) => path.resolve(place) === resolved);
}
