// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createAuthClient,
  createAuthHooks,
} from "@workspace/resupply-auth-react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("./auth-hooks", () => ({
  authClient: { signOut },
  authHooks: { useSession: () => ({ data: { id: "account-a" } }) },
  SESSION_QUERY_KEY: ["auth", "me", "storefront"],
}));
vi.mock("./admin/auth-hooks", () => ({
  authClient: { signOut },
  authHooks: { useSession: () => ({ data: { id: "account-a" } }) },
  SESSION_QUERY_KEY: ["auth", "me", "admin"],
}));

import { useDashboardIdentity } from "./admin/identity";
import { useShopIdentity } from "./identity";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("session changes during sign-in", () => {
  it.each(["password", "mfa"] as const)(
    "clears old account data after %s authentication",
    async (mode) => {
      const client = new QueryClient();
      client.setQueryData(["private-order-history"], ["account-a order"]);
      const hooks = createAuthHooks(
        createAuthClient({
          basePath: "/api/auth",
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify({ ok: true }), { status: 200 }),
          ),
        }),
      );
      const { result } = renderHook(
        () => ({
          password: hooks.useSignIn(),
          mfa: hooks.useVerifySignInMfa(),
        }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>
              {children}
            </QueryClientProvider>
          ),
        },
      );
      await act(async () => {
        if (mode === "password")
          await result.current.password.mutateAsync({
            email: "staff@example.test",
            password: "fixture",
          });
        else
          await result.current.mfa.mutateAsync({
            challengeToken: "fixture",
            code: "123456",
          });
      });
      expect(client.getQueryData(["private-order-history"])).toBeUndefined();
      client.clear();
    },
  );

  it("retains account data while MFA has not issued a new session", async () => {
    const client = new QueryClient();
    client.setQueryData(["private-order-history"], ["account-a order"]);
    const hooks = createAuthHooks(
      createAuthClient({
        basePath: "/api/auth",
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                ok: true,
                mfaRequired: true,
                challengeToken: "fixture",
              }),
              { status: 200 },
            ),
        ),
      }),
    );
    const { result } = renderHook(() => hooks.useSignIn(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await act(() =>
      result.current.mutateAsync({
        email: "staff@example.test",
        password: "fixture",
      }),
    );
    expect(client.getQueryData(["private-order-history"])).toEqual([
      "account-a order",
    ]);
    client.clear();
  });
});

describe.each([
  ["admin", useDashboardIdentity],
  ["storefront", useShopIdentity],
] as const)("%s sign-out", (_surface, useIdentity) => {
  function setup() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["patient-supply-overview", "patient-a"], {
      private: true,
    });
    client.setQueryData(["auth", "me", "admin"], { id: "account-a" });
    client.setQueryData(["auth", "me", "storefront"], { id: "account-a" });
    const hook = renderHook(() => useIdentity(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    return { client, ...hook };
  }

  it("removes private data and both cached identities after a successful sign-out", async () => {
    signOut.mockResolvedValue(undefined);
    const { client, result } = setup();
    await act(() => result.current.signOut());
    expect(
      client.getQueryData(["patient-supply-overview", "patient-a"]),
    ).toBeUndefined();
    expect(client.getQueryData(["auth", "me", "admin"])).toBeNull();
    expect(client.getQueryData(["auth", "me", "storefront"])).toBeNull();
    client.clear();
  });

  it("keeps the session visible and reports a failed sign-out", async () => {
    signOut.mockRejectedValue(new Error("offline"));
    const { client, result } = setup();
    await act(async () => {
      await expect(result.current.signOut()).rejects.toThrow("offline");
    });
    expect(client.getQueryData(["auth", "me", "admin"])).toEqual({
      id: "account-a",
    });
    client.clear();
  });

  it("prevents an old pending response from repopulating private data", async () => {
    signOut.mockResolvedValue(undefined);
    const { client, result } = setup();
    let resolveOld!: (value: string) => void;
    const pending = client
      .fetchQuery({
        queryKey: ["private-order-history"],
        queryFn: () =>
          new Promise<string>((resolve) => {
            resolveOld = resolve;
          }),
      })
      .catch(() => undefined);
    await act(() => result.current.signOut());
    resolveOld("account-a orders");
    await pending;
    expect(client.getQueryData(["private-order-history"])).toBeUndefined();
    client.clear();
  });
});
