// Shared string utilities used across resupply-auth.

/**
 * Remove every trailing `/` from `s`.
 *
 * Char-by-char scan avoids the polynomial-backtracking pattern that
 * CodeQL flags for `replace(/\/+$/, "")` against attacker-supplied
 * input.
 */
export function stripTrailingSlashes(s: string): string {
  let i = s.length;
  while (i > 0 && s.charCodeAt(i - 1) === 0x2f) i--;
  return i === s.length ? s : s.slice(0, i);
}
