// @vitest-environment jsdom
//
// Render regression test for the platform System-info page (the
// deployment-metadata view that used to be the tenant /admin/settings
// page; it now lives on the platform super-admin console). Plus a smoke
// test that the slimmed tenant Settings page renders the demo toggle.
//
// History: the page declared a `SystemInfo.encryption.{phiKeyConfigured,
// phoneHmacKeyConfigured}` object and rendered `data.encryption.*` directly.
// The backend `/admin/system-info` route never returned an `encryption` key
// (PHI/pgcrypto encryption was stripped in migration 0025; it returns
// `secrets.linkHmacKeyConfigured` instead). On a successful load the deref of
// the missing `data.encryption` threw `TypeError: Cannot read properties of
// undefined`, which bubbled to the top-level ErrorBoundary and showed the
// patient-facing "Something went wrong" screen.
//
// This test renders the page with a payload shaped EXACTLY like the real
// backend response (no `encryption` key) and asserts it renders without
// throwing. If anyone reintroduces a `data.encryption.*` access, the render
// crashes here and the test fails.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Mirrors the real /admin/system-info response shape from
// artifacts/resupply-api/src/routes/admin/system-info.ts — note: NO
// `encryption` key; `secrets.linkHmacKeyConfigured` instead.
const SYSTEM_INFO = {
  server: {
    now: new Date("2026-06-05T12:00:00.000Z").toISOString(),
    nodeVersion: "v24.0.0",
    pgVersion: null,
    uptimeSeconds: 3725,
    gitSha: "abc1234",
    nodeEnv: "production",
  },
  database: { migrationCount: 0, lastMigrationAt: null },
  publicUrls: { shop: "https://pennfit.example", voice: null, dashboard: null },
  auth: {
    adminAllowlistCount: 2,
    agentAllowlistCount: 1,
    legacyAdminAllowlistCount: 0,
  },
  vendors: {
    sendgrid: { configured: true, fromEmailConfigured: true },
    openai: { apiKeyConfigured: false },
  },
  secrets: { linkHmacKeyConfigured: true },
};

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: () => ({
      data: SYSTEM_INFO,
      isPending: false,
      isError: false,
      error: null,
    }),
  };
});

vi.mock("@/demo/DemoModeProvider", () => ({
  useDemoMode: () => ({
    isDemo: false,
    enterDemo: vi.fn(),
    exitDemo: vi.fn(),
  }),
}));

import { AdminSettingsPage, PlatformSystemInfoPage } from "./admin-settings";

afterEach(() => cleanup());

describe("PlatformSystemInfoPage — render regression", () => {
  it("renders backend-shaped system info without crashing (no encryption deref)", () => {
    expect(() => render(<PlatformSystemInfoPage />)).not.toThrow();
    expect(screen.getByTestId("platform-system-info-page")).toBeDefined();
  });

  it("surfaces the link HMAC key presence from `secrets` (not `encryption`)", () => {
    render(<PlatformSystemInfoPage />);
    expect(screen.getByText("Link HMAC key")).toBeDefined();
    expect(screen.getByText("✓ configured")).toBeDefined();
  });
});

describe("AdminSettingsPage — tenant settings", () => {
  it("renders the demo toggle and no deployment metadata", () => {
    render(<AdminSettingsPage />);
    expect(screen.getByTestId("admin-settings-page")).toBeDefined();
    expect(screen.getByLabelText("Toggle demo mode")).toBeDefined();
    // Deployment metadata moved to the platform console.
    expect(screen.queryByText("Link HMAC key")).toBeNull();
  });
});
