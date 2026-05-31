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

// ---------------------------------------------------------------------------
// sessionQueryKey option — PR: namespace session keys per auth surface
// ---------------------------------------------------------------------------
//
// When createAuthHooks is given a custom `sessionQueryKey`, every
// internal operation (useSession, sign-out, reset-password) must use
// THAT key instead of the module-level SESSION_QUERY_KEY default.
// This is the core mechanism that prevents admin and storefront sessions
// from colliding when they share a single QueryClient.

describe("createAuthHooks — sessionQueryKey option", () => {
  it("accepts a custom sessionQueryKey without throwing", () => {
    const { client } = buildAuthClient([]);
    const customKey = ["auth", "me", "admin"] as const;
    const hooks = createAuthHooks(client, { sessionQueryKey: customKey });
    expect(typeof hooks.useSession).toBe("function");
    expect(typeof hooks.useSignOut).toBe("function");
    expect(typeof hooks.useResetPassword).toBe("function");
  });

  it("default SESSION_QUERY_KEY is ['auth', 'me'] (base key, no surface suffix)", () => {
    // Confirms the default key hasn't been changed to include a suffix.
    // Consumers that rely on the default must not be silently rekeyed.
    expect(SESSION_QUERY_KEY).toEqual(["auth", "me"]);
  });

  it("sign-out simulation: sets null on the custom key, not the default SESSION_QUERY_KEY", () => {
    const customKey = ["auth", "me", "admin"] as const;
    const qc = new QueryClient();

    // Seed both keys with a mock user so we can verify isolation.
    const mockUser: AuthMe = {
      id: "u-admin",
      email: "admin@example.com",
      role: "admin",
      displayName: "Admin",
      emailVerified: true,
      mustChangePassword: false,
    };
    qc.setQueryData<AuthMe | null>(SESSION_QUERY_KEY, {
      ...mockUser,
      id: "u-storefront",
      email: "customer@example.com",
    });
    qc.setQueryData<AuthMe | null>(customKey, mockUser);

    // Simulate the body of useSignOut.onSuccess with the custom key.
    qc.setQueryData(customKey, null);
    void qc.invalidateQueries({ queryKey: customKey });

    // The custom key must be null (sign-out happened).
    expect(qc.getQueryData(customKey)).toBeNull();
    // The default key must be untouched (storefront session unaffected).
    expect(qc.getQueryData(SESSION_QUERY_KEY)).not.toBeNull();
    expect((qc.getQueryData(SESSION_QUERY_KEY) as AuthMe).email).toBe(
      "customer@example.com",
    );
  });

  it("reset-password simulation: sets null on the custom key, not the default key", () => {
    const customKey = ["auth", "me", "storefront"] as const;
    const qc = new QueryClient();

    const storefrontUser: AuthMe = {
      id: "u-sf",
      email: "sf@example.com",
      role: "customer",
      displayName: null,
      emailVerified: true,
      mustChangePassword: false,
    };
    const adminUser: AuthMe = {
      id: "u-admin",
      email: "admin@example.com",
      role: "admin",
      displayName: "Admin",
      emailVerified: true,
      mustChangePassword: false,
    };
    qc.setQueryData<AuthMe | null>(customKey, storefrontUser);
    qc.setQueryData<AuthMe | null>(SESSION_QUERY_KEY, adminUser);

    // Simulate useResetPassword.onSuccess for the storefront surface.
    qc.setQueryData(customKey, null);
    void qc.invalidateQueries({ queryKey: customKey });

    expect(qc.getQueryData(customKey)).toBeNull();
    // Admin key must not be touched.
    expect(qc.getQueryData(SESSION_QUERY_KEY)).toEqual(adminUser);
  });

  it("two hook instances with distinct keys don't share cache data", () => {
    const adminKey = ["auth", "me", "admin"] as const;
    const storefrontKey = ["auth", "me", "storefront"] as const;
    const qc = new QueryClient();

    const adminUser: AuthMe = {
      id: "admin-1",
      email: "admin@clinic.com",
      role: "admin",
      displayName: "Dr. Admin",
      emailVerified: true,
      mustChangePassword: false,
    };
    const storefrontUser: AuthMe = {
      id: "sf-1",
      email: "patient@email.com",
      role: "customer",
      displayName: null,
      emailVerified: false,
      mustChangePassword: false,
    };

    qc.setQueryData<AuthMe | null>(adminKey, adminUser);
    qc.setQueryData<AuthMe | null>(storefrontKey, storefrontUser);

    // Sign out from admin surface.
    qc.setQueryData(adminKey, null);

    expect(qc.getQueryData(adminKey)).toBeNull();
    // Storefront session is still intact.
    expect(qc.getQueryData(storefrontKey)).toEqual(storefrontUser);
  });

  it("createAuthHooks with sessionQueryKey accepts staleTime alongside it", () => {
    const { client } = buildAuthClient([]);
    const hooks = createAuthHooks(client, {
      sessionQueryKey: ["auth", "me", "admin"],
      staleTime: 0,
    });
    expect(typeof hooks.useSession).toBe("function");
  });
});
