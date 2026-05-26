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
 * @param value - The value to escape
 * @returns The escaped value safe for use in a PostgREST ilike filter
 *
 * @example
 * ```ts
 * const search = "Smith, John";
 * const pattern = `*${escapePostgRESTFilterValue(search)}*`;
 * query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern}`);
 * ```
 */
export function escapePostgRESTFilterValue(value: string): string {
  // 1. LIKE literal-escaping (\, %, _).
  const likeEscaped = value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  // 2. .or() delimiter quoting. Re-escape backslashes (then quotes) for
  //    the quoted-value layer: PostgREST decodes \\ -> \ and \" -> "
  //    inside quotes, leaving the LIKE-escaped value for ilike.
  if (/[,()"]/.test(likeEscaped)) {
    return `"${likeEscaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return likeEscaped;
}
