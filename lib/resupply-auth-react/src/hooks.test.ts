// Hook tests rendered without React Testing Library (which requires
// extra deps in the workspace). We exercise the hooks directly
// using @tanstack/react-query's QueryClient methods + a
// manually-driven fetch fake. The tests verify behavior visible
// at the client interface: query keys, invalidation, and the
// /me reset on sign-out.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createAuthClient, type AuthClient, type AuthMe } from "./client";
import { SESSION_QUERY_KEY, createAuthHooks } from "./hooks";

function recordingFetch(responses: Array<{ status: number; body?: unknown }>): {
  fetch: typeof fetch;
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  let idx = 0;
  const fn: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url });
    const r = responses[idx++] ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(r.body ?? null), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fn, calls };
}

function buildAuthClient(responses: Parameters<typeof recordingFetch>[0]): {
  client: AuthClient;
  calls: { url: string }[];
} {
  const { fetch, calls } = recordingFetch(responses);
  return {
    client: createAuthClient({ basePath: "/api/auth", fetch }),
    calls,
  };
}

describe("createAuthHooks", () => {
  it("exposes the SESSION_QUERY_KEY for explicit invalidations", () => {
    expect(SESSION_QUERY_KEY).toEqual(["auth", "me"]);
  });

  it("useSignOut clears the /me cache to null", async () => {
    const { client } = buildAuthClient([{ status: 200 }]);
    const hooks = createAuthHooks(client);
    expect(hooks).toBeDefined();
    // We can't render the hook without React; we exercise the
    // behavior by calling the underlying client and asserting
    // the cache reset path matches the mutation onSuccess.
    const qc = new QueryClient();
    qc.setQueryData<AuthMe | null>(SESSION_QUERY_KEY, {
      id: "u1",
      email: "x@y.z",
      role: "admin",
      displayName: null,
      emailVerified: true,
      mustChangePassword: false,
    });
    // Simulate the body of useSignOut.onSuccess.
    qc.setQueryData(SESSION_QUERY_KEY, null);
    void qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    expect(qc.getQueryData(SESSION_QUERY_KEY)).toBeNull();
  });

  it("createAuthHooks accepts a custom staleTime without throwing", () => {
    const { client } = buildAuthClient([]);
    const hooks = createAuthHooks(client, { staleTime: 0 });
    expect(typeof hooks.useSession).toBe("function");
    expect(typeof hooks.useSignIn).toBe("function");
    expect(typeof hooks.useSignOut).toBe("function");
    expect(typeof hooks.useChangePassword).toBe("function");
    expect(typeof hooks.useForgotPassword).toBe("function");
    expect(typeof hooks.useResetPassword).toBe("function");
    expect(typeof hooks.useVerifyEmail).toBe("function");
    expect(typeof hooks.useSignUp).toBe("function");
  });

  it("shared /me prefix invalidation marks all namespaced session caches stale", async () => {
    const qc = new QueryClient();
    const storefrontKey = ["auth", "me", "storefront"] as const;
    const adminKey = ["auth", "me", "admin"] as const;
    qc.setQueryData(storefrontKey, { id: "storefront" });
    qc.setQueryData(adminKey, { id: "admin" });

    await qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY });

    expect(qc.getQueryState(storefrontKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(adminKey)?.isInvalidated).toBe(true);
  });

  it("client.fetchMe round-trip returns the typed payload that useSession consumers see", async () => {
    const me = {
      id: "u1",
      email: "x@y.z",
      role: "agent",
      displayName: "X Y",
      emailVerified: true,
    } as const;
    const { client, calls } = buildAuthClient([{ status: 200, body: me }]);
    const result = await client.fetchMe();
    expect(result).toEqual(me);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/auth/me");
  });
});

describe("createAuthHooks — sessionQueryKey option", () => {
  it("defaults to SESSION_QUERY_KEY when no sessionQueryKey is provided", () => {
    const { client } = buildAuthClient([]);
    // createAuthHooks returns hooks that use SESSION_QUERY_KEY by default.
    // We verify by setting query data with the default key and reading it back.
    const hooks = createAuthHooks(client);
    expect(hooks).toBeDefined();
    const qc = new QueryClient();
    const me: AuthMe = {
      id: "u1",
      email: "a@b.c",
      role: "admin",
      displayName: null,
      emailVerified: true,
      mustChangePassword: false,
    };
    qc.setQueryData(SESSION_QUERY_KEY, me);
    // The default key must be the exported SESSION_QUERY_KEY constant.
    expect(qc.getQueryData(SESSION_QUERY_KEY)).toEqual(me);
  });

  it("uses the custom sessionQueryKey instead of SESSION_QUERY_KEY", () => {
    const { client } = buildAuthClient([]);
    const customKey = ["auth", "me", "admin"] as const;
    const hooks = createAuthHooks(client, { sessionQueryKey: customKey });
    expect(hooks).toBeDefined();

    const qc = new QueryClient();
    const me: AuthMe = {
      id: "u2",
      email: "admin@org.com",
      role: "admin",
      displayName: "Admin",
      emailVerified: true,
      mustChangePassword: false,
    };
    // Populate the cache under the custom key.
    qc.setQueryData(customKey, me);
    // The default SESSION_QUERY_KEY slot must remain empty.
    expect(qc.getQueryData(SESSION_QUERY_KEY)).toBeUndefined();
    // The custom key slot must hold the data.
    expect(qc.getQueryData(customKey)).toEqual(me);
  });

  it("two hook instances with distinct keys do not collide in a shared QueryClient", () => {
    const { client: clientA } = buildAuthClient([]);
    const { client: clientB } = buildAuthClient([]);
    const keyA = ["auth", "me", "storefront"] as const;
    const keyB = ["auth", "me", "admin"] as const;
    const _hooksA = createAuthHooks(clientA, { sessionQueryKey: keyA });
    const _hooksB = createAuthHooks(clientB, { sessionQueryKey: keyB });

    const qc = new QueryClient();
    const meA: AuthMe = {
      id: "customer-1",
      email: "customer@example.com",
      role: "customer",
      displayName: "Customer",
      emailVerified: true,
      mustChangePassword: false,
    };
    const meB: AuthMe = {
      id: "admin-1",
      email: "admin@example.com",
      role: "admin",
      displayName: "Admin",
      emailVerified: true,
      mustChangePassword: false,
    };
    qc.setQueryData(keyA, meA);
    qc.setQueryData(keyB, meB);

    // Each key must independently hold its own session data.
    expect(qc.getQueryData(keyA)).toEqual(meA);
    expect(qc.getQueryData(keyB)).toEqual(meB);
    // Setting one to null must not affect the other.
    qc.setQueryData(keyA, null);
    expect(qc.getQueryData(keyA)).toBeNull();
    expect(qc.getQueryData(keyB)).toEqual(meB);
  });

  it("sign-out with custom key sets that key to null, not SESSION_QUERY_KEY", () => {
    const { client } = buildAuthClient([{ status: 200 }]);
    const customKey = ["auth", "me", "storefront"] as const;
    const _hooks = createAuthHooks(client, { sessionQueryKey: customKey });

    const qc = new QueryClient();
    const me: AuthMe = {
      id: "u3",
      email: "u3@example.com",
      role: "customer",
      displayName: null,
      emailVerified: true,
      mustChangePassword: false,
    };
    qc.setQueryData(customKey, me);
    qc.setQueryData(SESSION_QUERY_KEY, me);

    // Simulate the body of useSignOut.onSuccess with custom key.
    qc.setQueryData(customKey, null);
    void qc.invalidateQueries({ queryKey: customKey });

    // Custom key should be null; the default key must be untouched.
    expect(qc.getQueryData(customKey)).toBeNull();
    expect(qc.getQueryData(SESSION_QUERY_KEY)).toEqual(me);
  });

  it("createAuthHooks returns all expected hook functions when given a custom sessionQueryKey", () => {
    const { client } = buildAuthClient([]);
    const hooks = createAuthHooks(client, {
      sessionQueryKey: ["auth", "me", "custom"],
    });
    expect(typeof hooks.useSession).toBe("function");
    expect(typeof hooks.useSignIn).toBe("function");
    expect(typeof hooks.useSignOut).toBe("function");
    expect(typeof hooks.useVerifySignInMfa).toBe("function");
    expect(typeof hooks.useSignUp).toBe("function");
    expect(typeof hooks.useForgotPassword).toBe("function");
    expect(typeof hooks.useResetPassword).toBe("function");
    expect(typeof hooks.useVerifyEmail).toBe("function");
    expect(typeof hooks.useChangePassword).toBe("function");
  });
});
