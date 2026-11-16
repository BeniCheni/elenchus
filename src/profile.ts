import type { SeatKind } from "./types.js";

export type VendorName = "claude" | "codex" | "cursor";

/** Paths written into the worktree. Each is excluded through the clone's info/exclude. */
export function profilePath(vendor: VendorName): string {
  if (vendor === "claude") return ".claude/settings.local.json";
  if (vendor === "cursor") return ".cursor/cli.json";
  return "seat.rules";
}

/**
 * Render the configuration's neutral prefixes into one vendor's deny profile.
 * A read-only seat also denies file writes, in that vendor's own form.
 */
export function renderProfile(vendor: VendorName, forbidden: string[], kind: SeatKind): string {
  if (vendor === "codex") return renderCodex(forbidden, kind);
  const deny = forbidden.map((prefix) => (vendor === "claude" ? claudeRule(prefix) : `Shell(${prefix})`));
  if (kind === "read-only") deny.push("Write", "Edit");
  // Cursor's cli.json schema requires permissions.allow. An empty list leaves the deny list in force.
  const permissions = vendor === "cursor" ? { allow: [] as string[], deny } : { deny };
  return `${JSON.stringify({ permissions }, null, 2)}\n`;
}

function claudeRule(prefix: string): string {
  const star = /[^A-Za-z0-9]$/.test(prefix) ? "*" : " *";
  return `Bash(${prefix}${star})`;
}

function renderCodex(forbidden: string[], kind: SeatKind): string {
  const rules = forbidden.map((prefix) => codexRule(prefix.split(" ").filter((part) => part.length > 0)));
  if (kind === "read-only") rules.push(codexRule(["apply_patch"]));
  return `${rules.join("\n")}\n`;
}

function codexRule(pattern: string[]): string {
  const list = pattern.map((part) => JSON.stringify(part)).join(", ");
  return `prefix_rule(\n    pattern = [${list}],\n    decision = "forbidden",\n)`;
}
