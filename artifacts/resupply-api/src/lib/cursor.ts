// Composite-cursor helpers shared by the public and admin shop-review
// list endpoints. Cursor format is `<ISO timestamp>__<row id>`. The
// composite is necessary because reviews can collide on `createdAt`
// (especially during seeding / bulk import) and a `created_at`-only
// `lt()` predicate would skip the remaining tied rows at a page
// boundary. The id half acts as a stable secondary sort. Callers
// `ORDER BY created_at DESC, id DESC` and apply the strict-less
// predicate `created_at < ts OR (created_at = ts AND id < cursorId)`.

export const COMPOSITE_CURSOR_DELIM = "__";

export type ParsedCompositeCursor =
  | { ok: true; date: Date | null; id: string | null }
  | { ok: false };

export function parseCompositeCursor(
  cursor: string | undefined,
): ParsedCompositeCursor {
  if (!cursor) return { ok: true, date: null, id: null };
  const idx = cursor.indexOf(COMPOSITE_CURSOR_DELIM);
  if (idx <= 0 || idx >= cursor.length - COMPOSITE_CURSOR_DELIM.length) {
    return { ok: false };
  }
  const tsPart = cursor.slice(0, idx);
  const idPart = cursor.slice(idx + COMPOSITE_CURSOR_DELIM.length);
  const date = new Date(tsPart);
  if (Number.isNaN(date.getTime())) return { ok: false };
  // The id half is opaque to the cursor parser; the SQL layer treats
  // it as a string compare so any non-empty value within a sane bound
  // is acceptable here.
  if (idPart.length === 0 || idPart.length > 80) return { ok: false };
  return { ok: true, date, id: idPart };
}

export function encodeCompositeCursor(date: Date, id: string): string {
  return `${date.toISOString()}${COMPOSITE_CURSOR_DELIM}${id}`;
}
