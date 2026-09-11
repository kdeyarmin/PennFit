import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createCentralAdminHandler,
  readCentralAdminConfig,
} from "./central-admin";

const HUB = "https://xgauehtwksmnoqhgqegm.supabase.co";
const NATIVE = "https://breathe-fixture.example.test";
const HUB_ID = "11111111-1111-4111-8111-111111111111";
const NATIVE_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const SUB_ID = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-09-11T18:00:00.000Z";
const TOKEN = "Bearer fixture.jwt.token";
const PUB = "sb_publishable_fixture";
const SECRET = "sb_secret_fixture";
const ENV: Record<string, string> = {
  CAREMETRIC_ADMIN_ENABLED: "true",
  HUB_SUPABASE_PUBLISHABLE_KEY: PUB,
  CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: JSON.stringify({ [HUB_ID]: NATIVE_ID }),
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
};

afterEach(() => vi.unstubAllGlobals());

function fixture(nativeId = NATIVE_ID) {
  const env: Record<string, string> = {
    ...ENV,
    CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: JSON.stringify({ [HUB_ID]: nativeId }),
  };
  const state = {
    actor: { user_id: HUB_ID, role: "platform_admin", aal: "aal2" } as Record<
      string,
      unknown
    >,
    actorStatus: 200,
    nativeError: false,
    countsUnavailable: false,
    subscriptionCount: 10,
    user: {
      id: nativeId,
      role: "admin",
      status: "active",
      email_verified_at: NOW,
    },
    membership: { auth_user_id: nativeId } as { auth_user_id: string } | null,
    supportUsers: [
      {
        id: nativeId,
        role: "agent",
        status: "active",
        email_verified_at: NOW,
        updated_at: NOW,
      },
    ],
    supportLinks: [
      {
        id: SUB_ID,
        auth_user_id: nativeId,
        org_id: ORG_ID,
        role: "csr",
        status: "active",
        revoked_at: null as string | null,
        updated_at: NOW,
      },
    ],
    supportAccounts: [{ id: ORG_ID, status: "active", updated_at: NOW }],
    organizations: [
      {
        id: ORG_ID,
        name: "Fixture organization",
        slug: "fixture",
        status: "active",
        created_at: NOW,
        private: "MUST_NOT_LEAK",
      },
    ],
    staff: [
      {
        id: nativeId,
        email_lower: "operator@example.test",
        display_name: "Operator",
        role: "admin",
        status: "active",
        created_at: NOW,
        password_hash: "MUST_NOT_LEAK",
      },
    ],
    subscriptions: [
      {
        id: SUB_ID,
        org_id: ORG_ID,
        status: "active",
        stripe_status: "active",
        stripe_customer_id: "cus_fixture",
        stripe_subscription_id: "sub_fixture",
        current_period_end: NOW,
        updated_at: NOW,
        organizations: { name: "Fixture organization" },
        billing_plans: { code: "basic", name: "Basic" },
        notes: "MUST_NOT_LEAK",
        payment_method: "MUST_NOT_LEAK",
      },
    ],
  };
  const calls: Array<{ url: URL; headers: Headers; method: string }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    calls.push({ url, headers, method });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.origin === "https://support-hub-web-production.up.railway.app") {
      expect(url.pathname).toBe("/api/internal/admin/breathe/authorize");
      expect(headers.get("apikey")).toBeNull();
      expect(headers.get("origin")).toBeNull();
      expect(headers.get("authorization")).toMatch(
        /^Bearer cmh_[A-Za-z0-9_-]{43}$/,
      );
      expect(init.redirect).toBe("error");
      return Response.json(state.actor, { status: state.actorStatus });
    }
    if (url.origin === HUB) {
      expect(url.pathname).toBe("/rest/v1/rpc/authorize_platform_admin");
      expect(headers.get("apikey")).toBe(PUB);
      expect(headers.get("authorization")).toBe(TOKEN);
      expect(headers.get("content-profile")).toBe("hub");
      expect(init.redirect).toBe("error");
      return Response.json(
        state.actorStatus === 200
          ? state.actor
          : { code: "42501", details: "MUST_NOT_LEAK" },
        { status: state.actorStatus },
      );
    }
    expect(url.origin).toBe(NATIVE);
    expect(headers.get("apikey")).toBe(SECRET);
    expect(headers.get("authorization")).not.toBe(TOKEN);
    if (state.nativeError)
      return Response.json({ message: "MUST_NOT_LEAK" }, { status: 500 });
    const table = url.pathname.slice("/rest/v1/".length);
    const schema = headers.get("accept-profile");
    if (table === "admin_users") {
      expect(schema).toBe("resupply");
      expect(url.searchParams.get("auth_user_id")).toBe(`eq.${nativeId}`);
      expect(url.searchParams.get("org_id")).toBe(`eq.${ORG_ID}`);
      expect(url.searchParams.get("select")).toBe(
        "id,auth_user_id,org_id,role,status,revoked_at,updated_at",
      );
      expect(url.searchParams.get("limit")).toBe("2");
      return Response.json(state.supportLinks);
    }
    if (
      table === "users" &&
      url.searchParams.get("select") ===
        "id,role,status,email_verified_at,updated_at"
    ) {
      expect(schema).toBe("resupply_auth");
      expect(url.searchParams.get("id")).toBe(`eq.${nativeId}`);
      expect(url.searchParams.get("limit")).toBe("2");
      return Response.json(state.supportUsers);
    }
    if (
      table === "organizations" &&
      url.searchParams.get("select") === "id,status,updated_at"
    ) {
      expect(schema).toBe("resupply");
      expect(url.searchParams.get("id")).toBe(`eq.${ORG_ID}`);
      expect(url.searchParams.get("limit")).toBe("2");
      return Response.json(state.supportAccounts);
    }
    if (table === "platform_admins") {
      expect(schema).toBe("resupply");
      expect(url.searchParams.get("auth_user_id")).toBe(`eq.${nativeId}`);
      expect(url.searchParams.get("select")).toBe("auth_user_id");
      return Response.json(state.membership ? [state.membership] : []);
    }
    if (table === "users") expect(schema).toBe("resupply_auth");
    else expect(schema).toBe("resupply");
    if (table === "users" && url.searchParams.has("id")) {
      expect(url.searchParams.get("id")).toBe(`eq.${nativeId}`);
      expect(url.searchParams.get("select")).toBe(
        "id,role,status,email_verified_at",
      );
      return Response.json([state.user]);
    }
    if (method === "HEAD") {
      expect(url.searchParams.get("select")).toBe("id");
      if (table === "users") {
        expect(url.searchParams.get("role")).toBe("in.(admin,agent)");
        expect(url.searchParams.get("status")).toBe("eq.active");
      }
      const statusCounts: Record<string, number> = {
        "eq.active": 4,
        "eq.trialing": 2,
        "eq.past_due": 1,
        "eq.canceled": 3,
      };
      const total =
        table === "organizations"
          ? 5
          : table === "users"
            ? 9
            : url.searchParams.has("status")
              ? statusCounts[url.searchParams.get("status")!]
              : state.subscriptionCount;
      return new Response(null, {
        status: 200,
        headers: state.countsUnavailable
          ? {}
          : { "Content-Range": `0-0/${total}` },
      });
    }
    let data: unknown[];
    if (table === "organizations") {
      expect(url.searchParams.get("select")).toBe(
        "id,name,slug,status,created_at",
      );
      data = state.organizations;
    } else if (table === "users") {
      expect(url.searchParams.get("role")).toBe("in.(admin,agent)");
      expect(url.searchParams.get("select")).toBe(
        "id,email_lower,display_name,role,status,created_at",
      );
      data = state.staff;
    } else {
      expect(table).toBe("tenant_billing_subscriptions");
      expect(url.searchParams.get("select")).toBe(
        "id,org_id,status,stripe_status,stripe_customer_id,stripe_subscription_id,current_period_end,updated_at,organizations(name),billing_plans(code,name)",
      );
      data = state.subscriptions;
    }
    return Response.json(data, { headers: { "Content-Range": "0-0/1" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const getClient = vi.fn(async () =>
    getSupabaseServiceRoleClient({ url: NATIVE, serviceRoleKey: SECRET }),
  );
  const options = {
    getEnv: (name: string) => env[name],
    getClient,
    fetcher,
    now: () => new Date(NOW),
  };
  const handler = createCentralAdminHandler(options);
  const read = async (
    body: unknown = { operation: "overview" },
    extra: RequestInit = {},
  ) => {
    const response = await handler(
      new Request("https://cmbreathe.com/resupply-api/central-admin/read", {
        method: "POST",
        headers: { Authorization: TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...extra,
      }),
    );
    const payload = (await response.json()) as Record<string, unknown> & {
      data: Record<string, unknown>;
    };
    expect(JSON.stringify(payload)).not.toMatch(
      /MUST_NOT_LEAK|sb_secret_fixture|password_hash|payment_method/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    return { status: response.status, payload };
  };
  return { options, state, env, calls, getClient, read, fetcher };
}

describe("Breathe protected support account resolution", () => {
  const legacy = "CasePreserved_NativeUser";
  const op = {
    operation: "support.identity.resolve",
    sourceUserId: legacy,
    sourceAccountId: ORG_ID,
  };
  const headers = {
    Authorization: "Bearer cmh_" + "a".repeat(43),
    "Content-Type": "application/json",
  };
  const setup = () => {
    const f = fixture(legacy);
    f.state.actor = {
      user_id: HUB_ID,
      role: "platform_admin",
      method: "sms",
      operation: op,
    };
    return f;
  };
  it("resolves verified staff through protected organization membership, preserving native case", async () => {
    const f = setup(),
      result = await f.read(op, { headers });
    expect(result.status).toBe(200);
    expect(result.payload.data).toEqual({
      product: "breathe",
      sourceUserId: legacy,
      sourceAccountId: ORG_ID,
      accountKind: "organization",
      relationship: "organization_member",
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const before = result.payload.data.revision;
    f.state.supportLinks[0].updated_at = "2026-09-11T19:00:00Z";
    expect((await f.read(op, { headers })).payload.data.revision).not.toBe(
      before,
    );
  });
  it.each([
    "inactive-user",
    "unverified-user",
    "patient",
    "revoked-membership",
    "wrong-org",
    "suspended-org",
    "missing-member",
    "duplicate-member",
  ])("rejects %s", async (change) => {
    const f = setup();
    if (change === "inactive-user")
      f.state.supportUsers[0].status = "suspended";
    if (change === "unverified-user")
      f.state.supportUsers[0].email_verified_at = "";
    if (change === "patient") f.state.supportUsers[0].role = "patient";
    if (change === "revoked-membership")
      f.state.supportLinks[0].revoked_at = NOW;
    if (change === "wrong-org") f.state.supportLinks[0].org_id = SUB_ID;
    if (change === "suspended-org")
      f.state.supportAccounts[0].status = "suspended";
    if (change === "missing-member") f.state.supportLinks = [];
    if (change === "duplicate-member")
      f.state.supportLinks.push({ ...f.state.supportLinks[0], id: ORG_ID });
    expect((await f.read(op, { headers })).status).toBe(403);
  });
  it("does not admit legacy JWTs to customer onboarding", async () => {
    const f = fixture(legacy);
    expect((await f.read(op)).status).toBe(401);
  });
});

describe("central Hub to Breathe native adapter", () => {
  it("accepts operation-bound SMS delegation while preserving native membership checks", async () => {
    const f = fixture("user_LegacyABC123");
    f.state.actor = {
      user_id: HUB_ID,
      role: "platform_admin",
      method: "sms",
      operation: { operation: "capabilities" },
    };
    const headers = {
      Authorization: "Bearer cmh_" + "a".repeat(43),
      "Content-Type": "application/json",
    };
    expect(
      (await f.read({ operation: "capabilities" }, { headers })).status,
    ).toBe(200);
    expect(f.calls.some((call) => call.url.origin === HUB)).toBe(false);
    f.state.membership = null;
    expect(
      (await f.read({ operation: "capabilities" }, { headers })).status,
    ).toBe(403);
  });
  it("denies altered operations, methods, identities and expired SMS delegations", async () => {
    const headers = {
      Authorization: "Bearer cmh_" + "a".repeat(43),
      "Content-Type": "application/json",
    };
    for (const extra of [
      { method: "email" },
      { user_id: ORG_ID },
      { role: "agent" },
      { operation: { operation: "overview" } },
      { operation: { operation: "capabilities", organizationId: ORG_ID } },
    ]) {
      const f = fixture();
      f.state.actor = {
        user_id: HUB_ID,
        role: "platform_admin",
        method: "sms",
        operation: { operation: "capabilities" },
        ...extra,
      };
      expect(
        (await f.read({ operation: "capabilities" }, { headers })).status,
      ).toBe(403);
      expect(f.getClient).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.state.actorStatus = 401;
    expect(
      (await f.read({ operation: "capabilities" }, { headers })).status,
    ).toBe(401);
  });
  it("preserves validated opaque native IDs while keeping Hub identities UUID-only", async () => {
    const f = fixture("user_LegacyABC123");
    expect((await f.read({ operation: "capabilities" })).status).toBe(200);
    expect(
      (await f.read({ operation: "users.list" })).payload.data.items,
    ).toMatchObject([{ id: "user_LegacyABC123" }]);
    const bad: Record<string, string> = {
      ...ENV,
      CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: JSON.stringify({
        [HUB_ID]: "unsafe/id",
      }),
    };
    expect(() => readCentralAdminConfig((key) => bad[key])).toThrow();
  });
  it("stays off by default and rejects invalid configuration without touching a database", async () => {
    expect(readCentralAdminConfig(() => undefined)).toEqual({ enabled: false });
    for (const override of [
      { CAREMETRIC_ADMIN_ENABLED: "yes" },
      { HUB_SUPABASE_PUBLISHABLE_KEY: SECRET },
      { CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: "{}" },
      { CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: "[]" },
      {
        CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: JSON.stringify({
          "operator@example.test": NATIVE_ID,
        }),
      },
      {
        CAREMETRIC_ADMIN_IDENTITY_MAP_JSON: JSON.stringify({
          [HUB_ID]: NATIVE_ID,
          [ORG_ID]: NATIVE_ID,
        }),
      },
    ]) {
      const configEnv: Record<string, string | undefined> = {
        ...ENV,
        ...override,
      };
      expect(() => readCentralAdminConfig((key) => configEnv[key])).toThrow();
    }
    const f = fixture();
    f.env.CAREMETRIC_ADMIN_ENABLED = "false";
    expect((await f.read()).status).toBe(503);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.getClient).not.toHaveBeenCalled();
  });

  it("reports capabilities only after both live authorization checks and exposes a safe deployed revision", async () => {
    const f = fixture();
    const { status, payload } = await f.read({ operation: "capabilities" });
    expect(status).toBe(200);
    expect(payload).toEqual({
      contractVersion: 1,
      product: "breathe",
      operation: "capabilities",
      generatedAt: NOW,
      data: {
        apiVersion: 1,
        operations: [
          "capabilities",
          "overview",
          "organizations.list",
          "users.list",
          "billing.overview",
          "billing.subscriptions.list",
          "support.identity.resolve",
        ],
        sourceRevision: "a".repeat(40),
      },
    });
    f.env.RAILWAY_GIT_COMMIT_SHA = "unsafe-value";
    expect(
      (await f.read({ operation: "capabilities" })).payload.data.sourceRevision,
    ).toBeNull();
  });

  it("returns exact organization, active staff, and SaaS subscription counts without customer identities", async () => {
    const f = fixture();
    expect((await f.read()).payload.data).toEqual({
      organizationCount: 5,
      activeUserCount: 9,
      subscriptionCount: 10,
    });
    expect(f.calls.filter((call) => call.method === "HEAD")).toHaveLength(3);
    f.state.countsUnavailable = true;
    expect(await f.read()).toMatchObject({
      status: 503,
      payload: { error: { code: "upstream" } },
    });
  });

  it.each([401, 403, 500])(
    "denies Hub verification HTTP %s before native lookup",
    async (status) => {
      const f = fixture();
      f.state.actorStatus = status;
      expect((await f.read()).status).toBe(status === 500 ? 503 : status);
      expect(f.getClient).not.toHaveBeenCalled();
    },
  );

  it.each(["role", "aal", "user_id"])(
    "denies an invalid Hub actor %s",
    async (field) => {
      const f = fixture();
      Object.assign(f.state.actor, { [field]: "invalid" });
      expect((await f.read()).status).toBe(403);
      expect(f.getClient).not.toHaveBeenCalled();
    },
  );

  it("honors mapping removal and native revocation on the next request", async () => {
    const f = fixture();
    expect((await f.read()).status).toBe(200);
    const count = f.calls.filter((call) => call.method === "HEAD").length;
    f.state.membership = null;
    expect((await f.read()).status).toBe(403);
    expect(f.calls.filter((call) => call.method === "HEAD")).toHaveLength(
      count,
    );
    f.env.CAREMETRIC_ADMIN_IDENTITY_MAP_JSON = JSON.stringify({
      [ORG_ID]: NATIVE_ID,
    });
    f.getClient.mockClear();
    expect((await f.read()).status).toBe(403);
    expect(f.getClient).not.toHaveBeenCalled();
  });

  it.each([
    { role: "customer" },
    { role: "agent" },
    { status: "locked" },
    { status: "revoked" },
    { status: "invited" },
    { email_verified_at: "invalid" },
  ])("denies native account state %j", async (override) => {
    const f = fixture();
    Object.assign(f.state.user, override);
    expect((await f.read()).status).toBe(403);
    expect(f.calls.some((call) => call.method === "HEAD")).toBe(false);
  });

  it("fails closed on native lookup errors", async () => {
    const f = fixture();
    f.state.nativeError = true;
    expect((await f.read()).status).toBe(503);
    expect(f.calls.some((call) => call.method === "HEAD")).toBe(false);
  });

  it("stops a cancelled request even while the native client is being resolved", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.getClient.mockImplementation(() => {
      controller.abort();
      return new Promise(() => undefined);
    });
    expect(
      (await f.read(undefined, { signal: controller.signal })).status,
    ).toBe(503);
    expect(f.calls.some((call) => call.url.origin === NATIVE)).toBe(false);
  });

  it.each(["organizations.list", "users.list", "billing.subscriptions.list"])(
    "projects %s and uses escaped single-column search and stable paging",
    async (operation) => {
      const f = fixture();
      const { status, payload } = await f.read({
        operation,
        limit: 10,
        offset: 20,
        search: "100%_care\\team",
      });
      expect(status).toBe(200);
      expect(payload.data).toMatchObject({ total: 1, limit: 10, offset: 20 });
      const query = f.calls.at(-1)!.url.searchParams;
      const column =
        operation === "organizations.list"
          ? "name"
          : operation === "users.list"
            ? "email_lower"
            : "stripe_subscription_id";
      expect(query.get(column)).toBe("ilike.%100\\%\\_care\\\\team%");
      expect(query.has("or")).toBe(false);
      expect(query.get("limit")).toBe("10");
      expect(query.get("offset")).toBe("20");
      expect(query.get("order")).toMatch(/,id.asc$/);
      if (operation === "billing.subscriptions.list")
        expect(payload.data).toMatchObject({
          source: "application_database",
          items: [
            {
              id: SUB_ID,
              organizationId: ORG_ID,
              organizationName: "Fixture organization",
              planCode: "basic",
              planName: "Basic",
              status: "active",
              providerStatus: "active",
              providerCustomerId: "cus_fixture",
              providerSubscriptionId: "sub_fixture",
              currentPeriodEnd: NOW,
              updatedAt: NOW,
            },
          ],
        });
    },
  );

  it("rejects an upstream customer row even when PostgREST violates the staff filter", async () => {
    const f = fixture();
    f.state.staff[0].role = "customer";
    expect(await f.read({ operation: "users.list" })).toMatchObject({
      status: 503,
      payload: { error: { code: "upstream" } },
    });
  });

  it("returns exact application billing status counts with no revenue or provider calls", async () => {
    const f = fixture();
    expect(
      (await f.read({ operation: "billing.overview" })).payload.data,
    ).toEqual({
      source: "application_database",
      subscriptionCount: 10,
      statusCounts: [
        { status: "active", count: 4 },
        { status: "trialing", count: 2 },
        { status: "past_due", count: 1 },
        { status: "canceled", count: 3 },
      ],
    });
    expect(f.calls.filter((call) => call.method === "HEAD")).toHaveLength(5);
  });

  it("rejects billing totals that disagree with the independent status counts", async () => {
    const f = fixture();
    f.state.subscriptionCount = 11;
    expect(await f.read({ operation: "billing.overview" })).toMatchObject({
      status: 503,
      payload: { error: { code: "upstream" } },
    });
  });

  it("accepts only a UUID organization filter for subscriptions", async () => {
    const f = fixture();
    expect(
      (
        await f.read({
          operation: "billing.subscriptions.list",
          organizationId: ORG_ID,
        })
      ).status,
    ).toBe(200);
    expect(f.calls.at(-1)!.url.searchParams.get("org_id")).toBe(`eq.${ORG_ID}`);
  });

  it.each([
    { operation: "users.create" },
    { operation: "users.list", organizationId: ORG_ID },
    { operation: "billing.subscriptions.list", organizationId: "other" },
    { operation: "subscriptions.list" },
    { operation: "overview", url: "https://example.test" },
    { operation: "organizations.list", limit: 51 },
    { operation: "users.list", offset: 10001 },
    { operation: "users.list", search: "*" },
    { operation: "users.list", search: "bad\ninput" },
  ])("rejects unsupported input %j before authorization", async (body) => {
    const f = fixture();
    expect((await f.read(body)).status).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("refuses browser origins, native cookies, and missing bearer credentials", async () => {
    for (const [headers, status] of [
      [{ Origin: "https://support-hub-web-production.up.railway.app" }, 403],
      [{ Cookie: "pf_session=fixture" }, 403],
      [{ Authorization: "" }, 401],
    ] as const) {
      const f = fixture();
      expect(
        (
          await f.read(undefined, {
            headers: {
              "Content-Type": "application/json",
              Authorization: TOKEN,
              ...headers,
            },
          })
        ).status,
      ).toBe(status);
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });
});
