// @vitest-environment jsdom
//
// Provider portal chrome must brand as the platform (CareMetric Breathe),
// not a host-resolved tenant storefront — the portal is a cross-tenant
// surface authenticated against platform auth.

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const signOutMutate = vi.fn();
const getProviderOrgsMock = vi.fn();
const selectProviderOrgMock = vi.fn();
const isPlatformHomeHostMock = vi.fn(() => false);

vi.mock("@/lib/provider/provider-auth", () => ({
  providerAuthHooks: {
    useSignOut: () => ({ mutate: signOutMutate, isPending: false }),
  },
}));

vi.mock("@/lib/provider/provider-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/provider/provider-api")
  >("@/lib/provider/provider-api");
  return {
    ...actual,
    getProviderOrgs: (...args: unknown[]) => getProviderOrgsMock(...args),
    selectProviderOrg: (...args: unknown[]) => selectProviderOrgMock(...args),
  };
});

vi.mock("@/lib/platform-host", () => ({
  isPlatformHomeHost: () => isPlatformHomeHostMock(),
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
import {
  ProviderAuthLayout,
  ProviderShell,
  shouldShowProviderOrgSwitcher,
} from "./provider-ui";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

function renderShell(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  signOutMutate.mockReset();
  getProviderOrgsMock.mockReset();
  selectProviderOrgMock.mockReset();
  isPlatformHomeHostMock.mockReset();
  isPlatformHomeHostMock.mockReturnValue(false);
  cleanup();
});

describe("shouldShowProviderOrgSwitcher", () => {
  it("shows only on platform host with 2+ orgs", () => {
    expect(shouldShowProviderOrgSwitcher(true, 2)).toBe(true);
    expect(shouldShowProviderOrgSwitcher(true, 1)).toBe(false);
    expect(shouldShowProviderOrgSwitcher(false, 3)).toBe(false);
  });
});

describe("provider-ui — platform-branded chrome", () => {
  it("ProviderShell renders the platform name in the header", () => {
    renderShell(
      <ProviderShell providerName="Dr. Example">
        <p>Queue content</p>
      </ProviderShell>,
    );

    expect(screen.getByText("Provider Portal")).toBeTruthy();
    expect(screen.getByText(PLATFORM_NAME)).toBeTruthy();
    expect(screen.getByText("Dr. Example")).toBeTruthy();
    expect(screen.getByText("Queue content")).toBeTruthy();
  });

  it("hides the org switcher on a tenant host", async () => {
    isPlatformHomeHostMock.mockReturnValue(false);
    getProviderOrgsMock.mockResolvedValue({
      activeOrgId: ORG_A,
      orgs: [
        {
          orgId: ORG_A,
          dmeLinkId: "l1",
          name: "Penn",
          portalBaseUrl: null,
          portalUrl: null,
          hasVerifiedPortal: false,
          isActive: true,
        },
        {
          orgId: ORG_B,
          dmeLinkId: "l2",
          name: "Acme",
          portalBaseUrl: null,
          portalUrl: null,
          hasVerifiedPortal: false,
          isActive: false,
        },
      ],
    });

    renderShell(
      <ProviderShell>
        <p>x</p>
      </ProviderShell>,
    );

    expect(screen.queryByTestId("provider-org-switcher")).toBeNull();
    expect(getProviderOrgsMock).not.toHaveBeenCalled();
  });

  it("shows the org switcher on platform host with multiple memberships", async () => {
    isPlatformHomeHostMock.mockReturnValue(true);
    getProviderOrgsMock.mockResolvedValue({
      activeOrgId: ORG_A,
      orgs: [
        {
          orgId: ORG_A,
          dmeLinkId: "l1",
          name: "Penn Home Medical Supply",
          portalBaseUrl: null,
          portalUrl: null,
          hasVerifiedPortal: false,
          isActive: true,
        },
        {
          orgId: ORG_B,
          dmeLinkId: "l2",
          name: "Acme Sleep",
          portalBaseUrl: null,
          portalUrl: null,
          hasVerifiedPortal: false,
          isActive: false,
        },
      ],
    });
    selectProviderOrgMock.mockResolvedValue({ activeOrgId: ORG_B });

    renderShell(
      <ProviderShell>
        <p>x</p>
      </ProviderShell>,
    );

    const select = await screen.findByTestId("provider-org-switcher");
    expect((select as HTMLSelectElement).value).toBe(ORG_A);

    await fireEvent.change(select, { target: { value: ORG_B } });
    await waitFor(() => {
      expect(selectProviderOrgMock).toHaveBeenCalledWith(ORG_B);
    });
  });

  it("ProviderAuthLayout renders the platform name on sign-in chrome", () => {
    renderShell(
      <ProviderAuthLayout>
        <p>Sign in form</p>
      </ProviderAuthLayout>,
    );

    expect(screen.getByText("Provider Portal")).toBeTruthy();
    expect(screen.getByText(PLATFORM_NAME)).toBeTruthy();
    expect(screen.getByText("Sign in form")).toBeTruthy();
  });
});
