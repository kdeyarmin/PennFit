// Regression guard (structural source check): the billing page reads the
// Stripe Hosted Checkout return params (?paid=1 / ?cancelled=1) from
// window.location.search, NOT from wouter's useLocation() — which returns
// the pathname ONLY, so the old `location.includes("?")` parse was always
// empty and the payment-confirmation banner + post-payment refetch never
// fired. This matches the window.location.search convention every other
// query-param page uses (sign-in, order-success, nps; see also
// reminders-manage). A full render test would need the query-client +
// router harness; pin the source invariant cheaply.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "account-billing.tsx",
  ),
  "utf8",
);

describe("account-billing — Stripe return params", () => {
  it("reads ?paid / ?cancelled from window.location.search", () => {
    expect(SRC).toContain("window.location.search");
    expect(SRC).toContain('params.get("paid")');
    expect(SRC).toContain('params.get("cancelled")');
  });

  it("does not parse query params off wouter's pathname-only location", () => {
    // wouter useLocation() returns the pathname only; the old code parsed
    // the query string off it (always empty). Guard against regressing.
    expect(SRC).not.toContain('location.includes("?")');
    expect(SRC).not.toContain('location.split("?")');
  });
});
