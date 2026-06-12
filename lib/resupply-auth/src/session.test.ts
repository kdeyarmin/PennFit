import { describe, expect, it } from "vitest";

import { isExpired, issueWindow, slideExpiry } from "./session";

const DAY = 24 * 60 * 60 * 1000;

describe("issueWindow", () => {
  it("sets expiresAt = now + ttlDays", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const w = issueWindow(now, { ttlDays: 14 });
    expect(w.issuedAt.toISOString()).toBe(now.toISOString());
    expect(w.expiresAt.getTime() - now.getTime()).toBe(14 * DAY);
  });

  it("clamps the initial TTL to absoluteMaxDays on misconfig", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    // ttlDays 100 > cap 90: without the clamp the FIRST window would
    // outlive the ceiling slideExpiry enforces on every later bump.
    const w = issueWindow(now, { ttlDays: 100, absoluteMaxDays: 90 });
    expect(w.expiresAt.getTime() - now.getTime()).toBe(90 * DAY);
    // Default cap (90) applies when absoluteMaxDays is omitted.
    const w2 = issueWindow(now, { ttlDays: 365 });
    expect(w2.expiresAt.getTime() - now.getTime()).toBe(90 * DAY);
  });
});

describe("slideExpiry", () => {
  it("slides forward to now + ttlDays on activity", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const w = issueWindow(issued, { ttlDays: 14 });

    const later = new Date("2026-01-05T00:00:00Z");
    const next = slideExpiry(w, later, { ttlDays: 14 });
    expect(next.getTime() - later.getTime()).toBe(14 * DAY);
  });

  it("never moves expiry backward when ttl shrinks below current", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const w = issueWindow(issued, { ttlDays: 30 });

    // Sliding with a 1-day TTL right after issuance would otherwise
    // shorten the window, which would log out an active user.
    const next = slideExpiry(w, issued, { ttlDays: 1 });
    expect(next.getTime()).toBe(w.expiresAt.getTime());
  });

  it("caps at issuedAt + absoluteMaxDays", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const w = issueWindow(issued, { ttlDays: 14 });

    // 89 days of continuous activity. ttl = 14 days, absolute cap
    // = 90 days. Sliding right at day 89 would propose day 103,
    // which the cap pulls back to day 90.
    const day89 = new Date(issued.getTime() + 89 * DAY);
    const next = slideExpiry(w, day89, { ttlDays: 14, absoluteMaxDays: 90 });
    expect(next.getTime()).toBe(issued.getTime() + 90 * DAY);
  });

  it("clamps an already-overshot expiresAt down to the absolute ceiling", () => {
    // Edge case: the row's expiresAt already sits past the ceiling (e.g.
    // written under a longer prior absoluteMaxDays, or a clock-skew/manual
    // edit). slideExpiry must NOT return it uncapped — the absolute cap is
    // a security bound, not a soft preference.
    const issued = new Date("2026-01-01T00:00:00Z");
    const w = {
      issuedAt: issued,
      // 200 days out — well past the 90-day ceiling.
      expiresAt: new Date(issued.getTime() + 200 * DAY),
    };
    const next = slideExpiry(w, new Date(issued.getTime() + 30 * DAY), {
      ttlDays: 14,
      absoluteMaxDays: 90,
    });
    expect(next.getTime()).toBe(issued.getTime() + 90 * DAY);
  });
});

describe("isExpired", () => {
  const now = new Date("2026-01-15T00:00:00Z");

  it("is false for a live future-dated session", () => {
    expect(
      isExpired(
        {
          expiresAt: new Date(now.getTime() + DAY),
          revokedAt: null,
        },
        now,
      ),
    ).toBe(false);
  });

  it("is true when expiresAt is in the past", () => {
    expect(
      isExpired(
        {
          expiresAt: new Date(now.getTime() - 1),
          revokedAt: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it("is true when revokedAt is set, even if expiresAt is future", () => {
    expect(
      isExpired(
        {
          expiresAt: new Date(now.getTime() + DAY),
          revokedAt: new Date(now.getTime() - DAY),
        },
        now,
      ),
    ).toBe(true);
  });
});
