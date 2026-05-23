// Tests for pages/reminders.tsx
//
// PR change (P5): for signed-in shoppers the page now skips the magic-link
// inbox round-trip and SPA-routes straight to /reminders/manage on successful
// subscribe. The manage page resolves the row by session email (no token
// required), so a signed-in customer who subscribes using their own email
// lands immediately in the manage view.
//
// Key logic tested here:
//   * useShopIdentity imported and used to detect the signed-in state.
//   * email initial state pre-filled from identityEmail (not always "").
//   * willSkipTokenStep logic: isSignedIn + identityEmail matches submitted email.
//   * setLocation("/reminders/manage") called on success when willSkipTokenStep.
//   * Guest flow (not signed in, email doesn't match) shows the success card
//     instead of redirecting.
//
// The component uses React + hooks that cannot be rendered in the node
// vitest environment without jsdom. We read the source file as a string and
// assert on structural and security invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "reminders.tsx"), "utf8");

// ---------------------------------------------------------------------------
// P5 — signed-in identity imports
// ---------------------------------------------------------------------------

describe("reminders — useShopIdentity imported (P5)", () => {
  it("imports useShopIdentity from @/lib/identity", () => {
    expect(SRC).toContain('from "@/lib/identity"');
    expect(SRC).toMatch(/useShopIdentity/);
  });

  it("imports useLocation from wouter for SPA redirect", () => {
    expect(SRC).toContain('from "wouter"');
    expect(SRC).toMatch(/useLocation/);
  });

  it("destructures isSignedIn and email from useShopIdentity", () => {
    // The component needs both values from the hook.
    expect(SRC).toContain("isSignedIn");
    expect(SRC).toMatch(/identityEmail/);
  });
});

// ---------------------------------------------------------------------------
// P5 — email pre-fill for signed-in customers
// ---------------------------------------------------------------------------

describe("reminders — email field pre-filled from identity (P5)", () => {
  it("pre-fills the email state from identityEmail (via setEmail in a useEffect)", () => {
    // Source uses `useState("")` plus a `useEffect` that calls
    // `setEmail((prev) => prev || identityEmail)` once identity has
    // loaded — so the guest path keeps the empty input but a signed-in
    // visitor sees their session email auto-populated.
    expect(SRC).toContain('useState("")');
    expect(SRC).toMatch(/setEmail\(\(prev\)\s*=>\s*prev\s*\|\|\s*identityEmail\)/);
  });

  it("guards the pre-fill on identityLoaded + non-null identityEmail", () => {
    // The useEffect bails when identity hasn't loaded yet or the
    // visitor is a guest (identityEmail === null), so the input stays
    // empty for guests.
    expect(SRC).toMatch(/if\s*\(\s*!identityLoaded\s*\|\|\s*!identityEmail\s*\)\s*return/);
  });
});

// ---------------------------------------------------------------------------
// P5 — willSkipTokenStep logic
// ---------------------------------------------------------------------------

describe("reminders — willSkipTokenStep redirect logic (P5)", () => {
  it("computes willSkipTokenStep requiring isSignedIn to be true", () => {
    expect(SRC).toContain("isSignedIn &&");
    expect(SRC).toContain("willSkipTokenStep");
  });

  it("requires identityEmail to be non-null before comparing", () => {
    // A null identityEmail would cause toLowerCase() to throw — the null
    // guard must come before the comparison.
    expect(SRC).toContain("identityEmail !== null");
  });

  it("compares emails case-insensitively (toLowerCase on both sides)", () => {
    // The Supabase email column stores lowercase; the identity cookie may
    // retain mixed case. Both sides must be lowercased for a reliable match.
    expect(SRC).toMatch(/submittedEmail\.toLowerCase\(\)\s*===\s*identityEmail\.toLowerCase\(\)/);
  });

  it("redirects to /reminders/manage via setLocation when willSkipTokenStep", () => {
    // This is the core P5 behaviour: skip the "check your inbox" screen.
    expect(SRC).toContain('setLocation("/reminders/manage")');
  });

  it("returns immediately after setLocation so the success card is not shown", () => {
    // If we don't return, setSuccess would also run, overlaying the redirect.
    const locationIdx = SRC.indexOf('setLocation("/reminders/manage")');
    const returnIdx = SRC.indexOf("return;", locationIdx);
    expect(returnIdx).toBeGreaterThan(locationIdx);
    // The return must be before the next setSuccess call.
    const setSuccessIdx = SRC.indexOf("setSuccess({", locationIdx);
    expect(returnIdx).toBeLessThan(setSuccessIdx);
  });

  it("only redirects inside onSuccess (not on form submit, not unconditionally)", () => {
    // The redirect must be gated by the API success callback and the
    // willSkipTokenStep flag — it must not fire on validation error or
    // before the API responds.
    const onSuccessIdx = SRC.indexOf("onSuccess: (resp) => {");
    const redirectIdx = SRC.indexOf('setLocation("/reminders/manage")');
    expect(onSuccessIdx).toBeGreaterThan(-1);
    expect(redirectIdx).toBeGreaterThan(onSuccessIdx);
  });
});

// ---------------------------------------------------------------------------
// P5 — guest / email-mismatch path still shows the success card
// ---------------------------------------------------------------------------

describe("reminders — guest path still shows success card (P5 regression)", () => {
  it("still calls setSuccess for the guest/email-mismatch case", () => {
    // Guests (isSignedIn=false) or signed-in users who typed a different
    // email must still see the "Check your inbox" success card.
    expect(SRC).toContain("setSuccess({");
    expect(SRC).toContain("emailStatus: resp.emailStatus");
    expect(SRC).toContain("message: resp.message");
  });

  it("still renders the success card with 'Check your inbox' heading", () => {
    expect(SRC).toContain("Check your inbox");
  });

  it("willSkipTokenStep false branch calls setSuccess before scrollTo", () => {
    const skipFalseIdx = SRC.indexOf("setSuccess({");
    const scrollIdx = SRC.indexOf("window.scrollTo");
    expect(skipFalseIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(skipFalseIdx);
  });
});

// ---------------------------------------------------------------------------
// Core form behaviour — regression
// ---------------------------------------------------------------------------

describe("reminders — core form behaviour regression", () => {
  it("still validates that at least one item is enabled before submitting", () => {
    expect(SRC).toContain("Pick at least one supply");
  });

  it("still validates that the email field is not empty", () => {
    expect(SRC).toContain("Enter the email where you want reminders sent.");
  });

  it("still passes the honeypot 'website' field through to the API", () => {
    expect(SRC).toContain("website: website || undefined");
  });

  it("still renders the subscribe button with data-testid='button-subscribe'", () => {
    expect(SRC).toContain('data-testid="button-subscribe"');
  });

  it("still imports REMINDER_ITEMS for the checklist", () => {
    expect(SRC).toContain("REMINDER_ITEMS");
  });
});

// ---------------------------------------------------------------------------
// P5 — data shape: submittedEmail variable
// ---------------------------------------------------------------------------

describe("reminders — submittedEmail variable (P5 hygiene)", () => {
  it("extracts email.trim() into submittedEmail before building willSkipTokenStep", () => {
    // Using a named variable avoids calling .trim() multiple times and
    // makes the willSkipTokenStep conditional easier to read.
    expect(SRC).toContain("const submittedEmail = email.trim()");
  });

  it("passes submittedEmail (not email) to the API mutate call", () => {
    expect(SRC).toContain("email: submittedEmail");
  });
});

// ---------------------------------------------------------------------------
// Honeypot — still present (regression)
// ---------------------------------------------------------------------------

describe("reminders — honeypot field still present", () => {
  it("renders a honeypot website input that is aria-hidden", () => {
    expect(SRC).toContain('aria-hidden="true"');
    expect(SRC).toContain("id=\"reminder-website\"");
  });

  it("passes honeypot value to the API (bot detector on server side)", () => {
    expect(SRC).toContain("website: website || undefined");
  });
});

// ---------------------------------------------------------------------------
// PR change: email pre-fill — useEffect implementation details
// ---------------------------------------------------------------------------
// The PR updated these tests from testing a direct `useState(identityEmail ?? "")`
// initialiser to testing the `useState("") + useEffect` pattern. The following
// tests add confidence around the specific useEffect implementation.

describe("reminders — email pre-fill useEffect implementation detail", () => {
  it("the useEffect includes identityLoaded in its dependency array", () => {
    // The effect must re-run when identity loads so the email gets filled
    // after the async auth check resolves.
    expect(SRC).toMatch(/\[identityLoaded,\s*identityEmail\]/);
  });

  it("the guard bails early when identityEmail is null (guest stays empty)", () => {
    // !identityEmail covers both null and empty-string, protecting against
    // a setEmail call with a null/empty value that would clear a typed email.
    expect(SRC).toMatch(/if\s*\(\s*!identityLoaded\s*\|\|\s*!identityEmail\s*\)\s*return/);
  });

  it("setEmail uses a functional update to avoid overwriting user-typed input", () => {
    // setEmail((prev) => prev || identityEmail) means a user who has already
    // started typing their email won't have it replaced by the identity value.
    expect(SRC).toMatch(/setEmail\(\(prev\)\s*=>\s*prev\s*\|\|\s*identityEmail\)/);
  });

  it("email state is initialised as empty string before the effect runs", () => {
    // The useState("") ensures the input is empty during SSR and before the
    // identity probe resolves — no hydration mismatch.
    expect(SRC).toContain('useState("")');
  });

  it("does not use useState(identityEmail ?? '') — avoids SSR/hydration issues", () => {
    // The direct initialiser approach would use the identity value as the
    // initial render state; the effect approach defers it to client-side.
    expect(SRC).not.toContain('identityEmail ?? ""');
  });
});

// ---------------------------------------------------------------------------
// P5 — willSkipTokenStep additional edge-case guards
// ---------------------------------------------------------------------------

describe("reminders — willSkipTokenStep additional guards", () => {
  it("extracts email.trim() to submittedEmail to normalise whitespace before comparison", () => {
    expect(SRC).toContain("const submittedEmail = email.trim()");
  });

  it("requires isSignedIn check in willSkipTokenStep so guests never skip the inbox", () => {
    // If isSignedIn is false, willSkipTokenStep must be false regardless of email.
    expect(SRC).toContain("isSignedIn &&");
    expect(SRC).toContain("willSkipTokenStep");
  });

  it("null-checks identityEmail before calling toLowerCase to avoid runtime errors", () => {
    expect(SRC).toContain("identityEmail !== null");
  });

  it("wraps the redirect inside the onSuccess callback — not on every render", () => {
    const onSuccessIdx = SRC.indexOf("onSuccess: (resp) => {");
    // `willSkipTokenStep` is declared above onSuccess and re-used inside
    // it; lastIndexOf lands on the use-site (the redirect gate) which
    // is what the redirect-inside-callback invariant is checking.
    const skipIdx = SRC.lastIndexOf("willSkipTokenStep");
    expect(onSuccessIdx).toBeGreaterThan(-1);
    expect(skipIdx).toBeGreaterThan(onSuccessIdx);
  });
});
