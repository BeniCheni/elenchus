const RECORD_FENCE = /(?:^|\n)```json\r?\n((?:(?!\r?\n```)[\s\S])*)\r?\n```\s*$/;

/** The one fenced json block that ends a comment. The body never crosses a fence line. */
export function extractRecord(body: string): string | null {
  const match = body.match(RECORD_FENCE);
  return match?.[1] ?? null;
}

/**
 * A json fence this comment holds that was not read as its record:
 * an earlier block, or a near-miss (upper case, a space, four backticks,
 * an indent, or a quote).
 */
function jsonFenceCount(body: string): number {
  return body.match(/^[ \t>]*`{3,}[ \t]*json\b/gim)?.length ?? 0;
}

export function hasJsonFence(body: string): boolean {
  return jsonFenceCount(body) > 0;
}

export function hasUnreadJsonFence(body: string): boolean {
  const count = jsonFenceCount(body);
  if (count === 0) return false;
  return extractRecord(body) === null || count > 1;
}

/** Used only when the block does not parse. */
export function guessPass(raw: string): string | null {
  const match = raw.match(/"pass"\s*:\s*"([^"]*)"/);
  return match?.[1] ?? null;
}
