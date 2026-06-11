// Utilities for working with PostgREST filter expressions.

/**
 * Escape a value for use in a PostgREST `ilike` filter (including the
 * `.or()` clause form). Two layers:
 *
 *  1. LIKE/ILIKE metacharacters — `\` (the LIKE escape char), `%` and
 *     `_` (wildcards) — are backslash-escaped so the value matches
 *     LITERALLY. Without this, an ilike on `a%b@x.com` matches
 *     `a<anything>b@x.com` (a wrong-row match for exact-lookup callers
 *     like the fitter-lead email matchers, and a surprise for admin
 *     search). Mirrors the inline escaping the storefront me-billing /
 *     me-claims routes already apply.
 *  2. `.or()` clause delimiters — commas separate clauses, parens group
 *     them — so a value containing them is wrapped in double-quotes
 *     (re-escaping `\` and `"` for the quoting layer, which PostgREST
 *     decodes back before the LIKE pattern is interpreted).
 *
 * IMPORTANT: only compose this directly into an `.or()` operand for
 * WHOLE-VALUE matches (`email.ilike.${escaped}`). For contains-style
 * searches use {@link escapePostgRESTContainsPattern} — wrapping this
 * function's output in wildcards (`*${escaped}*`) breaks the quoting
 * layer, because PostgREST's logic-tree parser only honors a quoted
 * value when the double-quote is the FIRST character of the operand.
 *
 * @param value - The value to escape
 * @returns The escaped value safe for use in a PostgREST ilike filter
 *
 * @example
 * ```ts
 * query.or(`email.ilike.${escapePostgRESTFilterValue(email)}`);
 * ```
 */
export function escapePostgRESTFilterValue(value: string): string {
  // 1. LIKE literal-escaping (\, %, _).
  const likeEscaped = value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  // 2. .or() delimiter quoting. Use standard string escaping for the
  //    quoted-value layer so backslashes and quotes are encoded once in
  //    a well-defined way.
  if (/[,()"]/.test(likeEscaped)) {
    return JSON.stringify(likeEscaped);
  }
  return likeEscaped;
}

/**
 * Build a complete `*<value>*` contains pattern for a PostgREST
 * `ilike` operand inside an `.or()` logic tree.
 *
 * Why this exists: PostgREST's logic-tree parser only treats a value
 * as quoted when the double-quote is the FIRST character of the
 * operand. The previously documented composition
 * `*${escapePostgRESTFilterValue(v)}*` therefore mis-parses whenever
 * the quoting layer engaged — `name.ilike.*"Smith, John"*` reads as a
 * raw token terminated at the comma, and the whole `or=` filter is
 * rejected (PostgREST 400 → route 500) for exactly the inputs the
 * quoting was meant to protect (names with commas, parens, quotes).
 * The wildcards must be applied BEFORE the quoting decision so they
 * live INSIDE the quotes: `"*Smith, John*"`. The `*`→`%` like-pattern
 * translation happens after the quote layer is decoded, so quoted
 * wildcards still match as wildcards.
 *
 * @example
 * ```ts
 * const pattern = escapePostgRESTContainsPattern("Smith, John");
 * query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern}`);
 * ```
 */
export function escapePostgRESTContainsPattern(value: string): string {
  const likeEscaped = value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  const pattern = `*${likeEscaped}*`;
  if (/[,()"]/.test(pattern)) {
    return JSON.stringify(pattern);
  }
  return pattern;
}
