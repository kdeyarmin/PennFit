// Tests for the provider e-signature INVITE + REMINDER email links.
//
// A non-seed tenant's provider must follow a link to THAT tenant's own
// host — where the host-scoped portal queue resolves to their org — not
// the platform host (which resolves to the seed org → empty queue / 404).
// So both the invite set-password link and the reminder sign-in link are
// built from `resolveTenantBaseUrl(orgId)`. Non-seed tenants without a
// verified domain are refused (422 / skipped reminder); the seed org
// alone may fall back to the platform `deps.publicBaseUrl`.
//
// These tests prove:
//   1. Invite link uses the tenant base URL when the tenant has a
//      verified custom domain.
//   2. Reminder link uses the tenant base URL likewise.
//   3. Non-seed tenants without a verified domain get 422 on invite
//      (and no reminder email), never a platform-host link.
//   4. The seed org still falls back to the platform base URL.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  MOCK_ORG_ID,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const PLATFORM_BASE_URL = "https://cmbreathe.com";
const TENANT_BASE_URL = "https://providers.acme-dme.example";
const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

// ── Supabase mock ────────────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth (requirePermission) mock ────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── Rate limiter: pass through ───────────────────────────────────────
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminReadRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  adminWriteRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

// ── Tenant base-URL resolver ─────────────────────────────────────────
const resolveTenantBaseUrlMock = vi.hoisted(() =>
  vi.fn(async (_orgId?: string): Promise<string | null> => null),
);
const resolveBrandingByOrgIdMock = vi.hoisted(() =>
  vi.fn(async (_orgId?: string) => ({
    storefrontName: "CareMetric Breathe",
    legalName: "CareMetric Breathe",
    tagline: "",
    logoUrl: null,
  })),
);
vi.mock("../../lib/tenant-branding", () => ({
  resolveTenantBaseUrl: resolveTenantBaseUrlMock,
  resolveBrandingByOrgId: resolveBrandingByOrgIdMock,
}));

// ── Auth deps: capture the email payload, supply a platform base URL ──
const sentEmails = vi.hoisted(
  () => [] as Array<{ to: string; html: string; text: string }>,
);
const emailMock = vi.hoisted(() =>
  vi.fn(async (msg: { to: string; html: string; text: string }) => {
    sentEmails.push(msg);
  }),
);
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({
    email: emailMock,
    publicBaseUrl: PLATFORM_BASE_URL,
  }),
}));

// Help-doc attachments are best-effort and not under test.
vi.mock("../../lib/help-docs", () => ({
  buildInviteHelpAttachments: vi.fn(async () => []),
}));

// Append-only signature-event log — no-op (not under test).
vi.mock("../../lib/provider-portal/signature-events", () => ({
  appendSignatureEvent: vi.fn(async () => undefined),
  verifySignatureChain: vi.fn(() => ({ ok: true })),
}));

// Token mint + invite-email render: deterministic, no crypto/template I/O.
// Spread the real module (the mocked requireAdmin's permission check reads
// roleHasPermission from it) and override only the three the route uses.
vi.mock("@workspace/resupply-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/resupply-auth")>();
  return {
    ...actual,
    bufferToHexBytea: (_b: unknown) => "\\xdeadbeef",
    issueToken: () => ({
      raw: "raw-token-123",
      hash: Buffer.from("hash"),
    }),
    renderProviderPortalInviteEmail: (
      cfg: { publicBaseUrl: string },
      args: { rawToken: string },
    ) => ({
      subject: "Welcome",
      // Echo the base URL the route handed the renderer so we can assert it.
      html: `<a href="${cfg.publicBaseUrl}/provider/reset-password?token=${args.rawToken}">set password</a>`,
      text: `${cfg.publicBaseUrl}/provider/reset-password?token=${args.rawToken}`,
    }),
  };
});

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import providerEsignRouter from "./provider-esign";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(providerEsignRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  sentEmails.length = 0;
  emailMock.mockClear();
  resolveTenantBaseUrlMock.mockReset();
  resolveTenantBaseUrlMock.mockResolvedValue(null);
  mockAdmin.current = {
    userId: "admin-1",
    email: "admin@example.com",
    role: "admin",
  };
});

/** Stage the DB round-trips an invite makes (provider read → user read →
 *  user insert → token insert → account read → account insert). */
function stageInviteDbHappyPath(): void {
  // providers select → existing provider with an email.
  stageSupabaseResponse("providers", "select", {
    data: {
      id: PROVIDER_ID,
      legal_name: "Dr. Acme",
      email: "dr@acme.example",
    },
  });
  // resupply_auth.users select → no existing user.
  stageSupabaseResponse("users", "select", { data: null });
  // resupply_auth.users insert → new auth user id.
  stageSupabaseResponse("users", "insert", { data: { id: "auth-user-1" } });
  // email_tokens insert → ok.
  stageSupabaseResponse("email_tokens", "insert", { data: null });
  // provider_portal_accounts select → no existing account.
  stageSupabaseResponse("provider_portal_accounts", "select", { data: null });
  // provider_portal_accounts insert → ok.
  stageSupabaseResponse("provider_portal_accounts", "insert", { data: null });
}

describe("provider invite email link — tenant base URL", () => {
  it("uses the tenant's verified custom-domain base URL when present", async () => {
    resolveTenantBaseUrlMock.mockResolvedValue(TENANT_BASE_URL);
    stageInviteDbHappyPath();

    const res = await request(makeApp())
      .post("/admin/provider-portal/accounts/invite")
      .send({ providerId: PROVIDER_ID });

    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(true);
    // The link returned to the admin uses the tenant host.
    expect(res.body.inviteLink).toBe(
      `${TENANT_BASE_URL}/provider/reset-password?token=raw-token-123`,
    );
    // The emailed copy uses the tenant host too (renderer got tenant base URL).
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].html).toContain(
      `${TENANT_BASE_URL}/provider/reset-password`,
    );
    expect(sentEmails[0].html).not.toContain(PLATFORM_BASE_URL);
    // Resolver was asked for the inviting tenant's org.
    expect(resolveTenantBaseUrlMock).toHaveBeenCalledWith(MOCK_ORG_ID);
  });

  it("refuses invite when a non-seed tenant has no verified domain", async () => {
    resolveTenantBaseUrlMock.mockResolvedValue(null);
    stageInviteDbHappyPath();

    const res = await request(makeApp())
      .post("/admin/provider-portal/accounts/invite")
      .send({ providerId: PROVIDER_ID });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("tenant_domain_required");
    expect(sentEmails).toHaveLength(0);
  });

  it("falls back to the platform base URL for the seed org without a verified domain", async () => {
    resolveTenantBaseUrlMock.mockResolvedValue(null);
    // Treat the inviting org as the seed so the platform fallback applies.
    mockAdmin.current = {
      userId: "admin-1",
      email: "admin@example.com",
      role: "admin",
      // Seed id returned by installSupabaseMock's resolveSeedOrgId.
      orgId: "00000000-0000-4000-8000-000000000000",
    };
    stageInviteDbHappyPath();

    const res = await request(makeApp())
      .post("/admin/provider-portal/accounts/invite")
      .send({ providerId: PROVIDER_ID });

    expect(res.status).toBe(200);
    expect(res.body.inviteLink).toBe(
      `${PLATFORM_BASE_URL}/provider/reset-password?token=raw-token-123`,
    );
    expect(sentEmails[0].html).toContain(
      `${PLATFORM_BASE_URL}/provider/reset-password`,
    );
  });
});

describe("provider reminder email link — tenant base URL", () => {
  function stageReminderDbHappyPath(): void {
    // provider_signature_requests select → one pending request.
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: {
        id: REQUEST_ID,
        status: "pending",
        title: "Rx",
        account_id: "acct-1",
        provider_id: PROVIDER_ID,
      },
    });
    // provider_portal_accounts select → linked account email.
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: { email_lower: "dr@acme.example" },
    });
  }

  it("uses the tenant's verified custom-domain base URL when present", async () => {
    resolveTenantBaseUrlMock.mockResolvedValue(TENANT_BASE_URL);
    stageReminderDbHappyPath();

    const res = await request(makeApp()).post(
      `/admin/provider-portal/signature-requests/${REQUEST_ID}/remind`,
    );

    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(true);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].html).toContain(`${TENANT_BASE_URL}/provider/sign-in`);
    expect(sentEmails[0].text).toContain(`${TENANT_BASE_URL}/provider/sign-in`);
    expect(sentEmails[0].html).not.toContain(PLATFORM_BASE_URL);
    expect(resolveTenantBaseUrlMock).toHaveBeenCalledWith(MOCK_ORG_ID);
  });

  it("skips the reminder email when a non-seed tenant has no verified domain", async () => {
    resolveTenantBaseUrlMock.mockResolvedValue(null);
    stageReminderDbHappyPath();

    const res = await request(makeApp()).post(
      `/admin/provider-portal/signature-requests/${REQUEST_ID}/remind`,
    );

    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
    expect(sentEmails).toHaveLength(0);
  });
});
