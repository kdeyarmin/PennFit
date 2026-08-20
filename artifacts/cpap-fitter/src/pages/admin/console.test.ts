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
  it("still redirects to the sign-in page when no session (data is null)", () => {
    // The destination is built by buildAdminSignInHref() rather than
    // hardcoded, so the deep link the visitor asked for survives sign-in
    // (see lib/admin/sign-in-redirect.ts). It still resolves to
    // /admin/sign-in — that helper owns the path and is tested there.
    expect(SRC).toContain("<Redirect to={buildAdminSignInHref()} />");
    expect(SRC).toContain(
      'import { buildAdminSignInHref } from "@/lib/admin/sign-in-redirect"',
    );
  });

  it("still renders a loading indicator while the session probe is pending", () => {
    expect(SRC).toContain("isPending)");
    expect(SRC).toContain("Spinner");
  });

  it("renders AdminConsole after successful session probe", () => {
    expect(SRC).toContain("AdminConsole");
  });
});

// ---------------------------------------------------------------------------
// App.tsx — change-password route also removed
// ---------------------------------------------------------------------------
describe("App.tsx — AdminChangePasswordPage route removed", () => {
  const APP_SRC = readFileSync(path.join(__dirname, "../../App.tsx"), "utf8");

  it("does NOT lazy-import AdminChangePasswordPage", () => {
    expect(APP_SRC).not.toContain("AdminChangePasswordPage");
  });

  it("does NOT mount a /admin/change-password route", () => {
    expect(APP_SRC).not.toContain("/admin/change-password");
  });

  it("still mounts the /admin/sign-in route", () => {
    expect(APP_SRC).toContain("/admin/sign-in");
  });

  it("still mounts the /admin/reset-password route", () => {
    expect(APP_SRC).toContain("/admin/reset-password");
  });

  it("still mounts the /admin/forgot-password route", () => {
    expect(APP_SRC).toContain("/admin/forgot-password");
  });
});

// ---------------------------------------------------------------------------
// change-password.tsx — file removed from the codebase
// ---------------------------------------------------------------------------
describe("change-password.tsx — file deleted in this PR", () => {
  it("change-password.tsx no longer exists", () => {
    let fileExists = true;
    try {
      readFileSync(path.join(__dirname, "change-password.tsx"), "utf8");
    } catch {
      fileExists = false;
    }
    expect(fileExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConsoleRoute — structural checks
// ---------------------------------------------------------------------------
describe("ConsoleRoute — structural checks", () => {
  it("exports ConsoleRoute as a named export", () => {
    expect(SRC).toContain("export function ConsoleRoute");
  });

  it("uses authHooks.useSession() to probe the session", () => {
    expect(SRC).toContain("authHooks.useSession()");
  });

  it("ConsoleRoute body only has two guards (pending + no-data) before rendering", () => {
    // With the mustChangePassword guard removed, there should be exactly:
    // 1. if (isPending) return null
    // 2. if (!data) return <Redirect ...>
    // 3. return <AdminConsole />
    // Assert that mustChangePassword is absent (already covered) and
    // that AdminConsole is the terminal return.
    expect(SRC).toContain("return <AdminConsole />");
  });
});
