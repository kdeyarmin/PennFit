// Source-text regression tests for the auth page cleanup in this PR.
//
// These tests read the TypeScript source of auth-related pages and
// assert that removed features are absent and new patterns are present.
// This guards against accidental re-introduction of the deleted code
// without running a browser / component harness.
//
// Removed in this PR:
//   * SERVER_UNAVAILABLE_MESSAGE constant + authErrorMessage helper
//     (sign-in.tsx, admin/sign-in.tsx, reset-password.tsx,
//      admin/reset-password.tsx)
//   * submitError state driven by AuthError 5xx detection
//     (forgot-password.tsx, admin/forgot-password.tsx)
//   * AuthError import on forgot-password pages (not needed after simplification)
//   * mustChangePassword redirect in ConsoleRoute (admin/console.tsx)
//   * AdminChangePasswordPage lazy import + /admin/change-password route
//     (App.tsx)
//
// Added / changed in this PR:
//   * onSettled replaces the onSuccess / onError pair on both forgot-password
//     pages (either outcome renders the success state)
//   * ConsoleRoute: only two guards — isPending + !data

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(relPath: string): string {
  return readFileSync(path.join(__dirname, relPath), "utf8");
}

// ─── App.tsx — AdminChangePasswordPage removed ───────────────────────────────

describe("App.tsx — AdminChangePasswordPage removed", () => {
  const SRC = read("../App.tsx");

  it("does not lazy-import AdminChangePasswordPage", () => {
    expect(SRC).not.toContain("AdminChangePasswordPage");
  });

  it("does not register /admin/change-password route", () => {
    expect(SRC).not.toContain('path="/admin/change-password"');
  });

  it("does not import from @/pages/admin/change-password", () => {
    expect(SRC).not.toContain("admin/change-password");
  });
});

// ─── admin/console.tsx — mustChangePassword gate removed ─────────────────────

describe("admin/console.tsx — mustChangePassword gate removed", () => {
  const SRC = read("admin/console.tsx");

  it("ConsoleRoute does not redirect to /admin/change-password", () => {
    expect(SRC).not.toContain("/admin/change-password");
  });

  it("ConsoleRoute does not reference mustChangePassword", () => {
    expect(SRC).not.toContain("mustChangePassword");
  });

  it("ConsoleRoute is still present in the file", () => {
    expect(SRC).toContain("export function ConsoleRoute");
  });

  it("ConsoleRoute still redirects to /admin/sign-in when no session", () => {
    expect(SRC).toContain("/admin/sign-in");
  });
});

// ─── admin/sign-in.tsx — authErrorMessage helper removed ─────────────────────

describe("admin/sign-in.tsx — SERVER_UNAVAILABLE_MESSAGE / authErrorMessage removed", () => {
  const SRC = read("admin/sign-in.tsx");

  it("does not define SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not define authErrorMessage helper", () => {
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("still imports AuthError for error branching", () => {
    expect(SRC).toContain("AuthError");
  });

  it("uses err.userMessage directly in onError", () => {
    expect(SRC).toContain("err.userMessage");
  });
});

// ─── admin/forgot-password.tsx — onSettled, no AuthError import ──────────────

describe("admin/forgot-password.tsx — onSettled and no AuthError import", () => {
  const SRC = read("admin/forgot-password.tsx");

  it("uses onSettled to handle mutation completion", () => {
    expect(SRC).toContain("onSettled");
  });

  it("does not import AuthError (no 5xx handling needed)", () => {
    // AuthError is only needed for the 5xx branch that was removed.
    expect(SRC).not.toContain("AuthError");
  });

  it("does not define a submitError state (no server-unavailable copy)", () => {
    expect(SRC).not.toContain("submitError");
  });

  it("does not contain SERVER_UNAVAILABLE_MESSAGE copy", () => {
    expect(SRC).not.toContain("credentials store right now");
  });
});

// ─── admin/reset-password.tsx — authErrorMessage removed ─────────────────────

describe("admin/reset-password.tsx — SERVER_UNAVAILABLE_MESSAGE removed", () => {
  const SRC = read("admin/reset-password.tsx");

  it("does not define SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not define authErrorMessage helper", () => {
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("still imports AuthError for error branching", () => {
    expect(SRC).toContain("AuthError");
  });

  it("does not contain status >= 500 credential-store copy", () => {
    expect(SRC).not.toContain("credentials store right now");
  });
});

// ─── patient forgot-password.tsx — onSettled, no AuthError import ────────────

describe("forgot-password.tsx (patient) — onSettled and no AuthError import", () => {
  const SRC = read("forgot-password.tsx");

  it("uses onSettled to handle mutation completion", () => {
    expect(SRC).toContain("onSettled");
  });

  it("does not import AuthError", () => {
    expect(SRC).not.toContain("AuthError");
  });

  it("does not define a submitError state", () => {
    expect(SRC).not.toContain("submitError");
  });

  it("does not contain SERVER_UNAVAILABLE_MESSAGE copy", () => {
    expect(SRC).not.toContain("credentials store right now");
  });
});

// ─── patient sign-in.tsx — authErrorMessage removed ──────────────────────────

describe("sign-in.tsx (patient) — SERVER_UNAVAILABLE_MESSAGE / authErrorMessage removed", () => {
  const SRC = read("sign-in.tsx");

  it("does not define SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not define authErrorMessage helper", () => {
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("still imports AuthError for error branching", () => {
    expect(SRC).toContain("AuthError");
  });

  it("uses err.userMessage directly in onError", () => {
    expect(SRC).toContain("err.userMessage");
  });
});

// ─── patient reset-password.tsx — authErrorMessage removed ───────────────────

describe("reset-password.tsx (patient) — SERVER_UNAVAILABLE_MESSAGE removed", () => {
  const SRC = read("reset-password.tsx");

  it("does not define SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not define authErrorMessage helper", () => {
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("still imports AuthError for error branching", () => {
    expect(SRC).toContain("AuthError");
  });

  it("does not contain status >= 500 credential-store copy", () => {
    expect(SRC).not.toContain("credentials store right now");
  });
});

// ─── admin-team.tsx — initialPassword UI removed ─────────────────────────────

describe("admin/admin-team.tsx — initialPassword UI removed", () => {
  const SRC = read("admin/admin-team.tsx");

  it("does not render the set-password-mode checkbox", () => {
    expect(SRC).not.toContain("setPasswordMode");
    expect(SRC).not.toContain("team-invite-set-password-toggle");
  });

  it("does not render the initialPassword input field", () => {
    expect(SRC).not.toContain("initialPassword");
    expect(SRC).not.toContain("team-invite-initial-password");
  });

  it("does not show a signInReady success banner", () => {
    expect(SRC).not.toContain("signInReady");
    expect(SRC).not.toContain("team-invite-success");
  });

  it("still renders the invite submit button", () => {
    expect(SRC).toContain("team-invite-submit");
  });

  it("submit button label is always 'Send invitation' (no 'Create account' variant)", () => {
    expect(SRC).toContain("Send invitation");
    expect(SRC).not.toContain("Create account");
  });
});