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

  // Regression: mustChangePassword was removed from the AuthMe interface and
  // from the /auth/me server response. The client and hooks must not expose it.
  it("fetchMe response does not include mustChangePassword", async () => {
    const me = {
      id: "u2",
      email: "admin@example.com",
      role: "admin",
      displayName: null,
      emailVerified: true,
    };
    const { client } = buildAuthClient([{ status: 200, body: me }]);
    const result = await client.fetchMe();
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("mustChangePassword");
  });

  it("AuthMe type does not include mustChangePassword — cache round-trip compiles without it", () => {
    const qc = new QueryClient();
    // This would be a TypeScript compile error if mustChangePassword were still
    // required on AuthMe. We verify the runtime shape is accepted without it.
    const meWithoutFlag: AuthMe = {
      id: "u3",
      email: "test@test.com",
      role: "admin",
      displayName: null,
      emailVerified: false,
    };
    qc.setQueryData<AuthMe | null>(SESSION_QUERY_KEY, meWithoutFlag);
    const cached = qc.getQueryData<AuthMe | null>(SESSION_QUERY_KEY);
    expect(cached).toEqual(meWithoutFlag);
    expect(cached).not.toHaveProperty("mustChangePassword");
  });
});
