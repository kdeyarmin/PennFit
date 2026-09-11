// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionMutationCache } from "@workspace/resupply-auth-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

const { sessionRead, providerRead, orgsRead, selectOrg } = vi.hoisted(() => ({
  sessionRead: vi.fn(),
  providerRead: vi.fn(),
  orgsRead: vi.fn(),
  selectOrg: vi.fn(),
}));
vi.mock("@/lib/provider/provider-auth", async () => {
  const { createAuthClient, createAuthHooks } =
    await import("@workspace/resupply-auth-react");
  return {
    providerAuthHooks: createAuthHooks(
      createAuthClient({
        basePath: "/api/provider/auth",
        fetch: async () => {
          const result = await sessionRead();
          return new Response(JSON.stringify(result), {
            status: result ? 200 : 401,
          });
        },
      }),
      { sessionQueryKey: ["auth", "me", "provider"] },
    ),
  };
});
vi.mock("@/lib/provider/provider-api", async () => ({
  ...(await vi.importActual("@/lib/provider/provider-api")),
  getProviderMe: providerRead,
  getProviderOrgs: orgsRead,
  selectProviderOrg: selectOrg,
}));
vi.mock("@/lib/platform-host", () => ({ isPlatformHomeHost: () => false }));
vi.mock("./provider-queue", async () => {
  const { useState } = await import("react");
  return {
    ProviderQueue: function Queue({ providerName }: { providerName: string }) {
      const [draft, setDraft] = useState("");
      return (
        <div>
          <p>{providerName}</p>
          <input
            aria-label="Private provider draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
      );
    },
  };
});
vi.mock("./provider-sign-in", () => ({
  ProviderSignIn: () => <div>Provider sign-in</div>,
}));
vi.mock("./provider-mfa-setup", () => ({
  ProviderMfaSetup: () => <div>Provider MFA setup</div>,
}));
import { ProviderPortalRoute } from "./ProviderPortalRoute";
import { ProviderApiError } from "@/lib/provider/provider-api";

const sessionKey = ["auth", "me", "provider"];
const session = (id: string) => ({
  id,
  role: "customer",
  email: `${id}@example.test`,
  displayName: id,
  emailVerified: true,
  mustChangePassword: false,
});
const provider = (id: string, mfaEnrolled = true) => ({
  account: {
    id: `portal-${id}`,
    email: `${id}@example.test`,
    status: "active",
    mfaEnrolled,
  },
  provider: {
    id: `provider-${id}`,
    npi: null,
    legalName: `Provider ${id}`,
    practiceName: null,
  },
  pendingCount: 0,
});
const clients: QueryClient[] = [];
function mount(configure?: (client: QueryClient) => void) {
  const client = new QueryClient({
    mutationCache: new SessionMutationCache(),
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  configure?.(client);
  const location = memoryLocation({ path: "/provider" });
  render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook}>
        <ProviderPortalRoute />
      </Router>
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  sessionRead.mockResolvedValue(session("a"));
  providerRead.mockResolvedValue(provider("a"));
  orgsRead.mockResolvedValue({ orgs: [], activeOrgId: null });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe("provider session boundaries", () => {
  it("waits for a cached-null session refresh before admitting a signed-in provider", async () => {
    let finish!: (value: unknown) => void;
    sessionRead.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount((client) => {
      client.setQueryData(sessionKey, null);
      void client.invalidateQueries({ queryKey: sessionKey });
    });
    expect(screen.getByText("Checking sign-in…")).toBeTruthy();
    expect(screen.queryByText("Provider sign-in")).toBeNull();
    expect(providerRead).not.toHaveBeenCalled();
    await act(async () => {
      finish(session("a"));
    });
    expect(await screen.findByText("Provider a")).toBeTruthy();
  });

  it("drops private forms and cached provider data when session refresh discovers another account", async () => {
    const client = mount();
    await screen.findByText("Provider a");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Account A private draft" },
    });
    client.setQueryData(
      ["provider", "private-history"],
      "Account A private history",
    );
    sessionRead.mockResolvedValue(session("b"));
    providerRead.mockResolvedValue(provider("b"));
    await act(() => client.refetchQueries({ queryKey: sessionKey }));
    expect(await screen.findByText("Provider b")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("Provider a")).toBeNull();
    expect(
      client.getQueryData(["provider", "private-history"]),
    ).toBeUndefined();
    expect(client.getQueryData(["provider", "me", "a"])).toBeUndefined();
    expect(client.getQueryData(["provider", "me", "b"])).toEqual(provider("b"));
  });

  it("removes the private view when the shared session expires", async () => {
    const client = mount();
    await screen.findByText("Provider a");
    sessionRead.mockResolvedValue(null);
    await act(() => client.refetchQueries({ queryKey: sessionKey }));
    expect(await screen.findByText("Provider sign-in")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps the mandatory MFA enrollment route working", async () => {
    providerRead.mockResolvedValue(provider("a", false));
    mount();
    expect(await screen.findByText("Provider MFA setup")).toBeTruthy();
    expect(screen.queryByText("Provider a")).toBeNull();
  });

  it("keeps a generic provider 403 distinct from the practice selector", async () => {
    providerRead.mockRejectedValue(
      new ProviderApiError(
        403,
        "provider_required",
        "Provider access required",
      ),
    );
    mount();
    expect(await screen.findByText("No portal access")).toBeTruthy();
    expect(orgsRead).not.toHaveBeenCalled();
  });

  it("can select a practice and resume the provider view", async () => {
    providerRead.mockRejectedValueOnce(
      new ProviderApiError(
        403,
        "provider_tenant_host_required",
        "Choose a practice",
      ),
    );
    orgsRead.mockResolvedValue({
      orgs: [
        {
          orgId: "org-a",
          dmeLinkId: "a",
          name: "Practice A",
          hasVerifiedPortal: false,
          portalUrl: null,
        },
        {
          orgId: "org-b",
          dmeLinkId: "b",
          name: "Practice B",
          hasVerifiedPortal: false,
          portalUrl: null,
        },
      ],
    });
    selectOrg.mockResolvedValue({ activeOrgId: "org-a" });
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open Practice A on this site",
      }),
    );
    expect(await screen.findByText("Provider a")).toBeTruthy();
    expect(selectOrg).toHaveBeenCalledWith("org-a");
  });

  it.each(["session", "provider"] as const)(
    "recovers from a temporary %s failure with Try again",
    async (failingRead) => {
      if (failingRead === "session")
        sessionRead.mockRejectedValueOnce(new Error("offline"));
      else
        providerRead.mockRejectedValueOnce(
          new ProviderApiError(503, "offline", "Unavailable"),
        );
      mount();
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Provider a")).toBeTruthy();
    },
  );
});
