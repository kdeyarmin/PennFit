// @vitest-environment jsdom
//
// Behavioural tests for the reminder manage-link load-error copy. The manage
// token is a stable capability secret (not a time-expiring link), so the
// distinct failure the page can surface is "this link is invalid / the
// subscription was removed" (404) vs a transient load error (anything else).

import { describe, it, expect } from "vitest";

import { manageLoadErrorCopy } from "./reminders-manage";

describe("manageLoadErrorCopy", () => {
  it("treats 404 as an invalid / removed link", () => {
    const copy = manageLoadErrorCopy(404);
    expect(copy.title).toBe("Subscription not found");
    expect(copy.description).toMatch(/isn't valid/i);
    // The old copy blamed "used after unsubscribing" — but unsubscribing
    // keeps the row (loads 200 with status "unsubscribed"), so a 404 is
    // never that. Guard against the misleading wording creeping back.
    expect(copy.description).not.toMatch(/unsubscrib/i);
  });

  it("treats any non-404 status as a retryable transient error", () => {
    for (const status of [0, 500, 502, 503]) {
      const copy = manageLoadErrorCopy(status);
      expect(copy.title).toBe("Could not load subscription");
      expect(copy.description).toMatch(/refresh/i);
    }
  });
});
