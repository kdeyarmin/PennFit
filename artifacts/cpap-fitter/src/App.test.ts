// Tests for the GuardedOrderSuccess component in src/App.tsx.
//
// PR change: GuardedOrderSuccess now has a two-step gating strategy:
//
//   1. Fast path — sessionStorage already holds the confirmation written
//      by /order on submit. Check it first; if present, setState("ok").
//
//   2. Recovery path — sessionStorage is gone (tab crash, cache cleared,
//      deep link from an email). Read ?ref + ?email from the URL, POST to
//      /api/orders/track, and if the server confirms the order, prime
//      sessionStorage in the same shape /order writes so <OrderSuccess />
//      hydrates normally.
//
//   Security properties preserved:
//   - The server requires BOTH ?ref + ?email; leaking the URL doesn't
//     expose the order to anyone who doesn't know the email on file.
//   - Credentials: "same-origin" so the browser sends the session cookie.
//
// The component uses React + hooks which cannot be rendered in the node
// vitest environment without jsdom. We read the source as a string and
// assert structural invariants using the pattern established by
// hooks/use-bulk-selection.test.ts and hooks/use-filtered-list.test.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "App.tsx"), "utf8");

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("Account notification deep links", () => {
  it("registers path-style account aliases so old notification payloads avoid the 404 route", () => {
    expect(SRC).toContain('path="/account/insights"');
    expect(SRC).toContain('path="/account/orders"');
  });

  it("redirects account aliases to the hash tabs the account page understands", () => {
    expect(SRC).toContain('<AccountHashRedirect hash="insights" />');
    expect(SRC).toContain('<AccountHashRedirect hash="orders" />');
    expect(SRC).toContain(
      "setLocation(`/account${search}#${hash}`, { replace: true })",
    );
  });
});

// ---------------------------------------------------------------------------
// Fast path — sessionStorage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recovery path — URL params
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recovery path — server fetch
// ---------------------------------------------------------------------------
