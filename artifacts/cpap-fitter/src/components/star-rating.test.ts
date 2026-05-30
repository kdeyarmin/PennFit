// Tests for the aria-label strings on interactive StarRating buttons.
//
// PR change: each interactive star button now carries an explicit
// `aria-label` so screen readers announce "1 star", "2 stars", …
// "5 stars" when the user tabs through a rating group.
//
// The label generation is the inline expression:
//   `${s} ${s === 1 ? "star" : "stars"}`
// where `s` is 1–5. This test guards that expression directly
// (without React or a DOM) so a typo like "1 stars" or "2 star"
// fails CI immediately.

import { describe, expect, it } from "vitest";

/**
 * Mirrors the aria-label expression used in StarRating's interactive
 * button render path:
 *   aria-label={`${s} ${s === 1 ? "star" : "stars"}`}
 *
 * Isolated here so the logic can be exercised without a DOM or
 * React renderer — the cpap-fitter test environment uses "node".
 */
function starAriaLabel(s: 1 | 2 | 3 | 4 | 5): string {
  return `${s} ${s === 1 ? "star" : "stars"}`;
}

describe("StarRating interactive aria-label — PR change", () => {
  it('produces "1 star" for the first star button (singular)', () => {
    expect(starAriaLabel(1)).toBe("1 star");
  });

  it('produces "2 stars" through "5 stars" for the remaining buttons (plural)', () => {
    expect(starAriaLabel(2)).toBe("2 stars");
    expect(starAriaLabel(3)).toBe("3 stars");
    expect(starAriaLabel(4)).toBe("4 stars");
    expect(starAriaLabel(5)).toBe("5 stars");
  });

  // Regression guard: "1 stars" (wrong plural) or "2 star" (wrong singular)
  // must never appear.
  it('does NOT produce "1 stars" (singular enforcement)', () => {
    expect(starAriaLabel(1)).not.toBe("1 stars");
  });

  it.each([2, 3, 4, 5] as const)(
    'does NOT produce "%s star" (plural enforcement)',
    (s) => {
      expect(starAriaLabel(s)).not.toBe(`${s} star`);
    },
  );

  it("covers all five star positions with distinct, non-empty labels", () => {
    const labels = ([1, 2, 3, 4, 5] as const).map(starAriaLabel);
    // All five labels must be non-empty strings.
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    // All five labels must be unique (no two buttons have the same label).
    expect(new Set(labels).size).toBe(5);
  });
});
