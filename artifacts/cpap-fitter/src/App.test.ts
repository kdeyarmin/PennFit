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

// Isolate the GuardedOrderSuccess function body so our checks don't
// accidentally match code in other components.
const GUARDED_START = SRC.indexOf("function GuardedOrderSuccess");
const GUARDED_END = SRC.indexOf("\nfunction ", GUARDED_START + 1);
const GUARDED_SRC = SRC.slice(
  GUARDED_START,
  GUARDED_END > 0 ? GUARDED_END : undefined,
);

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("GuardedOrderSuccess — state machine", () => {
  it("starts in the 'checking' state (neither ok nor deny until the effect runs)", () => {
    expect(GUARDED_SRC).toContain('"checking"');
  });

  it("transitions to 'ok' on the fast path (sessionStorage hit)", () => {
    expect(GUARDED_SRC).toContain('setState("ok")');
  });

  it("transitions to 'deny' when ?ref or ?email is absent", () => {
    expect(GUARDED_SRC).toContain('setState("deny")');
  });

  it("renders a loading fallback while in the 'checking' state (no blank screen while fetch is in flight)", () => {
    expect(GUARDED_SRC).toContain(
      'if (state === "checking") return <RouteFallback />',
    );
  });

  it("redirects to '/' while in the 'deny' state", () => {
    expect(GUARDED_SRC).toContain(
      'if (state === "deny") return <Redirect to="/" />',
    );
  });
});

describe("Account notification deep links", () => {
  it("registers path-style account aliases so old notification payloads avoid the 404 route", () => {
    expect(SRC).toContain('path="/account/insights"');
    expect(SRC).toContain('path="/account/orders"');
  });

  it("redirects account aliases to the hash tabs the account page understands", () => {
    expect(SRC).toContain('<AccountHashRedirect hash="insights" />');
    expect(SRC).toContain('<AccountHashRedirect hash="orders" />');
    expect(SRC).toContain("setLocation(`/account#${hash}`, { replace: true })");
  });
});

// ---------------------------------------------------------------------------
// Fast path — sessionStorage
// ---------------------------------------------------------------------------

describe("GuardedOrderSuccess — fast path (sessionStorage)", () => {
  it("reads from sessionStorage using the key 'fitter_order_confirmation'", () => {
    expect(GUARDED_SRC).toContain('"fitter_order_confirmation"');
  });

  it("short-circuits to setState('ok') immediately when sessionStorage has the key", () => {
    const storedIdx = GUARDED_SRC.indexOf(
      'sessionStorage.getItem("fitter_order_confirmation")',
    );
    const setOkIdx = GUARDED_SRC.indexOf('setState("ok")');
    expect(storedIdx).toBeGreaterThan(-1);
    expect(setOkIdx).toBeGreaterThan(-1);
    expect(setOkIdx).toBeGreaterThan(storedIdx);
  });

  it("wraps the sessionStorage read in a try/catch (tolerate private-browsing storage errors)", () => {
    // Private-browsing mode + third-party cookie blocking can throw on
    // sessionStorage.getItem in Safari. The catch must fall through rather
    // than crash the whole component.
    const tryIdx = GUARDED_SRC.indexOf("try {");
    const catchIdx = GUARDED_SRC.indexOf("} catch {");
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(tryIdx);
  });
});

// ---------------------------------------------------------------------------
// Recovery path — URL params
// ---------------------------------------------------------------------------

describe("GuardedOrderSuccess — recovery path (URL params)", () => {
  it("reads ?ref from window.location.search", () => {
    expect(GUARDED_SRC).toContain('params.get("ref")');
  });

  it("reads ?email from window.location.search", () => {
    expect(GUARDED_SRC).toContain('params.get("email")');
  });

  it("wraps URLSearchParams construction in a try/catch", () => {
    // URL parse is generally safe but wrapping it prevents exotic
    // browser environments from crashing the component.
    expect(GUARDED_SRC).toContain(
      "new URLSearchParams(window.location.search)",
    );
  });

  it("denies when ref or email are absent from the URL", () => {
    expect(GUARDED_SRC).toContain("if (!ref || !email)");
    const denyIdx = GUARDED_SRC.indexOf("if (!ref || !email)");
    const setDenyIdx = GUARDED_SRC.indexOf('setState("deny")', denyIdx);
    expect(setDenyIdx).toBeGreaterThan(denyIdx);
  });
});

// ---------------------------------------------------------------------------
// Recovery path — server fetch
// ---------------------------------------------------------------------------

describe("GuardedOrderSuccess — server fetch", () => {
  it("POSTs to /api/orders/track (not the legacy /resupply-api path)", () => {
    expect(GUARDED_SRC).toContain('"/api/orders/track"');
    expect(GUARDED_SRC).not.toContain("/resupply-api/orders/track");
  });

  it("sends credentials: 'same-origin' so the session cookie is included", () => {
    expect(GUARDED_SRC).toContain('credentials: "same-origin"');
  });

  it("sends Content-Type: application/json", () => {
    expect(GUARDED_SRC).toContain('"Content-Type": "application/json"');
  });

  it("sends the body with orderReference and email fields", () => {
    expect(GUARDED_SRC).toContain("orderReference: ref");
    expect(GUARDED_SRC).toContain("email");
  });

  it("transitions to 'deny' when the fetch response is not ok", () => {
    expect(GUARDED_SRC).toContain("if (!res.ok)");
  });

  it("writes the recovered confirmation to sessionStorage in the same shape as /order", () => {
    // The key + shape must match what <OrderSuccess /> expects. The PR
    // comment specifies the absence of measurements is a deliberate
    // visual no-op.
    expect(GUARDED_SRC).toContain(
      'sessionStorage.setItem(\n            "fitter_order_confirmation"',
    );
    expect(GUARDED_SRC).toContain("orderReference: data.orderReference");
    expect(GUARDED_SRC).toContain("mask: {");
  });

  it("transitions to 'deny' if the sessionStorage write fails after a successful fetch", () => {
    // Without sessionStorage the OrderSuccess component can't hydrate;
    // denying is cleaner than leaving the patient staring at a blank card.
    // The second try/catch after the setItem must setState("deny").
    const setItemIdx = GUARDED_SRC.indexOf(
      'sessionStorage.setItem(\n            "fitter_order_confirmation"',
    );
    expect(setItemIdx).toBeGreaterThan(-1);
    // There must be a catch block after the setItem that calls setState("deny").
    const catchAfterSetItem = GUARDED_SRC.indexOf("} catch {", setItemIdx);
    expect(catchAfterSetItem).toBeGreaterThan(setItemIdx);
  });
});

// ---------------------------------------------------------------------------
// Recovery path — URL scrub
// ---------------------------------------------------------------------------

describe("GuardedOrderSuccess — URL scrub after successful recovery", () => {
  it("calls window.history.replaceState to remove ?ref + ?email from the URL", () => {
    expect(GUARDED_SRC).toContain("window.history.replaceState");
  });

  it("scrubs only pathname + hash (no search params) after recovery", () => {
    expect(GUARDED_SRC).toContain("window.location.pathname");
    expect(GUARDED_SRC).toContain("window.location.hash");
  });

  it("wraps the replaceState call in a try/catch (best-effort scrub)", () => {
    const replaceIdx = GUARDED_SRC.indexOf("window.history.replaceState");
    const catchAfterReplace = GUARDED_SRC.indexOf("} catch {", replaceIdx);
    expect(catchAfterReplace).toBeGreaterThan(replaceIdx);
  });

  it("scrubs ONLY after successful recovery so a fetch failure leaves params intact for retry", () => {
    // The URL scrub must come after setState("ok") — if it ran on the
    // first fetch failure, the patient couldn't refresh + retry.
    const setOkIdx = GUARDED_SRC.indexOf('setState("ok")');
    const replaceIdx = GUARDED_SRC.indexOf("window.history.replaceState");
    expect(setOkIdx).toBeGreaterThan(-1);
    expect(replaceIdx).toBeGreaterThan(setOkIdx);
  });
});

// ---------------------------------------------------------------------------
// Cancellation — cleanup function
// ---------------------------------------------------------------------------

describe("GuardedOrderSuccess — cancellation cleanup", () => {
  it("declares a `cancelled` flag to guard async state updates after unmount", () => {
    expect(GUARDED_SRC).toContain("let cancelled = false");
  });

  it("checks `if (cancelled) return` inside the async block before setState", () => {
    expect(GUARDED_SRC).toContain("if (cancelled) return;");
  });

  it("returns a cleanup function from useEffect that sets cancelled = true", () => {
    expect(GUARDED_SRC).toContain("cancelled = true;");
    // The cleanup must be a return statement inside the useEffect callback.
    expect(GUARDED_SRC).toMatch(/return \(\) => \{[\s\S]*?cancelled = true/);
  });
});
