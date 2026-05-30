// Tests for ConsoleRoute in console.tsx.
//
// This PR simplified ConsoleRoute by removing the mustChangePassword check.
// Previously, ConsoleRoute would redirect to /admin/change-password when
// /auth/me returned mustChangePassword:true. That gate is now removed because
// the "set their password for them" admin invite flow was removed entirely.
//
// These tests inspect the source code to verify the simplification and its
// regressions are pinned.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

describe("ConsoleRoute — mustChangePassword gate removed", () => {
  it("does not redirect to /admin/change-password", () => {
    expect(SRC).not.toContain("/admin/change-password");
  });

  it("does not reference mustChangePassword in ConsoleRoute", () => {
    // The mustChangePassword check was the only gate added in the PR that
    // was backed by the "set their password for them" invite flow.
    expect(SRC).not.toContain("mustChangePassword");
  });

  it("ConsoleRoute function is present in the source", () => {
    expect(SRC).toContain("function ConsoleRoute");
  });

  it("ConsoleRoute redirects to /admin/sign-in when no session data", () => {
    // The session-required gate must still be present.
    expect(SRC).toContain('Redirect to="/admin/sign-in"');
  });

  it("ConsoleRoute renders AdminConsole when session is present", () => {
    expect(SRC).toContain("AdminConsole");
  });
});

describe("ConsoleRoute — change-password import removed", () => {
  it("does not import from admin/change-password", () => {
    expect(SRC).not.toContain("change-password");
  });
});

describe("ConsoleRoute — export is stable", () => {
  it("exports ConsoleRoute as a named export", () => {
    expect(SRC).toContain("export function ConsoleRoute");
  });
});
