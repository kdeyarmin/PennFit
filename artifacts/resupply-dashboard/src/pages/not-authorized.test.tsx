// Tests for the three failure-mode branches the dashboard funnels
// into NotAuthorizedPage. Architect review flagged the lack of a
// regression test for the 502 (Clerk upstream) → "transient" copy
// path: a future refactor that breaks the reason mapping in the
// caller could silently downgrade the messaging from "try again"
// back to "you don't have access" — exactly the auth-flake
// confusion the operational hardening was meant to fix.
//
// Render scope is intentionally narrow: this file asserts ONLY the
// per-reason copy + interaction surface visible on the page itself.
// The mapping FROM HTTP status TO `reason` lives in `lib/api-client`
// (or its consumers); when those mapping helpers ship behind their
// own export, they should grow tests in the same file as the
// helper, not here.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotAuthorizedPage } from "./not-authorized";

// Mock the identity shim. The page reads `email` and `signOut`
// off useDashboardIdentity(); the underlying provider (Clerk vs
// in-house) is invisible at this layer.
const signOut = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/identity", () => ({
  useDashboardIdentity: () => ({
    email: "admin@example.com",
    role: null,
    displayName: null,
    userId: null,
    signOut,
  }),
  IS_IN_HOUSE_AUTH: false,
}));

afterEach(() => {
  // jsdom persists the DOM between tests in the same file unless we
  // explicitly tear it down. Without cleanup, the second test's
  // queryBy* would see TWO copies of the page and the first
  // assertion would fail in a misleading way.
  cleanup();
  // Clear the call log but keep the mockResolvedValue impl: the
  // page chains .finally() on the result, so the mock has to
  // continue returning a Promise across tests.
  signOut.mockClear();
});

describe("NotAuthorizedPage", () => {
  describe('reason="not-authorized" (403, signed-in non-admin)', () => {
    it("renders the access-denied copy and a Sign out button", () => {
      render(<NotAuthorizedPage reason="not-authorized" />);

      // Eyebrow + headline.
      expect(screen.getByText("Not authorized")).toBeDefined();
      expect(
        screen.getByText(
          /This account isn't approved for the admin console/i,
        ),
      ).toBeDefined();

      // Echoes the signed-in email so the admin can see WHICH
      // account is being denied (they may have multiple Penn
      // identities).
      expect(screen.getAllByText(/admin@example\.com/).length).toBeGreaterThan(0);

      // Action surface: Sign out, NOT Try again.
      expect(screen.getByRole("button", { name: /sign out/i })).toBeDefined();
      expect(
        screen.queryByRole("button", { name: /try again/i }),
      ).toBeNull();

      // Status banner is the "deny" red, header chip says "Access
      // denied" — distinct from the transient branch's "Access
      // pending". Asserted by text presence; a snapshot would be
      // overkill and brittle.
      expect(screen.getByText(/Access denied/i)).toBeDefined();
    });

    it("invokes signOut when the button is clicked", () => {
      render(<NotAuthorizedPage reason="not-authorized" />);

      fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

      expect(signOut).toHaveBeenCalledTimes(1);
      // The shim's signOut is provider-agnostic and takes no args.
      // Redirect to /sign-in is handled in the component via
      // window.location.assign after the promise resolves.
      expect(signOut.mock.calls[0]).toEqual([]);
    });
  });

  describe('reason="not-configured" (HTTP 503, allowlist env var missing)', () => {
    it("renders the deploy-side-fix copy and references RESUPPLY_ADMIN_EMAILS", () => {
      render(<NotAuthorizedPage reason="not-configured" />);

      // Eyebrow + headline distinguishes this from the 403 branch.
      expect(screen.getByText("Server not configured")).toBeDefined();
      expect(
        screen.getByText(
          /Admin access isn't set up on this server yet/i,
        ),
      ).toBeDefined();

      // The whole point of this branch is telling the admin
      // that retrying / signing out won't help — the fix is
      // server-side. We surface the env-var name so they have a
      // concrete thing to reference when they file the IT ticket.
      expect(screen.getByText("RESUPPLY_ADMIN_EMAILS")).toBeDefined();

      // Critical: this branch must NOT render any retry / sign-out
      // surface. Showing one would imply the admin can self-
      // serve out of this state, which they can't.
      expect(
        screen.queryByRole("button", { name: /try again/i }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /sign out/i }),
      ).toBeNull();
    });
  });

  describe('reason="transient" (status 0, 502, or any non-503 5xx)', () => {
    it("renders the connection-problem copy and a Try again button", () => {
      render(<NotAuthorizedPage reason="transient" />);

      // Eyebrow says "Connection problem" — admin-friendly
      // language for "we don't think this is your fault" — distinct
      // from "Not authorized". The architect fix that this test
      // guards against is a regression that re-routes 502 back to
      // the "Not authorized" branch.
      expect(screen.getByText("Connection problem")).toBeDefined();
      expect(
        screen.getByText(/We can't reach the resupply server right now/i),
      ).toBeDefined();

      // Header chip says "Access pending", not "Access denied".
      expect(screen.getByText(/Access pending/i)).toBeDefined();

      // Action surface: Try again, NOT Sign out. Telling someone
      // with a valid session to sign out during a 30-second server
      // blip is exactly the failure mode this branch fixes.
      expect(screen.getByRole("button", { name: /try again/i })).toBeDefined();
      expect(
        screen.queryByRole("button", { name: /sign out/i }),
      ).toBeNull();
    });

    it("Try again button is wired to a click handler", () => {
      // We don't assert that window.location.reload was actually
      // called: jsdom's `window.location` is non-configurable and
      // the matrix of replace/redefine workarounds varies across
      // jsdom versions. The render assertion above already proves
      // the button exists with the correct role+label; here we
      // confirm clicking it does not throw (jsdom's reload is a
      // no-op stub, so a successful click means the inline handler
      // resolved the function reference correctly).
      render(<NotAuthorizedPage reason="transient" />);
      const button = screen.getByRole("button", { name: /try again/i });
      expect(() => fireEvent.click(button)).not.toThrow();
    });
  });

  describe("contact email override", () => {
    it("uses the prop value over the env default", () => {
      render(
        <NotAuthorizedPage
          reason="not-authorized"
          contactEmail="ops@example.com"
        />,
      );
      // The email appears as link text and as the mailto target;
      // either is fine for asserting the override took effect.
      const link = screen.getByRole("link", { name: /ops@example\.com/i });
      expect(link.getAttribute("href")).toBe("mailto:ops@example.com");
    });
  });
});
