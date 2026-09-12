// @vitest-environment jsdom
import { useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthMe } from "@workspace/resupply-auth-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMe, privateViewUnmounted } = vi.hoisted(() => ({
  fetchMe: vi.fn(),
  privateViewUnmounted: vi.fn(),
}));

vi.mock("@/lib/admin/auth-hooks", async () => {
  const { createAuthClient, createAuthHooks } = await vi.importActual<
    typeof import("@workspace/resupply-auth-react")
  >("@workspace/resupply-auth-react");
  return {
    authHooks: createAuthHooks(
      { ...createAuthClient({ basePath: "/resupply-api/auth" }), fetchMe },
      { sessionQueryKey: ["auth", "me", "admin"] },
    ),
  };
});
vi.mock("@workspace/api-client-react/admin", () => ({
  useGetAdminMe: () => ({
    data: {
      email: "operator@example.test",
      role: "admin",
      permissions: [],
      pendingAgreements: [],
    },
    isPending: false,
    isError: false,
  }),
  getGetAdminMeQueryKey: () => ["/resupply-api/me"],
  ApiError: class extends Error {},
}));
vi.mock("@/lib/lazy-with-retry", () => ({
  lazyWithRetry: () => () => null,
}));
vi.mock("@/pages/admin/dashboard", () => ({ DashboardPage: () => null }));
vi.mock("@/pages/admin/agreements-gate", () => ({
  AgreementsGate: () => null,
}));
vi.mock("@/pages/admin/not-found", () => ({ default: () => null }));
vi.mock("@/pages/admin/not-authorized", () => ({
  NotAuthorizedPage: () => null,
}));
vi.mock("wouter", async () => ({
  ...(await vi.importActual<typeof import("wouter")>("wouter")),
  Redirect: ({ to }: { to: string }) => <div data-testid="redirect">{to}</div>,
}));
vi.mock("@/components/admin/AppShell", () => ({
  // Represent private state held below the actual ConsoleRoute/AdminConsole
  // boundary without importing every routed page or the full navigation shell.
  AppShell: function PrivateView() {
    const [note, setNote] = useState("");
    useEffect(() => () => privateViewUnmounted(), []);
    return (
      <input
        aria-label="Private draft note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
    );
  },
}));

import { ConsoleRoute } from "./console";

const sessionKey = ["auth", "me", "admin"] as const;
const account = (id: string, role: AuthMe["role"] = "admin"): AuthMe => ({
  id,
  role,
  email: `${id}@example.test`,
  displayName: id,
  emailVerified: true,
  mustChangePassword: false,
});
const clients: QueryClient[] = [];
function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <ConsoleRoute />
    </QueryClientProvider>,
  );
}
function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(qc);
  return qc;
}
beforeEach(() => {
  vi.clearAllMocks();
  fetchMe.mockResolvedValue(account("a"));
  window.history.replaceState({}, "", "/admin");
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((qc) => qc.clear());
});

describe("actual admin console session gate", () => {
  it("waits for an invalidated cached-null session before redirecting", async () => {
    const qc = client();
    qc.setQueryData(sessionKey, null);
    await qc.invalidateQueries({ queryKey: sessionKey });
    let finish!: (me: AuthMe) => void;
    fetchMe.mockReturnValue(
      new Promise<AuthMe>((resolve) => {
        finish = resolve;
      }),
    );

    mount(qc);
    expect(screen.getByText("Checking sign-in…")).toBeTruthy();
    expect(screen.queryByTestId("redirect")).toBeNull();
    expect(screen.queryByLabelText("Private draft note")).toBeNull();
    expect(fetchMe).toHaveBeenCalledOnce();

    await act(async () => finish(account("b")));
    expect(await screen.findByLabelText("Private draft note")).toBeTruthy();
    expect(screen.queryByTestId("redirect")).toBeNull();
  });

  it.each([
    { change: "account", next: account("b") },
    { change: "role", next: account("a", "agent") },
  ])(
    "drops private local state when a confirmed $change changes",
    async ({ next }) => {
      const qc = client();
      qc.setQueryData(sessionKey, account("a"));
      mount(qc);
      fireEvent.change(screen.getByLabelText("Private draft note"), {
        target: { value: "Account A patient note" },
      });
      expect(
        (screen.getByLabelText("Private draft note") as HTMLInputElement).value,
      ).toBe("Account A patient note");

      // The next identity is already confirmed and cached. There need not be a
      // null/loading render between accounts, so the actual gate must remount
      // its private subtree when the identity changes.
      act(() => qc.setQueryData(sessionKey, next));
      await waitFor(() => expect(privateViewUnmounted).toHaveBeenCalledOnce());
      expect(
        (screen.getByLabelText("Private draft note") as HTMLInputElement).value,
      ).toBe("");
      expect(screen.queryByTestId("redirect")).toBeNull();
    },
  );

  it("keeps a draft when the same confirmed identity refreshes", async () => {
    const qc = client();
    qc.setQueryData(sessionKey, account("a"));
    mount(qc);
    fireEvent.change(screen.getByLabelText("Private draft note"), {
      target: { value: "Current account draft" },
    });
    await act(async () => {
      qc.setQueryData(sessionKey, {
        ...account("a"),
        displayName: "Updated name",
      });
    });
    expect(
      (screen.getByLabelText("Private draft note") as HTMLInputElement).value,
    ).toBe("Current account draft");
    expect(privateViewUnmounted).not.toHaveBeenCalled();
  });
});
