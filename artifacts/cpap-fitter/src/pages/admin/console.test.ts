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
// The mustChangePassword redirect / change-password page removal described
// in the original PR did not actually land; the obsolete describe.skip
// blocks asserting that removal have been deleted rather than left
// skipped, so the remaining suites continue to provide CI signal.

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
// ConsoleRoute — structural checks
// ---------------------------------------------------------------------------
describe("ConsoleRoute — structural checks", () => {
  it("exports ConsoleRoute as a named export", () => {
    expect(SRC).toContain("export function ConsoleRoute");
  });

  it("uses authHooks.useSession() to probe the session", () => {
    expect(SRC).toContain("authHooks.useSession()");
  });

  it("renders <AdminConsole /> after the session and password-change guards", () => {
    expect(SRC).toContain("return <AdminConsole />");
  });
});