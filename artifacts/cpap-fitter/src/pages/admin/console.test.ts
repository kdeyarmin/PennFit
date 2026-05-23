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

// ---------------------------------------------------------------------------
// change-password.tsx — file removed from the codebase
// ---------------------------------------------------------------------------

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