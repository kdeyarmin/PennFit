// Utilities for working with PostgREST filter expressions.

/**
 * Escape a value for use in PostgREST `.or()` filter expressions.
 * PostgREST uses commas to separate clauses and parentheses for
 * grouping, so we need to wrap values containing these characters
 * in double-quotes and escape any embedded double-quotes and backslashes.
 *
 * @param value - The value to escape
 * @returns The escaped value safe for use in PostgREST filter expressions
 *
 * @example
 * ```ts
 * const search = "Smith, John";
 * const escaped = escapePostgRESTFilterValue(search);
 * // escaped = '"Smith, John"'
 * const pattern = `*${escaped}*`;
 * query.or(`first_name.ilike.${pattern},last_name.ilike.${pattern}`);
 * ```
 */
export function escapePostgRESTFilterValue(value: string): string {
  // If the value contains comma, parenthesis, double-quote, or backslash,
  // wrap it in double-quotes and escape embedded backslashes and quotes
  if (/[,()\\"]/.test(value)) {
    // Escape backslashes first, then quotes
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}
