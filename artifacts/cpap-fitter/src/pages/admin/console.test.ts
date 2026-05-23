// Tests for admin/console.tsx
//
// PR changes verified here:
//   * The mustChangePassword redirect removed from ConsoleRoute —
//     no longer bounces to /admin/change-password when
//     data.mustChangePassword is true.
//   * The comment explaining the forced-rotation gate was removed.
//   * ConsoleRoute now only checks for a missing session (redirects
//     to /admin/sign-in) and otherwise renders AdminConsole.
//
// The component uses React which cannot be rendered in the node vitest
// environment without jsdom. We read the source file as a string and
// assert on the structural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Removed: mustChangePassword gate
// ---------------------------------------------------------------------------
describe("admin/console ConsoleRoute — mustChangePassword gate removed", () => {
  it("does not reference mustChangePassword", () => {
    expect(SRC).not.toContain("mustChangePassword");
  });

  it("does not redirect to /admin/change-password", () => {
    expect(SRC).not.toContain("/admin/change-password");
  });

  it("does not import or reference the ChangePasswordPage", () => {
    expect(SRC).not.toContain("ChangePasswordPage");
    expect(SRC).not.toContain("change-password");
  });
});

// ---------------------------------------------------------------------------
// Removed: change-password module import / lazy declaration
// ---------------------------------------------------------------------------
describe("admin/console — AdminChangePasswordPage lazy import removed", () => {
  it("does not contain AdminChangePasswordPage lazy import", () => {
    expect(SRC).not.toContain("AdminChangePasswordPage");
  });
});

// ---------------------------------------------------------------------------
// Current ConsoleRoute behaviour: session-only gate
// ---------------------------------------------------------------------------
describe("admin/console ConsoleRoute — current session gate", () => {
  it("defines the ConsoleRoute function", () => {
    expect(SRC).toContain("export function ConsoleRoute()");
  });

  it("uses authHooks.useSession to check for a session", () => {
    expect(SRC).toContain("authHooks.useSession()");
  });

  it("redirects to /admin/sign-in when there is no session data", () => {
    expect(SRC).toContain('Redirect to="/admin/sign-in"');
  });

  it("renders nothing while the session probe is pending", () => {
    expect(SRC).toContain("if (isPending) return null");
  });

  it("renders AdminConsole when a session is present", () => {
    expect(SRC).toContain("return <AdminConsole />");
  });

  it("ConsoleRoute body has no extra branch between the session check and AdminConsole", () => {
    // Extract the ConsoleRoute function body and verify it has no
    // mustChangePassword or change-password conditional.
    const start = SRC.indexOf("export function ConsoleRoute()");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = SRC.indexOf("\n}", start);
    const body = SRC.slice(start, end + 2);
    expect(body).not.toContain("mustChangePassword");
    expect(body).not.toContain("change-password");
    // Three-branch structure: isPending → !data → AdminConsole
    expect(body).toContain("if (isPending) return null");
    expect(body).toContain("if (!data)");
    expect(body).toContain("<AdminConsole />");
  });
});