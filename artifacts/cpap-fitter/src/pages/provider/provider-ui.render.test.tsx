// @vitest-environment jsdom
//
// Provider portal chrome must brand as the platform (CareMetric Breathe),
// not a host-resolved tenant storefront — the portal is a cross-tenant
// surface authenticated against platform auth.

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const signOutMutate = vi.fn();

vi.mock("@/lib/provider/provider-auth", () => ({
  providerAuthHooks: {
    useSignOut: () => ({ mutate: signOutMutate, isPending: false }),
  },
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useLocation: () => ["/provider", vi.fn()] as const,
    Link: ({ href, children }: { href: string; children: ReactNode }) => (
      <a href={href}>{children}</a>
    ),
  };
});

import { PLATFORM_NAME } from "@/lib/branding";
import { ProviderAuthLayout, ProviderShell } from "./provider-ui";

beforeEach(() => {
  signOutMutate.mockReset();
  cleanup();
});

describe("provider-ui — platform-branded chrome", () => {
  it("ProviderShell renders the platform name in the header", () => {
    render(
      <ProviderShell providerName="Dr. Example">
        <p>Queue content</p>
      </ProviderShell>,
    );

    expect(screen.getByText("Provider Portal")).toBeTruthy();
    expect(screen.getByText(PLATFORM_NAME)).toBeTruthy();
    expect(screen.getByText("Dr. Example")).toBeTruthy();
    expect(screen.getByText("Queue content")).toBeTruthy();
  });

  it("ProviderAuthLayout renders the platform name on sign-in chrome", () => {
    render(
      <ProviderAuthLayout>
        <p>Sign in form</p>
      </ProviderAuthLayout>,
    );

    expect(screen.getByText("Provider Portal")).toBeTruthy();
    expect(screen.getByText(PLATFORM_NAME)).toBeTruthy();
    expect(screen.getByText("Sign in form")).toBeTruthy();
  });
});
