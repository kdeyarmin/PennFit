// Multi-location groundwork (owner #O1). Pure primary-location resolver
// so the "default branch" choice is testable + reused (e.g. future
// default assignment of new patients/staff). No I/O.

export interface LocationLike {
  id: string;
  is_primary: boolean;
  is_active: boolean;
}

/**
 * Pick the default location: the explicit primary if set, else the first
 * active one, else the first row, else null. Pure.
 */
export function pickPrimaryLocation<T extends LocationLike>(
  rows: readonly T[],
): T | null {
  const primary = rows.find((r) => r.is_primary);
  if (primary) return primary;
  const active = rows.find((r) => r.is_active);
  return active ?? rows[0] ?? null;
}
