import type { CheckItem, StatusView } from "./types.js";

export function formatStatus(view: StatusView): string {
  const lines = [
    `repo: ${view.repo}`,
    `pr: ${view.pr}`,
    `head: ${view.head}`,
    `base: ${view.base.ref} ${view.base.sha}`,
    "",
  ];
  for (const pass of view.passes) {
    if (pass.state === "recorded") {
      lines.push(
        `pass ${pass.pass}: recorded, ${pass.role}, seat ${pass.seat}, output ${pass.output_sha}, comment ${pass.comment_url}`,
      );
    } else if (pass.state === "in_progress") {
      lines.push(`pass ${pass.pass}: in progress, ${pass.role}, seat ${pass.seat}`);
    } else if (pass.state === "rejected") {
      lines.push(`pass ${pass.pass}: rejected, ${pass.role}, seat ${pass.seat}, ${pass.reason}`);
    } else {
      lines.push(`pass ${pass.pass}: not recorded, ${pass.role}, seat ${pass.seat}`);
    }
  }
  lines.push("");
  lines.push(`next: ${view.next.step}`);
  if (view.next.seat) lines.push(`seat: ${view.next.seat}`);
  if (view.next.role) lines.push(`role: ${view.next.role}`);
  lines.push(`blocked: ${view.next.blocked}`);
  if (view.next.options) lines.push(`options: ${view.next.options.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export function formatCheck(items: CheckItem[]): string {
  if (items.length === 0) return "ok\n";
  return `${items.map(formatItem).join("\n")}\n`;
}

function formatItem(item: CheckItem): string {
  const parts = [item.severity === "fail" ? "FAIL" : "UNVERIFIED", item.rule];
  if (item.pass) parts.push(`pass ${item.pass}`);
  if (item.finding) parts.push(`finding ${item.finding}`);
  if (item.comment) parts.push(item.comment);
  parts.push(item.message);
  return parts.join(" ");
}
