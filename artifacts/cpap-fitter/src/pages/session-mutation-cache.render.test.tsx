// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearSessionCache } from "@workspace/resupply-auth-react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { updatePreference, completeFollowup, saveBrand, toggleFlag } =
  vi.hoisted(() => ({
    updatePreference: vi.fn(),
    completeFollowup: vi.fn(),
    saveBrand: vi.fn(),
    toggleFlag: vi.fn(),
  }));
vi.mock("@/lib/identity", () => ({
  SignedIn: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/contact", () => ({
  useCompanyContact: () => ({ name: "Test Company" }),
}));
vi.mock("@/components/company-contact", () => ({
  BrandName: () => "Test Company",
}));
vi.mock("@/hooks/use-document-title", () => ({
  useDocumentTitle: () => undefined,
}));
vi.mock("@/lib/me-billing-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/me-billing-api")>()),
  fetchBillingBalance: vi.fn(async () => ({
    totalOpenCents: 0,
    claimCount: 0,
    claims: [],
  })),
  fetchPatientStatements: vi.fn(async () => ({ statements: [] })),
  fetchClaims: vi.fn(async () => ({ claims: [] })),
  updateStatementPreference: updatePreference,
}));
vi.mock("@/lib/admin/patient-followups-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/admin/patient-followups-api")
  >()),
  completeAdminPatientFollowup: completeFollowup,
}));
vi.mock("@/lib/admin/storefront-branding-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/admin/storefront-branding-api")
  >()),
  saveStorefrontBranding: saveBrand,
}));
vi.mock("@/lib/admin/feature-flags-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin/feature-flags-api")>()),
  listFeatureFlagActivity: vi.fn(async () => ({ activity: [] })),
  toggleFeatureFlag: toggleFlag,
}));
vi.mock("@workspace/api-client-react/admin", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@workspace/api-client-react/admin")
  >()),
  useGetAdminMe: () => ({ data: { productScope: "full" } }),
}));

import { AccountBillingPage } from "./account-billing";
import { FollowupsTab } from "./admin/patient-detail/FollowupsTab";
import { AdminStorefrontBrandingPage } from "./admin/storefront-branding";
import { AdminControlCenterPage } from "./admin/admin-control-center";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function setup(element: ReactNode, key: readonly string[], initial: unknown) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(key, initial);
  const view = render(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
  return { client, view };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("late mutation callbacks across account changes", () => {
  it.each([false, true])(
    "statement preference success respects session change=%s",
    async (changed) => {
      const key = ["me-statement-preference"];
      const old = {
        statementDeliveryMethod: "email",
        email: "old@example.test",
        linked: true,
      };
      const saved = { ...old, statementDeliveryMethod: "mail" };
      const next = { ...old, email: "new@example.test" };
      const pending = deferred<typeof old>();
      updatePreference.mockReturnValue(pending.promise);
      const { client, view } = setup(<AccountBillingPage />, key, old);
      fireEvent.click(screen.getByTestId("billing-delivery-mail"));
      await waitFor(() => expect(updatePreference).toHaveBeenCalled());
      const mutation = client.getMutationCache().getAll()[0]!;
      view.unmount();
      if (changed) {
        await clearSessionCache(client);
        client.setQueryData(key, next);
      }
      await act(async () => pending.resolve(saved));
      await waitFor(() => expect(mutation.state.status).toBe("success"));
      expect(client.getQueryData(key)).toEqual(changed ? next : saved);
      client.clear();
    },
  );

  it.each([false, true])(
    "follow-up failure respects session change=%s",
    async (changed) => {
      const key = ["admin", "patients", "patient-a", "followups"];
      const old = {
        followups: [
          {
            id: "followup-a",
            body: "Private patient task",
            dueAt: "2026-09-12T12:00:00Z",
            completedAt: null,
            completedByEmail: null,
            createdByEmail: "old@example.test",
            createdAt: "2026-09-11T12:00:00Z",
          },
        ],
      };
      const next = { followups: [] };
      const pending = deferred<never>();
      completeFollowup.mockReturnValue(pending.promise);
      const { client, view } = setup(
        <FollowupsTab patientId="patient-a" />,
        key,
        old,
      );
      fireEvent.click(
        screen.getByTestId("patient-followups-complete-followup-a"),
      );
      await waitFor(() => expect(completeFollowup).toHaveBeenCalled());
      const mutation = client.getMutationCache().getAll()[0]!;
      view.unmount();
      if (changed) {
        await clearSessionCache(client);
        client.setQueryData(key, next);
      }
      const invalidation = vi.spyOn(client, "invalidateQueries");
      await act(async () => pending.reject(new Error("offline")));
      await waitFor(() => expect(mutation.state.status).toBe("error"));
      expect(client.getQueryData(key)).toEqual(changed ? next : old);
      if (changed) expect(invalidation).not.toHaveBeenCalled();
      else expect(invalidation).toHaveBeenCalled();
      client.clear();
    },
  );

  it("does not replace a new tenant's branding with a late save", async () => {
    const key = ["admin", "storefront-branding"];
    const old = {
      storefrontName: "Old Tenant",
      legalName: "Old Tenant",
      tagline: "",
      logoUrl: null,
      domain: {
        host: null,
        status: "none",
        verifiedAt: null,
        instructions: null,
      },
    };
    const next = { ...old, storefrontName: "New Tenant" };
    const pending = deferred<typeof old>();
    saveBrand.mockReturnValue(pending.promise);
    const { client, view } = setup(<AdminStorefrontBrandingPage />, key, old);
    fireEvent.click(screen.getByRole("button", { name: "Save identity" }));
    await waitFor(() => expect(saveBrand).toHaveBeenCalled());
    const mutation = client.getMutationCache().getAll()[0]!;
    view.unmount();
    await clearSessionCache(client);
    client.setQueryData(key, next);
    await act(async () => pending.resolve(old));
    await waitFor(() => expect(mutation.state.status).toBe("success"));
    expect(client.getQueryData(key)).toEqual(next);
    client.clear();
  });

  it("does not restore a prior tenant's flags after a late toggle failure", async () => {
    const key = ["admin-feature-flags"];
    const old = {
      flags: [
        {
          key: "resupply.test",
          enabled: false,
          description: "Test toggle",
          category: "resupply",
          updatedByEmail: null,
          updatedAt: "2026-09-11T12:00:00Z",
        },
      ],
    };
    const next = { flags: [] };
    const pending = deferred<never>();
    toggleFlag.mockReturnValue(pending.promise);
    const { client, view } = setup(<AdminControlCenterPage />, key, old);
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(toggleFlag).toHaveBeenCalled());
    const mutation = client.getMutationCache().getAll()[0]!;
    view.unmount();
    await clearSessionCache(client);
    client.setQueryData(key, next);
    const invalidation = vi.spyOn(client, "invalidateQueries");
    await act(async () => pending.reject(new Error("offline")));
    await waitFor(() => expect(mutation.state.status).toBe("error"));
    expect(client.getQueryData(key)).toEqual(next);
    expect(invalidation).not.toHaveBeenCalled();
    client.clear();
  });
});
