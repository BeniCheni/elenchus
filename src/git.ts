/**
 * Allow only the git operations prep needs. Anything else is refused before git is spawned.
 * `config` is local to the invocation: `--global`, `--system` and `--file` are refused.
 */
export function assertGitAllowed(args: string[]): void {
  const { command, rest } = splitGitInvocation(args);
  if (command === "worktree") {
    const sub = rest[0];
    if (sub === "add" || sub === "list") return;
    refuse(args);
  }
  if (command === "config") {
    if (
      rest.some(
        (arg) =>
          arg === "--global" ||
          arg === "--system" ||
          arg === "--file" ||
          arg.startsWith("--file=") ||
          arg === "--edit",
      )
    ) {
      refuse(args);
    }
    return;
  }
  if (
    command === "clone" ||
    command === "fetch" ||
    command === "rev-parse" ||
    command === "merge-base" ||
    command === "diff" ||
    command === "ls-files" ||
    command === "status"
  ) {
    return;
  }
  refuse(args);
}

function refuse(args: string[]): never {
  throw new Error(`git write refused: ${args.join(" ")}`);
}

function splitGitInvocation(args: string[]): { command: string; rest: string[] } {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (arg === "-C") {
      if (args[i + 1] === undefined) refuse(args);
      i += 2;
      continue;
    }
    if (arg.startsWith("-C") && arg !== "-C") {
      i += 1;
      continue;
    }
    if (
      arg === "--git-dir" ||
      arg === "--work-tree" ||
      arg === "-c" ||
      arg === "--namespace" ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=") ||
      (arg.startsWith("-c") && !arg.startsWith("-C"))
    ) {
      refuse(args);
    }
    if (arg.startsWith("-")) refuse(args);
    return { command: arg, rest: args.slice(i + 1) };
  }
  refuse(args);
}
