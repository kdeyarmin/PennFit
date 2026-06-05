// Tests for lib/rate-limits-config.ts
//
// Pure type-and-shape assertions on the registry. The actual limiter
// behavior is exercised by the per-route integration tests; here we
// just guard against accidents like:
//   - deleting a named entry referenced elsewhere
//   - zeroing out a budget so the limit effectively disables itself
//   - shipping an entry with no `doc` (ops asks "why this number?"
//     and gets nothing)
//   - shipping a window so small the user-visible Retry-After is
//     pointless (< 1s)
//   - shipping a window so large the limiter ages out slowly enough
//     to feel like a permanent ban for a legitimate burst (> 24h)

import { describe, expect, it } from "vitest";

import { RATE_LIMITS, type RateLimitName } from "./rate-limits-config";

describe("RATE_LIMITS — registry shape", () => {
  it("contains every named entry the migration touched", () => {
    // Hard-pin the call-site contract: removing an entry below
    // would break a production limiter at import-time, so the test
    // pins them here. Add new entries to BOTH places; that's the
    // intentional friction so a registry rename is a single
    // searchable change.
    const expected: RateLimitName[] = [
      "storefront_orders",
      "storefront_usage_events",
      "storefront_chat",
      "reminder_signup",
      "reminder_manage",
      "integrations_inbound_webhooks",
      "provider_portal",
    ];
    for (const name of expected) {
      expect(RATE_LIMITS[name]).toBeDefined();
    }
  });

  it("every entry has a positive windowMs and limit", () => {
    for (const [name, entry] of Object.entries(RATE_LIMITS)) {
      expect(entry.windowMs, `windowMs for ${name}`).toBeGreaterThan(0);
      expect(entry.limit, `limit for ${name}`).toBeGreaterThan(0);
    }
  });

  it("every entry's window is between 1s and 24h", () => {
    // Sanity guardrails — a window shorter than a second produces a
    // 0s Retry-After that's worse than no limit, and one longer
    // than a day means a legitimate burst feels like a permanent
    // ban (no operational reason to span that long).
    const ONE_SEC = 1_000;
    const ONE_DAY = 24 * 60 * 60 * 1000;
    for (const [name, entry] of Object.entries(RATE_LIMITS)) {
      expect(entry.windowMs, `windowMs for ${name}`).toBeGreaterThanOrEqual(
        ONE_SEC,
      );
      expect(entry.windowMs, `windowMs for ${name}`).toBeLessThanOrEqual(
        ONE_DAY,
      );
    }
  });

  it("every entry has a non-empty doc string", () => {
    // The doc field is the WHY ops reads when deciding to tune.
    // Treat empty/whitespace as a missing answer.
    for (const [name, entry] of Object.entries(RATE_LIMITS)) {
      expect(entry.doc.trim().length, `doc for ${name}`).toBeGreaterThan(0);
    }
  });
});
