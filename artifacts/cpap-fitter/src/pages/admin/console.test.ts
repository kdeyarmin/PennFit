// Tests for admin/console.tsx — the mustChangePassword gate removal in this PR.
//
// PR changes:
//   * ConsoleRoute no longer redirects to /admin/change-password
//     when data.mustChangePassword is true.
//   * The comment about "must change password" gate was also removed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

// ---------------------------------------------------------------------------
// ConsoleRoute — mustChangePassword gate removed
// ---------------------------------------------------------------------------
describe("ConsoleRoute — mustChangePassword redirect removed", () => {
  it("does NOT check mustChangePassword in ConsoleRoute", () => {
    expect(SRC).not.toContain("mustChangePassword");
  });

  it("does NOT redirect to /admin/change-password", () => {
    expect(SRC).not.toContain("/admin/change-password");
  });
});

// ---------------------------------------------------------------------------
// ConsoleRoute — core authentication gate retained
// ---------------------------------------------------------------------------
describe("ConsoleRoute — session-required gate still present", () => {
  it("still redirects to /admin/sign-in when no session (data is null)", () => {
    expect(SRC).toContain("/admin/sign-in");
    expect(SRC).toContain('Redirect to="/admin/sign-in"');
  });

  it("still returns null while the session probe is pending", () => {
    expect(SRC).toContain("isPending) return null");
  });

  it("renders AdminConsole after successful session probe", () => {
    expect(SRC).toContain("AdminConsole");
  });
});

// ---------------------------------------------------------------------------
// App.tsx — change-password route also removed
// ---------------------------------------------------------------------------
describe("App.tsx — AdminChangePasswordPage route removed", () => {
  const APP_SRC = readFileSync(
    path.join(__dirname, "../../App.tsx"),
    "utf8",
  );

  it("does NOT lazy-import AdminChangePasswordPage", () => {
    expect(APP_SRC).not.toContain("AdminChangePasswordPage");
  });

  it("does NOT mount a /admin/change-password route", () => {
    expect(APP_SRC).not.toContain("/admin/change-password");
  });
});