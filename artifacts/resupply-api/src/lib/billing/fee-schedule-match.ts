// Shared fee-schedule row selection by modifier set.
//
// A claim line carries a SET of modifiers (e.g. ["RR", "KH", "KX"]). A
// payer_fee_schedules row's `modifier` is NULL (wildcard), a single modifier,
// or a comma-joined set ("KX,KH"). A row APPLIES when every modifier in its
// set is present on the line (subset match); the MOST SPECIFIC applicable row
// wins (largest matching set). Ties are broken by input order, so callers
// pass candidates ordered newest-`effective_from`-first. If no
// modifier-bearing row applies, the wildcard (NULL) row is used; failing
// that, the first candidate.
//
// This fixes the prior single-modifier exact match, under which a
// comma-joined row imported from CSV (the importer accepts "KX,KH") could
// never be reached and the line silently fell through to the wildcard rate.

export function pickFeeScheduleRowByModifiers<
  T extends { modifier: string | null },
>(candidates: readonly T[], lineModifiers: readonly string[]): T | null {
  if (candidates.length === 0) return null;
  const lineSet = new Set(
    lineModifiers.map((m) => m.trim().toUpperCase()).filter(Boolean),
  );
  let best: T | null = null;
  let bestCount = 0;
  for (const r of candidates) {
    if (r.modifier === null) continue;
    const rowMods = r.modifier
      .toUpperCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (rowMods.length === 0) continue;
    // `> bestCount` (strict) keeps the FIRST — i.e. newest — row at each
    // specificity level, since callers order candidates newest-first.
    if (rowMods.length > bestCount && rowMods.every((rm) => lineSet.has(rm))) {
      best = r;
      bestCount = rowMods.length;
    }
  }
  if (best) return best;
  const wildcard = candidates.find((r) => r.modifier === null);
  return wildcard ?? candidates[0] ?? null;
}
