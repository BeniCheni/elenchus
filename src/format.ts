import type { CheckItem, StatusView } from "./types.js";

export function formatStatus(view: StatusView): string {
  const lines = [
    `repo: ${view.repo}`,
    `pr: ${view.pr}`,
    `head: ${view.head}`,
    `base: ${view.base.ref} ${view.base.sha}`,
    ...(view.merged ? [view.mergeCommit ? `merged: ${view.mergeCommit}` : "merged"] : []),
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
  for (const item of view.unreadable) {
    lines.push(`unreadable pass: ${item.commentUrl} ${item.reason}`);
  }
  for (const notice of view.notices ?? []) lines.push(`NOTICE ${notice.rule} ${notice.message}`);
  if (view.headNote) lines.push(view.headNote);
  if (view.gateStatus) lines.push(`gate: ${view.gateStatus}`);
  lines.push("");
  lines.push(`next: ${view.next.step}`);
  if (view.next.seat) lines.push(`seat: ${view.next.seat}`);
  if (view.next.role) lines.push(`role: ${view.next.role}`);
  lines.push(`blocked: ${view.next.blocked}`);
  if (view.next.options) lines.push(`options: ${view.next.options.join(", or ")}`);
  return `${lines.join("\n")}\n`;
}

export function formatCheck(items: CheckItem[]): string {
  if (items.length === 0) return "ok\n";
  return `${items.map(formatItem).join("\n")}\n`;
}

function formatItem(item: CheckItem): string {
  const label = item.severity === "fail" ? "FAIL" : item.severity === "notice" ? "NOTICE" : "UNVERIFIED";
  const parts = [label, item.rule];
  if (item.pass) parts.push(`pass ${item.pass}`);
  if (item.finding) parts.push(`finding ${item.finding}`);
  if (item.comment) parts.push(item.comment);
  parts.push(item.message);
  return parts.join(" ");
}
