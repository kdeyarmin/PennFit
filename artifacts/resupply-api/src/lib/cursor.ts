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

// UUID v4 (or any v1-5) hex shape — every cursor.id in production today
// is a `gen_random_uuid()::text` row id. Callers that paste a cursor
// half into a PostgREST `.or()` filter expression MUST run the id
// through this guard first, because PostgREST treats `,`, `(`, `)`,
// `"`, and a handful of other characters as structural delimiters
// inside the filter grammar — a hostile cursor like
// `abc),customer_id.neq.<id>` could otherwise mutate the surrounding
// expression. The other `.eq()` predicates (customer_id, status)
// are separate AND filters and would still apply, but a query that
// surfaces operationally-incorrect results or errors is a worse user
// experience than rejecting the cursor outright.
const CURSOR_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidCursorId(id: string): boolean {
  return CURSOR_UUID_RE.test(id);
}
