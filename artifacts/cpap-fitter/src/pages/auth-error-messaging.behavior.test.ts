// Behavioral coverage for the 5xx "server-trouble" notice on the
// three customer-facing auth pages: sign-in, forgot-password, and
// reset-password.
//
// The companion test files (`sign-in.test.ts`, `forgot-password.test.ts`,
// `reset-password.test.ts`) assert that each page imports the shared
// helper and passes the right action/subject/fallback option literals.
// That catches "the page forgot to call the helper" regressions, but
// it can NOT catch:
//
//   * a refactor of `authErrorMessage` / `serverUnavailableMessage`
//     that breaks the 5xx branch (e.g. swapping `>= 500` for `> 500`,
//     or dropping the status.pennpaps.com reference);
//   * a change to `AuthError.status` semantics that makes status=503
//     no longer look like a server outage to the helper;
//   * the forgot-password no-enumeration contract (4xx → success
//     view, 5xx → visible error) regressing because the helper
//     started rendering some non-empty string for 4xx that the page
//     would then show as an error.
//
// To pin those behaviors we feed real `AuthError` instances through
// the shared helper using the EXACT option literals each page passes
// (kept in sync via the source-grep tests above). If a future agent
// changes either the helper internals or the page options, at least
// one of these assertions will fail loudly.

import { describe, expect, it } from "vitest";

import {
  AuthError,
  authErrorMessage,
  serverUnavailableMessage,
} from "@workspace/resupply-auth-react";

// Real branch from forgot-password.tsx — extracted to a named export
// so the no-enumeration contract is tested against actual page code,
// not a parallel reimplementation that could silently drift.
import { decideForgotPasswordErrorOutcome } from "./forgot-password.helpers";

// The exact option literals each page passes today. Mirrored from
// the corresponding `.tsx` files (and pinned in source-grep form by
// the companion `*.test.ts` siblings).
const SIGN_IN_OPTS = {
  action: "sign you in",
  subject: "password",
  fallback: "Sign-in failed.",
} as const;
const FORGOT_OPTS = {
  action: "send a reset link",
  subject: "email",
} as const;
const RESET_OPTS = {
  action: "update your password",
  subject: "reset link",
  fallback: "Could not reset your password.",
} as const;

// The bits of copy the 5xx branch must produce, regardless of which
// page is calling. If status.pennpaps.com ever moves or the
// "credentials store" phrasing changes, we want to know explicitly.
const STATUS_URL_SUBSTRING = "status.pennpaps.com";
const CREDENTIALS_STORE_SUBSTRING = "credentials store";

describe("customer sign-in — 5xx renders server-trouble copy", () => {
  it("renders the server-unavailable notice for a 503 AuthError", () => {
    const err = new AuthError(503, "unknown", "ignored server message");
    const msg = authErrorMessage(err, SIGN_IN_OPTS);
    expect(msg).toContain(CREDENTIALS_STORE_SUBSTRING);
    expect(msg).toContain(STATUS_URL_SUBSTRING);
    // The page-specific action verb must appear so the user knows
    // WHAT failed ("couldn't sign you in") and is reassured it's
    // not their password.
    expect(msg).toContain("sign you in");
    expect(msg).toContain("password");
  });

  it("renders the server-unavailable notice for the lowest 5xx (500)", () => {
    // Pins the >= 500 lower bound — a `> 500` regression would fail
    // here because exactly-500 would no longer route to this branch.
    const err = new AuthError(500, "unknown", "ignored");
    expect(authErrorMessage(err, SIGN_IN_OPTS)).toContain(
      CREDENTIALS_STORE_SUBSTRING,
    );
  });

  it("does NOT render the server-trouble copy for a 4xx (credential) error", () => {
    // 401 invalid_credentials: the userMessage must come through
    // verbatim so the user knows it's their password, not an outage.
    const err = new AuthError(
      401,
      "invalid_credentials",
      "Email or password is incorrect.",
    );
    const msg = authErrorMessage(err, SIGN_IN_OPTS);
    expect(msg).toBe("Email or password is incorrect.");
    expect(msg).not.toContain(CREDENTIALS_STORE_SUBSTRING);
    expect(msg).not.toContain(STATUS_URL_SUBSTRING);
  });

  it("falls back to the page-specific generic copy on a non-AuthError throw", () => {
    // Network errors and other surprises must not crash the form —
    // the helper folds them onto the fallback string.
    expect(authErrorMessage(new TypeError("fetch failed"), SIGN_IN_OPTS)).toBe(
      SIGN_IN_OPTS.fallback,
    );
    expect(authErrorMessage("string thrown", SIGN_IN_OPTS)).toBe(
      SIGN_IN_OPTS.fallback,
    );
  });
});

describe("customer forgot-password — 5xx shows notice, 4xx preserves no-enumeration", () => {
  // These call `decideForgotPasswordErrorOutcome`, which is the
  // EXACT branch the page's onError installs. If the page changes
  // its branch (or stops calling this helper), the next set of
  // assertions will fail loudly rather than passing on a parallel
  // reimplementation.

  it("5xx routes to the visible server-trouble notice", () => {
    const outcome = decideForgotPasswordErrorOutcome(
      new AuthError(503, "unknown", "ignored"),
    );
    expect(outcome.kind).toBe("show-error");
    if (outcome.kind !== "show-error") return;
    expect(outcome.message).toContain(CREDENTIALS_STORE_SUBSTRING);
    expect(outcome.message).toContain(STATUS_URL_SUBSTRING);
    expect(outcome.message).toContain("send a reset link");
    expect(outcome.message).toContain("email");
  });

  it("500 (boundary) also routes to the visible notice", () => {
    const outcome = decideForgotPasswordErrorOutcome(
      new AuthError(500, "unknown", "ignored"),
    );
    expect(outcome.kind).toBe("show-error");
    if (outcome.kind !== "show-error") return;
    expect(outcome.message).toContain(CREDENTIALS_STORE_SUBSTRING);
  });

  it("4xx unknown-email response folds to the success view (no enumeration)", () => {
    // Even if the server somehow returned a 404 with a leaky
    // "no such account" message, the page must hide it behind the
    // generic success view.
    expect(
      decideForgotPasswordErrorOutcome(
        new AuthError(404, "unknown", "no such account"),
      ).kind,
    ).toBe("fold-to-success");
  });

  it("4xx validation error also folds to the success view", () => {
    expect(
      decideForgotPasswordErrorOutcome(
        new AuthError(400, "unknown", "Email is required."),
      ).kind,
    ).toBe("fold-to-success");
  });

  it("non-AuthError throws (network failure) fold to the success view", () => {
    // A dropped connection mid-submit must NOT leak into a visible
    // error; the no-enumeration contract trumps the UX preference
    // for a precise error message here.
    expect(
      decideForgotPasswordErrorOutcome(new TypeError("fetch failed")).kind,
    ).toBe("fold-to-success");
    expect(decideForgotPasswordErrorOutcome("string thrown").kind).toBe(
      "fold-to-success",
    );
    expect(decideForgotPasswordErrorOutcome(undefined).kind).toBe(
      "fold-to-success",
    );
  });

  it("the visible 5xx copy mentions the forgot-password action verb", () => {
    // Guard against a future helper change that drops the action /
    // subject substitution — shoppers must understand WHAT failed.
    const out = serverUnavailableMessage(FORGOT_OPTS);
    expect(out).toContain("send a reset link");
    expect(out).toContain("not your email");
  });
});

describe("customer reset-password — 5xx token-verification failure", () => {
  it("renders the server-trouble copy for a 503 from the reset endpoint", () => {
    // Reset-password's 5xx case is "the token-verification + new-
    // password write couldn't reach the credentials store" — same
    // shape as sign-in, different action/subject.
    const err = new AuthError(503, "unknown", "ignored");
    const msg = authErrorMessage(err, RESET_OPTS);
    expect(msg).toContain(CREDENTIALS_STORE_SUBSTRING);
    expect(msg).toContain(STATUS_URL_SUBSTRING);
    expect(msg).toContain("update your password");
    expect(msg).toContain("reset link");
  });

  it("preserves a 4xx expired-token userMessage verbatim", () => {
    // The server's "this link has expired, request a new one"
    // message must come through unchanged — telling the user the
    // credentials store is down would be misleading.
    const err = new AuthError(
      400,
      "unknown",
      "This reset link has expired. Request a new one.",
    );
    const msg = authErrorMessage(err, RESET_OPTS);
    expect(msg).toBe("This reset link has expired. Request a new one.");
    expect(msg).not.toContain(CREDENTIALS_STORE_SUBSTRING);
  });

  it("falls back to the page-specific generic copy on a non-AuthError throw", () => {
    expect(authErrorMessage(new Error("boom"), RESET_OPTS)).toBe(
      RESET_OPTS.fallback,
    );
  });
});
