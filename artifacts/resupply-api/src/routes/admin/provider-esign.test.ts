// Route tests for the provider e-signature employee console
// (routes/admin/provider-esign.ts).
//
// Coverage focus (per docs/remaining-gaps-2026-06-22.md §5): the
// sign/verify/token paths — inviting a provider (auth-user mint + the
// staff-conflict guard + the revoked-customer resurrection), the
// signature-request state machine (the wrong-status guards on the
// employee stamp actions: void / ready-to-print / returned-signed /
// attach-to-chart / release), the hash-chain verify reporting, and the
// certificate PDF path. The hash-chain append/verify, the PDF renderer,
// the help-doc attachments, the auth token mint, and the outbound email
// are all mocked at the module boundary; the route's scoping + guards
// are what's exercised.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const { emailMock } = vi.hoisted(() => ({ emailMock: vi.fn() }));
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({
    publicBaseUrl: "https://cmbreathe.com",
    email: emailMock,
  }),
}));

// Keep the real exports (notably `roleHasPermission`, used by the
// requirePermission auth mock) and only stub the token-mint / email
// renderer the invite path calls.
vi.mock("@workspace/resupply-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-auth")
  >("@workspace/resupply-auth");
  return {
    ...actual,
    issueToken: vi.fn(() => ({
      raw: "raw-token-123",
      hash: Buffer.from("hash"),
    })),
    bufferToHexBytea: vi.fn(() => "\\x6861736800"),
    renderProviderPortalInviteEmail: vi.fn(() => ({
      subject: "Welcome to the provider portal",
      html: "<p>hi</p>",
      text: "hi",
    })),
  };
});

vi.mock("../../lib/help-docs", () => ({
  buildInviteHelpAttachments: vi.fn(async () => []),
}));

const { appendSignatureEventMock, verifySignatureChainMock, renderPdfMock } =
  vi.hoisted(() => ({
    // Typed so `.mock.calls[i][j]` indexing is well-formed: the route
    // calls appendSignatureEvent(orgId, eventInput) and
    // renderSignatureLogPdf(input).
    appendSignatureEventMock: vi.fn(
      async (
        _orgId: string,
        _event: { eventType: string; payload?: Record<string, unknown> },
      ): Promise<void> => undefined,
    ),
    verifySignatureChainMock: vi.fn((): { ok: boolean } => ({ ok: true })),
    renderPdfMock: vi.fn(
      async (_input: { scope: string; items: unknown[] }): Promise<Buffer> =>
        Buffer.from("%PDF-1.4 fake"),
    ),
  }));
vi.mock("../../lib/provider-portal/signature-events", () => ({
  appendSignatureEvent: appendSignatureEventMock,
  verifySignatureChain: verifySignatureChainMock,
}));
vi.mock("../../lib/provider-portal/signature-log-pdf", () => ({
  renderSignatureLogPdf: renderPdfMock,
}));

import esignRouter from "./provider-esign";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

const PROVIDER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(esignRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  appendSignatureEventMock.mockReset();
  appendSignatureEventMock.mockResolvedValue(undefined);
  verifySignatureChainMock.mockReset();
  verifySignatureChainMock.mockReturnValue({ ok: true });
  renderPdfMock.mockReset();
  renderPdfMock.mockResolvedValue(Buffer.from("%PDF-1.4 fake"));
});

// ── Accounts ──────────────────────────────────────────────────────

describe("GET /admin/provider-portal/accounts", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/provider-portal/accounts");
    expect(res.status).toBe(401);
  });

  it("maps the account rows (with the joined provider name)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: [
        {
          id: ACCOUNT,
          provider_id: PROVIDER,
          email_lower: "doc@example.com",
          status: "active",
          mfa_enrolled_at: "2026-06-01T00:00:00Z",
          last_login_at: null,
          invited_by_email: "ops@penn.example.com",
          created_at: "2026-05-01T00:00:00Z",
          providers: {
            legal_name: "Dr. Sleep",
            npi: "1234567890",
            practice_name: "Sleep Clinic",
          },
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/provider-portal/accounts");
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0]).toMatchObject({
      id: ACCOUNT,
      email: "doc@example.com",
      mfaEnrolled: true,
      providerName: "Dr. Sleep",
      providerNpi: "1234567890",
    });
  });
});

describe("POST /admin/provider-portal/accounts/invite", () => {
  const url = "/admin/provider-portal/accounts/invite";

  it("404 when the provider does not exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", { data: null });
    const res = await request(makeApp())
      .post(url)
      .send({ providerId: PROVIDER });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("provider_not_found");
  });

  it("400 when no email is on file and none is supplied", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", {
      data: { id: PROVIDER, legal_name: "Dr. Sleep", email: null },
    });
    const res = await request(makeApp())
      .post(url)
      .send({ providerId: PROVIDER });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("email_required");
  });

  it("409 when the email belongs to a staff (non-customer) auth row", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", {
      data: {
        id: PROVIDER,
        legal_name: "Dr. Sleep",
        email: "admin@example.com",
      },
    });
    // inviteProviderUser: existing auth user is staff.
    stageSupabaseResponse("users", "select", {
      data: { id: "u-existing", status: "active", role: "admin" },
    });
    const res = await request(makeApp())
      .post(url)
      .send({ providerId: PROVIDER });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_belongs_to_staff");
    // No invite email goes out on a staff conflict.
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("happy path: mints a fresh customer user, emails the link, inserts the account", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", {
      data: { id: PROVIDER, legal_name: "Dr. Sleep", email: "doc@example.com" },
    });
    // inviteProviderUser: no existing auth user.
    stageSupabaseResponse("users", "select", { data: null });
    stageSupabaseResponse("users", "insert", { data: { id: "u-new" } });
    stageSupabaseResponse("email_tokens", "insert", { data: null });
    // Link the portal account: no existing account → insert.
    stageSupabaseResponse("provider_portal_accounts", "select", { data: null });
    stageSupabaseResponse("provider_portal_accounts", "insert", { data: null });

    const res = await request(makeApp())
      .post(url)
      .send({ providerId: PROVIDER });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      email: "doc@example.com",
      emailSent: true,
    });
    expect(res.body.inviteLink).toContain("/reset-password?token=");
    expect(emailMock).toHaveBeenCalledTimes(1);
    const acct = getSupabaseWritePayloads(
      "provider_portal_accounts",
      "insert",
    )[0] as Record<string, unknown>;
    expect(acct.provider_id).toBe(PROVIDER);
    expect(acct.status).toBe("invited");
    expect(acct.auth_user_id).toBe("u-new");
  });

  it("resurrects a revoked CUSTOMER auth row (never touches the role)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", {
      data: { id: PROVIDER, legal_name: "Dr. Sleep", email: "doc@example.com" },
    });
    stageSupabaseResponse("users", "select", {
      data: { id: "u-revoked", status: "revoked", role: "customer" },
    });
    // Re-activate update on the users row.
    stageSupabaseResponse("users", "update", { data: null });
    stageSupabaseResponse("email_tokens", "insert", { data: null });
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: { id: ACCOUNT },
    });
    stageSupabaseResponse("provider_portal_accounts", "update", { data: null });

    const res = await request(makeApp())
      .post(url)
      .send({ providerId: PROVIDER });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const reactivate = getSupabaseWritePayloads("users", "update")[0] as Record<
      string,
      unknown
    >;
    expect(reactivate.status).toBe("invited");
    // The role is deliberately absent from the update payload.
    expect("role" in reactivate).toBe(false);
  });
});

describe("POST /admin/provider-portal/accounts/:id/disable", () => {
  const url = `/admin/provider-portal/accounts/${ACCOUNT}/disable`;

  it("404 when the account does not exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_portal_accounts", "update", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(404);
  });

  it("disables the account and revokes live sessions", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_portal_accounts", "update", {
      data: { auth_user_id: "u-1" },
    });
    stageSupabaseResponse("sessions", "update", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const upd = getSupabaseWritePayloads(
      "provider_portal_accounts",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd.status).toBe("disabled");
  });
});

describe("POST /admin/provider-portal/accounts/:id/enable", () => {
  const url = `/admin/provider-portal/accounts/${ACCOUNT}/enable`;

  it("re-enables to 'active' when MFA was already enrolled", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: { mfa_enrolled_at: "2026-01-01T00:00:00Z" },
    });
    stageSupabaseResponse("provider_portal_accounts", "update", {
      data: { id: ACCOUNT },
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("re-enables to 'invited' when MFA was never enrolled", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: { mfa_enrolled_at: null },
    });
    stageSupabaseResponse("provider_portal_accounts", "update", {
      data: { id: ACCOUNT },
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("invited");
  });
});

// ── Signature requests ────────────────────────────────────────────

describe("POST /admin/provider-portal/signature-requests", () => {
  const url = "/admin/provider-portal/signature-requests";

  it("400 on an invalid body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(url).send({ providerId: "x" });
    expect(res.status).toBe(400);
  });

  it("404 when the provider does not exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", { data: null });
    const res = await request(makeApp()).post(url).send({
      providerId: PROVIDER,
      subjectType: "cmn",
      title: "Certificate of Medical Necessity",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("provider_not_found");
  });

  it("creates the request, links the account, and appends a 'created' event", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", { data: { id: PROVIDER } });
    // Account link lookup.
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: { id: ACCOUNT },
    });
    stageSupabaseResponse("provider_signature_requests", "insert", {
      data: { id: REQUEST },
    });
    const res = await request(makeApp()).post(url).send({
      providerId: PROVIDER,
      subjectType: "cmn",
      title: "Certificate of Medical Necessity",
      patientName: "Jane Doe",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, id: REQUEST });
    const inserted = getSupabaseWritePayloads(
      "provider_signature_requests",
      "insert",
    )[0] as Record<string, unknown>;
    expect(inserted.status).toBe("pending");
    expect(inserted.account_id).toBe(ACCOUNT);
    expect(inserted.patient_name_snapshot).toBe("Jane Doe");
    expect(appendSignatureEventMock).toHaveBeenCalledTimes(1);
    expect(appendSignatureEventMock.mock.calls[0][1]).toMatchObject({
      requestId: REQUEST,
      eventType: "created",
      actorKind: "employee",
    });
  });
});

describe("GET /admin/provider-portal/signature-requests/:id", () => {
  const url = `/admin/provider-portal/signature-requests/${REQUEST}`;

  it("404 when the request is missing", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: null,
    });
    const res = await request(makeApp()).get(url);
    expect(res.status).toBe(404);
  });

  it("returns the request + chain-verify result", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: {
        id: REQUEST,
        status: "signed",
        providers: { legal_name: "Dr. Sleep", npi: "1", practice_name: "SC" },
      },
    });
    // loadEvents: the events read.
    stageSupabaseResponse("provider_signature_events", "select", {
      data: [
        {
          seq: 1,
          event_type: "created",
          actor_kind: "employee",
          actor_email: "ops@penn.example.com",
          payload: {},
          ip: null,
          user_agent: null,
          prev_hash: "GENESIS",
          event_hash: "h1",
          occurred_at: "2026-06-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(url);
    expect(res.status).toBe(200);
    expect(res.body.chainOk).toBe(true);
    expect(res.body.events).toHaveLength(1);
    expect(verifySignatureChainMock).toHaveBeenCalledTimes(1);
  });
});

describe("signature-request state machine (stampAction)", () => {
  it("void: 409 wrong_status when the request is not pending", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: { id: REQUEST, status: "signed" },
    });
    const res = await request(makeApp())
      .post(`/admin/provider-portal/signature-requests/${REQUEST}/void`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("wrong_status");
    expect(appendSignatureEventMock).not.toHaveBeenCalled();
  });

  it("void: happy path stamps void + appends the event", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: { id: REQUEST, status: "pending" },
    });
    stageSupabaseResponse("provider_signature_requests", "update", {
      data: { id: REQUEST },
    });
    const res = await request(makeApp())
      .post(`/admin/provider-portal/signature-requests/${REQUEST}/void`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const upd = getSupabaseWritePayloads(
      "provider_signature_requests",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd.status).toBe("void");
    expect(appendSignatureEventMock.mock.calls[0][1].eventType).toBe("voided");
  });

  it("ready-to-print: 409 when the request is not signed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: { id: REQUEST, status: "pending" },
    });
    const res = await request(makeApp())
      .post(
        `/admin/provider-portal/signature-requests/${REQUEST}/ready-to-print`,
      )
      .send({});
    expect(res.status).toBe(409);
  });

  it("ready-to-print: happy path stamps the timestamp + event", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: { id: REQUEST, status: "signed" },
    });
    stageSupabaseResponse("provider_signature_requests", "update", {
      data: { id: REQUEST },
    });
    const res = await request(makeApp())
      .post(
        `/admin/provider-portal/signature-requests/${REQUEST}/ready-to-print`,
      )
      .send({});
    expect(res.status).toBe(200);
    const upd = getSupabaseWritePayloads(
      "provider_signature_requests",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd.ready_to_print_at).toBeTruthy();
    expect(appendSignatureEventMock.mock.calls[0][1].eventType).toBe(
      "ready_to_print",
    );
  });

  it("release: 400 on an invalid releaseKind", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/provider-portal/signature-requests/${REQUEST}/release`)
      .send({ releaseKind: "bogus" });
    expect(res.status).toBe(400);
  });

  it("release: happy path records the release kind + note", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: { id: REQUEST, status: "signed" },
    });
    stageSupabaseResponse("provider_signature_requests", "update", {
      data: { id: REQUEST },
    });
    const res = await request(makeApp())
      .post(`/admin/provider-portal/signature-requests/${REQUEST}/release`)
      .send({ releaseKind: "claim", note: "sent to payer" });
    expect(res.status).toBe(200);
    const upd = getSupabaseWritePayloads(
      "provider_signature_requests",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd.release_kind).toBe("claim");
    expect(upd.release_note).toBe("sent to payer");
    expect(appendSignatureEventMock.mock.calls[0][1].payload).toMatchObject({
      releaseKind: "claim",
      note: "sent to payer",
    });
  });

  it("returns 409 when the optimistic-status update matches no row", async () => {
    mockAdmin.current = ADMIN;
    // The pre-read sees 'signed' but the conditional update returns null
    // (a concurrent status change), so the route reports wrong_status.
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: { id: REQUEST, status: "signed" },
    });
    stageSupabaseResponse("provider_signature_requests", "update", {
      data: null,
    });
    const res = await request(makeApp())
      .post(
        `/admin/provider-portal/signature-requests/${REQUEST}/returned-signed`,
      )
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("wrong_status");
    expect(appendSignatureEventMock).not.toHaveBeenCalled();
  });
});

describe("POST /admin/provider-portal/signature-requests/:id/remind", () => {
  const url = `/admin/provider-portal/signature-requests/${REQUEST}/remind`;

  it("409 not_pending when the request is already signed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: { id: REQUEST, status: "signed", provider_id: PROVIDER },
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_pending");
  });

  it("emails the linked provider account and appends a 'reminded' event", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: {
        id: REQUEST,
        status: "pending",
        title: "CMN",
        account_id: ACCOUNT,
        provider_id: PROVIDER,
      },
    });
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: { email_lower: "doc@example.com" },
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(appendSignatureEventMock.mock.calls[0][1].eventType).toBe(
      "reminded",
    );
  });

  it("still succeeds (emailSent=false) when there is no linked account email", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: {
        id: REQUEST,
        status: "pending",
        title: "CMN",
        account_id: null,
        provider_id: PROVIDER,
      },
    });
    stageSupabaseResponse("provider_portal_accounts", "select", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("certificate / signature-log PDFs", () => {
  it("certificate.pdf: 404 when the request is missing", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: null,
    });
    const res = await request(makeApp()).get(
      `/admin/provider-portal/signature-requests/${REQUEST}/certificate.pdf`,
    );
    expect(res.status).toBe(404);
  });

  it("certificate.pdf: renders a PDF for an existing request", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: {
        id: REQUEST,
        title: "CMN",
        subject_type: "cmn",
        status: "signed",
        providers: {
          legal_name: "Dr. Sleep",
          npi: "1",
          practice_name: "SC",
        },
      },
    });
    // buildLogItem -> loadEvents read.
    stageSupabaseResponse("provider_signature_events", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/admin/provider-portal/signature-requests/${REQUEST}/certificate.pdf`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(renderPdfMock).toHaveBeenCalledTimes(1);
    expect(renderPdfMock.mock.calls[0][0].scope).toBe("certificate");
  });

  it("signature-log.pdf: 404 when the provider is missing", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/provider-portal/providers/${PROVIDER}/signature-log.pdf`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("provider_not_found");
  });

  it("signature-log.pdf: renders the log for every signed request", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("providers", "select", {
      data: { legal_name: "Dr. Sleep", npi: "1", practice_name: "SC" },
    });
    stageSupabaseResponse("provider_signature_requests", "select", {
      data: [
        { id: REQUEST, title: "CMN", subject_type: "cmn", status: "signed" },
      ],
    });
    // buildLogItem -> loadEvents read for the one row.
    stageSupabaseResponse("provider_signature_events", "select", { data: [] });
    const res = await request(makeApp()).get(
      `/admin/provider-portal/providers/${PROVIDER}/signature-log.pdf`,
    );
    expect(res.status).toBe(200);
    expect(renderPdfMock.mock.calls[0][0].scope).toBe("log");
    expect(renderPdfMock.mock.calls[0][0].items).toHaveLength(1);
  });
});
