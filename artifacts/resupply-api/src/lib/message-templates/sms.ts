export function isAsciiOnly(s: string): boolean {
  return [...s].every((ch) => (ch.codePointAt(0) ?? 0) < 128);
}
