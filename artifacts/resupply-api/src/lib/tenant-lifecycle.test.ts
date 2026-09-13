import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { createCentralAdminHandler } from "./central-admin";
import { createTenantLifecycleHandler } from "./tenant-lifecycle";
import { tenantLifecycleDomain as domain } from "./tenant-lifecycle-protocol";

const HUB = "11111111-1111-4111-8111-111111111111";
const NATIVE = "Native_admin-1";
const TARGET = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-12T01:00:00.000Z";
const ORIGIN = "https://breathe-fixture.example.test";
const operation = { domain, operation: "context", targetId: TARGET };
const target = {
  id: TARGET,
  slug: "fixture-tenant",
  name: null,
  updatedAt: null,
  status: "active",
  seedProtected: false,
  revision: "a".repeat(64),
};
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const env: Record<string, string> = {
    CAREMETRIC_ADMIN_ENABLED: "true",
    CAREMETRIC_ADMIN_TENANT_COMMANDS_ENABLED: "true",
    HUB_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: JSON.stringify({ [HUB]: NATIVE }),
  };
  const state = {
    proof: {
      user_id: HUB,
      role: "platform_admin",
      method: "sms",
      session_id: SESSION,
      session_started_at: NOW,
      assurance_expires_at: "2026-09-12T09:00:00.000Z",
      operation,
    } as Record<string, unknown>,
    authStatus: 200,
    role: "admin",
    status: "active",
    verified: NOW as string | null,
    member: true,
    nativeError: null as string | null,
    result: { target, requests: [] } as unknown,
    afterRpc: () => {},
    now: new Date(NOW),
    calls: [] as { path: string; body: unknown }[],
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    state.calls.push({
      path: url.pathname,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.origin === "https://support-hub-web-production.up.railway.app") {
      expect(url.pathname).toBe("/api/internal/command/breathe/authorize");
      expect(init.redirect).toBe("error");
      expect(init.method).toBe("POST");
      expect(init.body).toBe("{}");
      expect(headers.get("authorization")).toBe(`Bearer cmh_${"a".repeat(43)}`);
      expect(headers.get("apikey")).toBeNull();
      expect(headers.get("origin")).toBeNull();
      return Response.json(state.proof, { status: state.authStatus });
    }
    expect(url.origin).toBe(ORIGIN);
    expect(headers.get("apikey")).toBe("sb_secret_fixture");
    if (url.pathname.endsWith("/users")) {
      expect(headers.get("accept-profile")).toBe("resupply_auth");
      expect(url.searchParams.get("select")).toBe(
        "id,role,status,email_verified_at",
      );
      expect(url.searchParams.get("id")).toBe(`eq.${NATIVE}`);
      return Response.json([
        {
          id: NATIVE,
          role: state.role,
          status: state.status,
          email_verified_at: state.verified,
        },
      ]);
    }
    if (url.pathname.endsWith("/platform_admins")) {
      expect(url.searchParams.get("auth_user_id")).toBe(`eq.${NATIVE}`);
      return Response.json(state.member ? [{ auth_user_id: NATIVE }] : []);
    }
    expect(url.pathname).toBe("/rest/v1/rpc/tenant_lifecycle_command");
    expect(headers.get("content-profile")).toBe("resupply");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      p_actor: { ...state.proof, native_user_id: NATIVE },
      p_operation: state.proof.operation,
    });
    state.afterRpc();
    return state.nativeError
      ? Response.json(
          { code: state.nativeError, message: "PRIVATE" },
          { status: 400 },
        )
      : Response.json(state.result);
  });
  vi.stubGlobal("fetch", fetcher);
  const getClient = vi.fn(async () =>
    getSupabaseServiceRoleClient({
      url: ORIGIN,
      serviceRoleKey: "sb_secret_fixture",
    }),
  );
  const options = {
    getClient,
    getEnv: (name: string) => env[name],
    fetcher,
    now: () => state.now,
  };
  const handler = createTenantLifecycleHandler(options);
  const send = (
    body: unknown = operation,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ) =>
    handler(
      new Request(
        "https://cmbreathe.com/resupply-api/central-admin/tenant-lifecycle",
        {
          method: "POST",
          signal,
          headers: {
            Authorization: `Bearer cmh_${"a".repeat(43)}`,
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
        },
      ),
    );
  return { env, state, send, options, getClient, fetcher };
}

describe("tenant lifecycle current authorization and transport", () => {
  it("consumes the fixed exact SMS proof, preserves nullable native metadata and rechecks native authority", async () => {
    const f = fixture();
    const response = await f.send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      contractVersion: 1,
      product: "breathe",
      domain,
      operation: "context",
      generatedAt: NOW,
      data: f.state.result,
    });
    expect(f.state.calls.filter((x) => x.path.endsWith("/users"))).toHaveLength(
      2,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("compares closed parsed operation objects independently of input key order", async () => {
    const f = fixture();
    f.state.proof.operation = {
      targetId: TARGET,
      operation: "context",
      domain,
    };
    expect((await f.send()).status).toBe(200);
  });
  it.each([
    ["role", "agent"],
    ["status", "locked"],
    ["status", "revoked"],
    ["verified", null],
    ["member", false],
  ] as const)(
    "denies current native %s=%s before dispatch",
    async (key, value) => {
      const f = fixture();
      Object.assign(f.state, { [key]: value });
      expect((await f.send()).status).toBe(403);
      expect(f.state.calls.some((x) => x.path.includes("/rpc/"))).toBe(false);
    },
  );
  it.each(["member", "expiry"])(
    "withholds a result when %s changes after native commit",
    async (mode) => {
      const f = fixture();
      f.state.afterRpc = () => {
        if (mode === "member") f.state.member = false;
        else f.state.now = new Date("2026-09-12T09:00:00Z");
      };
      const response = await f.send();
      expect(response.status).toBe(mode === "member" ? 403 : 401);
      expect(await response.text()).not.toContain("revision");
    },
  );
  it.each([
    { extra: true },
    { role: "admin" },
    { method: "jwt" },
    { operation: { ...operation, targetId: HUB } },
    { operation: { ...operation, extra: true } },
    { session_started_at: "2026-09-11T16:00:00Z" },
    { assurance_expires_at: NOW },
    { session_id: "native-session" },
  ])("denies malformed, stale or misbound proof %#", async (change) => {
    const f = fixture();
    Object.assign(f.state.proof, change);
    const response = await f.send();
    expect([401, 403]).toContain(response.status);
    expect(f.getClient).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])(
    "does not expose failed issuer bodies (%s)",
    async (status) => {
      const f = fixture();
      f.state.authStatus = status;
      const response = await f.send();
      expect(response.status).toBe(status === 500 ? 503 : status);
      expect(await response.text()).not.toContain(HUB);
    },
  );
  it.each(["42501", "28000", "40001", "P0002", "55P03", "22023"])(
    "projects only safe native error %s",
    async (code) => {
      const f = fixture();
      f.state.nativeError = code;
      const response = await f.send();
      expect(response.status).toBe(
        {
          "42501": 403,
          "28000": 401,
          "40001": 409,
          P0002: 404,
          "55P03": 503,
          "22023": 400,
        }[code],
      );
      expect(await response.text()).not.toContain("PRIVATE");
    },
  );
  it("rejects extra private result fields", async () => {
    const f = fixture();
    f.state.result = {
      target: { ...target, password: "PRIVATE" },
      requests: [],
    };
    const response = await f.send();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PRIVATE");
  });
  it.each([
    { Origin: "https://cmbreathe.com" },
    { Cookie: "pf_session=x" },
    { Authorization: "Bearer fixture.jwt.token" },
  ] as Array<Record<string, string>>)(
    "refuses browser/native-session ingress %#",
    async (headers) => {
      const f = fixture();
      expect([401, 403]).toContain((await f.send(operation, headers)).status);
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized operations before consuming a ticket", async () => {
    const f = fixture();
    expect(
      (await f.send({ ...operation, padding: "a".repeat(16384) })).status,
    ).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("advertises commands only when the separate deployment flag is enabled", async () => {
    const f = fixture();
    f.state.proof = {
      user_id: HUB,
      role: "platform_admin",
      method: "sms",
      operation: { operation: "capabilities" },
    };
    // Reader has a different fixed issuer; use only its simple response fixture here.
    const read = createCentralAdminHandler({
      ...f.options,
      fetcher: vi.fn(async () => Response.json(f.state.proof)) as typeof fetch,
    });
    const request = () =>
      new Request("https://cmbreathe.com/resupply-api/central-admin/read", {
        method: "POST",
        headers: {
          Authorization: `Bearer cmh_${"a".repeat(43)}`,
          "Content-Type": "application/json",
        },
        body: '{"operation":"capabilities"}',
      });
    expect(await (await read(request())).json()).toMatchObject({
      data: {
        operations: expect.arrayContaining(["organizations.lifecycle.apply"]),
      },
    });
    delete f.env.CAREMETRIC_ADMIN_TENANT_COMMANDS_ENABLED;
    expect(await (await read(request())).json()).not.toMatchObject({
      data: {
        operations: expect.arrayContaining(["organizations.lifecycle.apply"]),
      },
    });
    expect((await f.send()).status).toBe(503);
  });
  it("cancels a stalled native-client acquisition without later dispatch", async () => {
    const f = fixture();
    let release!: (v: Awaited<ReturnType<typeof f.getClient>>) => void;
    const held = new Promise<Awaited<ReturnType<typeof f.getClient>>>(
      (resolve) => {
        release = resolve;
      },
    );
    const handler = createTenantLifecycleHandler({
      ...f.options,
      getClient: () => held,
    });
    const abort = new AbortController();
    const pending = handler(
      new Request(
        "https://cmbreathe.com/resupply-api/central-admin/tenant-lifecycle",
        {
          method: "POST",
          signal: abort.signal,
          headers: {
            Authorization: `Bearer cmh_${"a".repeat(43)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(operation),
        },
      ),
    );
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
    abort.abort();
    expect((await pending).status).toBe(503);
    release(await f.getClient());
    await Promise.resolve();
    expect(f.state.calls.some((x) => x.path.includes("/rpc/"))).toBe(false);
  });
});
