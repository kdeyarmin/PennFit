// Unit tests for createSelfServeTenant — the public Breathe "create your
// account" provisioning service. We mock the auth deps (repo + email +
// audit) and the Supabase chokepoint so the test exercises the
// orchestration logic directly: password/email validation, the
// unverified-admin-invite reuse guard, slug-taken mapping, link base-URL
// selection, and the happy-path provisioning order.

import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock factories are hoisted above the module body, so every value a
// factory closes over has to be hoisted too — define them all here.
const {
  hashPassword,
  issueToken,
  renderVerifyEmail,
  renderPasswordResetEmail,
  writeUserChosenPassword,
  resolveSeedOrgId,
  getOrgScopedClient,
  findUserByEmail,
  insertUser,
  expireUnconsumedEmailTokens,
  insertEmailToken,
  emailSender,
  audit,
  getRouteState,
} = vi.hoisted(() => {
  // ---- Supabase chokepoint chain mock (declared first; used below). ----
  const state: {
    responses: Record<string, { data?: unknown; error?: unknown }>;
    calls: string[];
  } = { responses: {}, calls: [] };

  function resolveRoute(s: { table: string | null; op: string | null }): {
    data: unknown;
    error: unknown;
  } {
    const key = `${s.table}:${s.op}`;
    state.calls.push(key);
    const r = state.responses[key] ?? {};
    return { data: r.data ?? null, error: r.error ?? null };
  }

  function makeChain(cs: { table: string | null; op: string | null }) {
    const chain: Record<string, unknown> = {
      from(t: string) {
        cs.table = t;
        return chain;
      },
      insert() {
        cs.op = "insert";
        return chain;
      },
      update() {
        cs.op = "update";
        return chain;
      },
      upsert() {
        cs.op = "upsert";
        return chain;
      },
      select() {
        if (!cs.op) cs.op = "select";
        return chain;
      },
      eq() {
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle() {
        return Promise.resolve(resolveRoute(cs));
      },
      rpc(fn: string) {
        cs.table = `rpc:${fn}`;
        cs.op = "call";
        return Promise.resolve(resolveRoute(cs));
      },
      then(
        onF: (v: { data: unknown; error: unknown }) => unknown,
        onR?: (e: unknown) => unknown,
      ) {
        return Promise.resolve(resolveRoute(cs)).then(onF, onR);
      },
    };
    return chain;
  }

  return {
    hashPassword: vi.fn(async () => "argon2id$hash"),
    issueToken: vi.fn(() => ({ raw: "raw-token", hash: "token-hash" })),
    renderVerifyEmail: vi.fn(() => ({
      subject: "Verify your email",
      html: "<p>verify</p>",
      text: "verify",
    })),
    renderPasswordResetEmail: vi.fn(() => ({
      subject: "Set your password",
      html: "<p>set</p>",
      text: "set",
    })),
    writeUserChosenPassword: vi.fn(async () => {}),
    resolveSeedOrgId: vi.fn(async () => "seed-org"),
    getOrgScopedClient: vi.fn((_orgId: string) => ({
      raw: () => ({
        schema: (_s: string) => makeChain({ table: null, op: null }),
      }),
    })),
    findUserByEmail: vi.fn(),
    insertUser: vi.fn(async () => ({ id: "new-user-id" })),
    expireUnconsumedEmailTokens: vi.fn(async () => {}),
    insertEmailToken: vi.fn(async () => {}),
    emailSender: vi.fn(async () => {}),
    audit: vi.fn(),
    getRouteState: () => state,
  };
});

vi.mock("@workspace/resupply-auth", () => ({
  hashPassword,
  issueToken,
  renderVerifyEmail,
  renderPasswordResetEmail,
  writeUserChosenPassword,
  // Real-ish normalize: trims/lowercases and rejects anything without "@".
  normalizeEmail: (e: string) => {
    const v = String(e).trim().toLowerCase();
    if (!v.includes("@") || v.startsWith("@") || v.endsWith("@")) {
      throw new Error("invalid email");
    }
    return v;
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: () => resolveSeedOrgId(),
  getOrgScopedClient: (orgId: string) => getOrgScopedClient(orgId),
}));

const fakeDeps = {
  repo: {
    findUserByEmail,
    insertUser,
    expireUnconsumedEmailTokens,
    insertEmailToken,
  },
  email: emailSender,
  audit,
  env: { emailTokenTtlHours: 24 },
  publicBaseUrl: "https://pennpaps.com",
  passwordHashParams: { memoryCost: 1, timeCost: 1, parallelism: 1 },
};

vi.mock("./auth-deps.js", () => ({
  getAuthDeps: () => fakeDeps,
}));

import { createSelfServeTenant } from "./tenant-signup-service.js";

const STRONG_PASSWORD = "a-very-strong-passphrase-2026";

function baseInput(over: Record<string, unknown> = {}) {
  return {
    orgName: "Acme Home Medical",
    slug: "acme-home-medical",
    adminEmail: "owner@acmedme.com",
    password: STRONG_PASSWORD,
    baseUrl: "https://cmbreathe.com",
    ...over,
  };
}

// Live view of the chokepoint mock's recorded calls + per-route responses.
const routeState = getRouteState();

beforeEach(() => {
  vi.clearAllMocks();
  resolveSeedOrgId.mockResolvedValue("seed-org");
  insertUser.mockResolvedValue({ id: "new-user-id" });
  findUserByEmail.mockResolvedValue(null);
  routeState.calls.length = 0;
  routeState.responses = {
    "organizations:insert": {
      data: { id: "org-new", slug: "acme-home-medical" },
    },
    "feature_flags:select": {
      data: [
        {
          key: "alerts.auto_dispatch",
          enabled: true,
          description: null,
          category: null,
        },
      ],
    },
    "feature_flags:upsert": {},
    "admin_users:select": { data: null },
    "admin_users:insert": {},
    "admin_users:update": {},
  };
});

describe("createSelfServeTenant", () => {
  it("provisions a brand-new tenant + admin and returns the platform sign-in url", async () => {
    const res = await createSelfServeTenant(baseInput());

    expect(res).toEqual({
      ok: true,
      slug: "acme-home-medical",
      // Built from the submitted host, NOT the tenant-pinned default.
      signInUrl: "https://cmbreathe.com/admin/sign-in",
    });

    // Org row created, then the admin auth user, then the password.
    expect(routeState.calls).toContain("organizations:insert");
    expect(insertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        emailLower: "owner@acmedme.com",
        role: "admin",
        status: "invited",
      }),
    );
    expect(writeUserChosenPassword).toHaveBeenCalledWith(
      fakeDeps.repo,
      expect.objectContaining({ userId: "new-user-id", mustChange: false }),
    );
    // Verification email sent to the typed address; link uses the host.
    expect(emailSender).toHaveBeenCalledTimes(1);
    expect(renderVerifyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ publicBaseUrl: "https://cmbreathe.com" }),
      "raw-token",
      expect.any(Number),
    );
    // admin_users linked + audit written.
    expect(routeState.calls).toContain("admin_users:insert");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.tenant_self_signup" }),
    );
  });

  it("assigns the chosen self-serve plan as the new tenant's subscription", async () => {
    routeState.responses["billing_plans:select"] = {
      data: { id: "plan-mf", is_public: true, is_custom: false },
    };
    const res = await createSelfServeTenant(
      baseInput({ plan: "mask_fitter", sendSetPasswordLink: true }),
    );
    expect(res).toMatchObject({ ok: true });

    // Looked up the plan by code, then atomically swapped the tenant onto it.
    expect(routeState.calls).toContain("billing_plans:select");
    expect(routeState.calls).toContain("rpc:swap_tenant_subscription:call");
    // The chosen plan is recorded on the signup audit.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.tenant_self_signup",
        metadata: expect.objectContaining({ plan: "mask_fitter" }),
      }),
    );
  });

  it("does NOT assign a subscription when no plan is chosen", async () => {
    const res = await createSelfServeTenant(baseInput());
    expect(res).toMatchObject({ ok: true });
    expect(routeState.calls).not.toContain("rpc:swap_tenant_subscription:call");
  });

  it("leaves the tenant unassigned when the chosen plan is not self-selectable", async () => {
    // A custom / non-public plan must never be self-assigned at signup.
    routeState.responses["billing_plans:select"] = {
      data: { id: "plan-ent", is_public: false, is_custom: true },
    };
    const res = await createSelfServeTenant(baseInput({ plan: "enterprise" }));
    expect(res).toMatchObject({ ok: true });
    expect(routeState.calls).toContain("billing_plans:select");
    expect(routeState.calls).not.toContain("rpc:swap_tenant_subscription:call");
  });

  it("emails a SET-PASSWORD link (not a verify link) when sendSetPasswordLink is set", async () => {
    const res = await createSelfServeTenant(
      baseInput({ sendSetPasswordLink: true }),
    );
    expect(res).toMatchObject({ ok: true });

    // Voice signup: the caller never spoke a password, so they get a
    // password_reset token + set-password email (which also verifies the
    // address) — NOT the default verify-only email.
    expect(insertEmailToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "new-user-id",
        purpose: "password_reset",
      }),
    );
    expect(renderPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(renderVerifyEmail).not.toHaveBeenCalled();
    expect(emailSender).toHaveBeenCalledTimes(1);
  });

  it("falls back to the auth-deps base url when no/invalid origin is given", async () => {
    const res = await createSelfServeTenant(baseInput({ baseUrl: undefined }));
    expect(res).toMatchObject({
      ok: true,
      signInUrl: "https://pennpaps.com/admin/sign-in",
    });

    const ftp = await createSelfServeTenant(
      baseInput({ baseUrl: "ftp://evil.example", slug: "acme-2" }),
    );
    expect(ftp).toMatchObject({
      ok: true,
      signInUrl: "https://pennpaps.com/admin/sign-in",
    });
  });

  it("rejects a short password without touching the DB", async () => {
    const res = await createSelfServeTenant(baseInput({ password: "short" }));
    expect(res).toMatchObject({ ok: false, reason: "weak_password" });
    expect(findUserByEmail).not.toHaveBeenCalled();
    expect(routeState.calls).toEqual([]);
  });

  it("rejects an invalid email", async () => {
    const res = await createSelfServeTenant(
      baseInput({ adminEmail: "not-an-email" }),
    );
    expect(res).toMatchObject({ ok: false, reason: "invalid_email" });
    expect(routeState.calls).toEqual([]);
  });

  it("reuses an UNVERIFIED admin invite rather than creating a new user", async () => {
    findUserByEmail.mockResolvedValue({
      id: "pending-user",
      role: "admin",
      emailVerifiedAt: null,
      status: "invited",
    });
    const res = await createSelfServeTenant(baseInput());
    expect(res.ok).toBe(true);
    // No new user — the pending invite is re-attached.
    expect(insertUser).not.toHaveBeenCalled();
    expect(writeUserChosenPassword).toHaveBeenCalledWith(
      fakeDeps.repo,
      expect.objectContaining({ userId: "pending-user" }),
    );
  });

  it("rejects a VERIFIED existing account ('sign in instead')", async () => {
    findUserByEmail.mockResolvedValue({
      id: "u1",
      role: "admin",
      emailVerifiedAt: "2026-01-01T00:00:00Z",
      status: "active",
    });
    const res = await createSelfServeTenant(baseInput());
    expect(res).toMatchObject({ ok: false, reason: "email_taken" });
    // Never created an org for a rejected signup.
    expect(routeState.calls).not.toContain("organizations:insert");
    expect(insertUser).not.toHaveBeenCalled();
  });

  it("rejects a non-admin (storefront customer) account", async () => {
    findUserByEmail.mockResolvedValue({
      id: "cust",
      role: "customer",
      emailVerifiedAt: null,
      status: "active",
    });
    const res = await createSelfServeTenant(baseInput());
    expect(res).toMatchObject({ ok: false, reason: "email_taken" });
    expect(routeState.calls).not.toContain("organizations:insert");
  });

  it("rejects a locked admin invite", async () => {
    findUserByEmail.mockResolvedValue({
      id: "locked",
      role: "admin",
      emailVerifiedAt: null,
      status: "locked",
    });
    const res = await createSelfServeTenant(baseInput());
    expect(res).toMatchObject({ ok: false, reason: "email_taken" });
    expect(routeState.calls).not.toContain("organizations:insert");
  });

  it("maps a duplicate-slug unique violation to slug_taken", async () => {
    routeState.responses["organizations:insert"] = { error: { code: "23505" } };
    const res = await createSelfServeTenant(baseInput());
    expect(res).toMatchObject({ ok: false, reason: "slug_taken" });
    expect(insertUser).not.toHaveBeenCalled();
  });

  it("reports unavailable when the seed org cannot be resolved", async () => {
    resolveSeedOrgId.mockResolvedValue(null as unknown as string);
    const res = await createSelfServeTenant(baseInput());
    expect(res).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("still succeeds when feature-flag provisioning throws (best-effort)", async () => {
    routeState.responses["feature_flags:select"] = {
      error: { code: "XX000", message: "boom" },
    };
    const res = await createSelfServeTenant(baseInput());
    expect(res.ok).toBe(true);
    // Provisioning carried on past the flag copy.
    expect(routeState.calls).toContain("admin_users:insert");
  });

  it("still succeeds when the verification email send fails", async () => {
    emailSender.mockRejectedValue(new Error("sendgrid down"));
    const res = await createSelfServeTenant(baseInput());
    expect(res.ok).toBe(true);
    expect(audit).toHaveBeenCalled();
  });
});
