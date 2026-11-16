const FENCE = /(?:^|\n)```json\n([\s\S]*?)\n```\s*$/;

/** The one fenced json block that ends a comment. Anything else is ignored. */
export function extractRecord(body: string): string | null {
  const match = body.match(FENCE);
  return match?.[1] ?? null;
}

export function guessPass(raw: string): string | null {
  const match = raw.match(/"pass"\s*:\s*"([^"]*)"/);
  return match?.[1] ?? null;
}
