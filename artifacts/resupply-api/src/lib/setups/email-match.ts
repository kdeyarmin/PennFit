// Case-insensitive exact email match. `ilike` treats `_` and `%` as
// wildcards, so a raw address can bind the wrong chart.

export function escapeIlikeExact(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function uniquePatientIdsByEmail(
  rows: Array<{ id: string; email: string | null }>,
): Map<string, string> {
  const seen = new Map<string, { id: string; ambiguous: boolean }>();
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase();
    if (!email || !row.id) continue;
    const current = seen.get(email);
    if (!current) {
      seen.set(email, { id: row.id, ambiguous: false });
      continue;
    }
    if (current.id !== row.id) current.ambiguous = true;
  }
  const unique = new Map<string, string>();
  for (const [email, current] of seen) {
    if (!current.ambiguous) unique.set(email, current.id);
  }
  return unique;
}
