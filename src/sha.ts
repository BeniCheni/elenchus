/** Exact equality, or a unique prefix of at least 7 hex digits. No fuzzy match. */
export function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  return short.length >= 7 && long.startsWith(short);
}
