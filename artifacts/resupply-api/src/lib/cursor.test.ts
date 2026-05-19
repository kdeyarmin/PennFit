import { describe, it, expect } from "vitest";

import {
  COMPOSITE_CURSOR_DELIM,
  encodeCompositeCursor,
  isUuidCursorId,
  parseCompositeCursor,
} from "./cursor";

describe("composite pagination cursor", () => {
  it("returns null halves for an undefined cursor (first page)", () => {
    const r = parseCompositeCursor(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.date).toBeNull();
      expect(r.id).toBeNull();
    }
  });

  it("round-trips an encoded cursor", () => {
    const ts = new Date("2026-04-29T14:30:00.000Z");
    const id = "shrev_01HZX6Y3K9";
    const encoded = encodeCompositeCursor(ts, id);
    expect(encoded).toContain(COMPOSITE_CURSOR_DELIM);
    expect(encoded).toBe(`2026-04-29T14:30:00.000Z__shrev_01HZX6Y3K9`);

    const parsed = parseCompositeCursor(encoded);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.date?.toISOString()).toBe("2026-04-29T14:30:00.000Z");
      expect(parsed.id).toBe("shrev_01HZX6Y3K9");
    }
  });

  it("rejects a missing delimiter (timestamp-only legacy cursor)", () => {
    // The previous implementation used the bare ISO timestamp as the
    // cursor. We MUST reject those rather than silently coerce them
    // to (date, null) — a null id half would skip the strict-less id
    // predicate at a tied-timestamp boundary, reintroducing the
    // exact bug this composite cursor exists to fix.
    const r = parseCompositeCursor("2026-04-29T14:30:00.000Z");
    expect(r.ok).toBe(false);
  });

  it("rejects an empty timestamp half", () => {
    expect(parseCompositeCursor("__shrev_x").ok).toBe(false);
  });

  it("rejects an empty id half", () => {
    expect(parseCompositeCursor("2026-04-29T14:30:00.000Z__").ok).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(parseCompositeCursor("not-a-date__shrev_x").ok).toBe(false);
  });

  it("rejects an oversized id half (DoS guard)", () => {
    const oversized = "x".repeat(81);
    expect(
      parseCompositeCursor(`2026-04-29T14:30:00.000Z__${oversized}`).ok,
    ).toBe(false);
  });

  it("encoded cursors stay within the 120-char zod cap", () => {
    // Stripe-style ids and uuids are well under the 80-char id half
    // bound, so the encoded total comfortably fits the route-level
    // 120-char cap.
    const ts = new Date();
    const longestRealisticId = "shrev_" + "a".repeat(40);
    expect(
      encodeCompositeCursor(ts, longestRealisticId).length,
    ).toBeLessThanOrEqual(120);
  });
});

describe("isUuidCursorId", () => {
  it("accepts lowercase canonical UUIDs (gen_random_uuid()::text shape)", () => {
    expect(isUuidCursorId("8c4c4c8e-0e8e-4c8e-8c4c-4c8e0e8e4c8e")).toBe(true);
  });

  it("accepts uppercase UUIDs (case-insensitive hex)", () => {
    expect(isUuidCursorId("8C4C4C8E-0E8E-4C8E-8C4C-4C8E0E8E4C8E")).toBe(true);
  });

  it("rejects non-UUID ids that the cursor parser would otherwise accept", () => {
    // The cursor parser is intentionally permissive about the id half
    // (anything non-empty up to 80 chars). isUuidCursorId is the
    // narrower gate for callers that interpolate the id into a
    // PostgREST `.or()` filter expression.
    expect(isUuidCursorId("shrev_01HZX6Y3K9")).toBe(false);
    expect(isUuidCursorId("not-a-uuid")).toBe(false);
    expect(isUuidCursorId("")).toBe(false);
  });

  it("rejects PostgREST metachar smuggling attempts", () => {
    // The whole reason this guard exists — a hostile cursor id like
    // `8c4c4c8e-0e8e-4c8e-8c4c-4c8e0e8e4c8e),customer_id.neq.foo` must
    // be rejected before it reaches the `.or()` builder.
    expect(
      isUuidCursorId(
        "8c4c4c8e-0e8e-4c8e-8c4c-4c8e0e8e4c8e),customer_id.neq.foo",
      ),
    ).toBe(false);
    expect(isUuidCursorId('"abc"')).toBe(false);
    expect(isUuidCursorId("abc,def")).toBe(false);
  });
});
