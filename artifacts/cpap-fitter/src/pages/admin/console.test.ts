// Static analysis tests for pages/admin/console.tsx — ConsoleRoute changes.
//
// PR changes:
//   * Removed the `mustChangePassword` redirect: ConsoleRoute previously bounced
//     users to /admin/change-password when /auth/me returned mustChangePassword:true.
//     That gate is gone — ConsoleRoute only redirects to sign-in (no session) or
//     renders AdminConsole (session present).
//   * Removed the /admin/change-password route and its lazy import from App.tsx.
//
// The component uses React hooks and cannot be rendered in the node vitest
// environment without jsdom. We read the source file as a string and assert the
// structural invariants that matter.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "console.tsx"), "utf8");

describe("ConsoleRoute — mustChangePassword gate removed", () => {
  it("does NOT redirect to /admin/change-password", () => {
    expect(SRC).not.toContain("/admin/change-password");
  });

  it("does NOT reference mustChangePassword in ConsoleRoute", () => {
    // The forced-rotation gate is gone: ConsoleRoute no longer reads
    // data.mustChangePassword and no longer redirects to the change-password
    // page. Any future regression that re-adds this gate should be flagged.
    expect(SRC).not.toContain("mustChangePassword");
  });

  it("still redirects to /admin/sign-in when no session is present", () => {
    expect(SRC).toContain('"/admin/sign-in"');
  });

  it("exports ConsoleRoute as a named export", () => {
    expect(SRC).toContain("export function ConsoleRoute()");
  });

  it("uses useSession to probe the session before rendering", () => {
    expect(SRC).toContain("useSession");
  });

  it("returns null while the session probe is pending (loading state)", () => {
    expect(SRC).toContain("isPending");
    expect(SRC).toContain("return null");
  });
});

describe("ConsoleRoute — simplified control flow", () => {
  it("has exactly two control-flow branches: no-session and has-session", () => {
    // Extract just the ConsoleRoute function body.
    const fnStart = SRC.indexOf("export function ConsoleRoute()");
    const fnEnd = SRC.indexOf("\n}", fnStart);
    const fnBody = SRC.slice(fnStart, fnEnd);

    // The function has:
    //   if (isPending) return null;
    //   if (!data) return <Redirect to="/admin/sign-in" />;
    //   return <AdminConsole />;
    // No third branch for mustChangePassword.
    const redirectCount = (fnBody.match(/<Redirect/g) ?? []).length;
    expect(redirectCount).toBe(1);
  });

  it("renders AdminConsole when a session is present", () => {
    expect(SRC).toContain("return <AdminConsole />");
  });
});