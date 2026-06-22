// Unit tests for the referrals.adherence-report worker.
//
// This worker sends a PHI disclosure (a 90-day adherence attestation) to a
// patient's referring provider, so the safety-critical behaviors are
// covered here: the flag-OFF no-op, idempotency (a patient with an existing
// 90-day row is never re-sent), fax-preferred-then-email-fallback, skipping
// when there's no referring provider or no fax/email, and a failed send
// recording status='failed' without blocking the rest of the worklist.
//
// All external effects are mocked: the senders (Telnyx fax + SendGrid),
// the PDF renderer, and the org-scoped Supabase client.

import { describe, it, expect, vi, beforeEach } from "vitest";

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

const listActiveOrgIdsMock = vi.hoisted(() => vi.fn());
const getOrgScopedClientMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/resupply-db", () => ({
  listActiveOrgIds: listActiveOrgIdsMock,
  getOrgScopedClient: getOrgScopedClientMock,
  resolveSeedOrgId: vi.fn().mockResolvedValue("seed-org"),
}));

const renderPdfMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/referral-adherence/render", () => ({
  renderAdherenceAttestationPdf: renderPdfMock,
}));

const sendFaxMock = vi.hoisted(() => vi.fn());
const TelnyxApiErrorStub = vi.hoisted(
  () => class TelnyxApiErrorStub extends Error {},
);
const createTelnyxFaxClientMock = vi.hoisted(() =>
  vi.fn(() => ({ sendFax: sendFaxMock })),
);
vi.mock("@workspace/resupply-telecom", () => ({
  createTelnyxFaxClient: createTelnyxFaxClientMock,
  TelnyxApiError: TelnyxApiErrorStub,
}));

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/email/tenant-sender", () => ({
  createTenantSendgridClient: vi.fn(async () => ({ sendEmail: sendEmailMock })),
}));

const isFaxConfiguredMock = vi.hoisted(() => vi.fn());
vi.mock("../../routes/admin/physician-fax-outreach.js", () => ({
  isFaxConfigured: isFaxConfiguredMock,
  getFaxPublicBaseUrl: vi.fn(() => "https://example.test"),
}));

vi.mock("../../lib/messaging/tenant-telecom", () => ({
  resolveTenantFaxFrom: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../lib/metering/usage", () => ({
  recordTenantUsage: vi.fn(),
}));

vi.mock("../../lib/fax-document-token", () => ({
  signAdherenceAttestationFaxToken: vi.fn(() => "tok"),
}));

import { runReferralAdherenceReport } from "./referral-adherence-report";

// ── Org-scoped client fake ───────────────────────────────────────────────
//
// A minimal chainable PostgREST stand-in. Each `.from(table)` returns a
// builder whose terminal awaits resolve from `tableData`. The worker uses a
// few distinct shapes; the builder records the table + a "kind" so the test
// can supply the right rows.

interface FakeConfig {
  claims?: Array<{
    patient_id: string | null;
    referring_provider_id: string | null;
  }>;
  prescriptions?: Array<{ patient_id: string; provider_id: string | null }>;
  providers?: Array<{
    id: string;
    fax_e164: string | null;
    email: string | null;
  }>;
  // earliest therapy night per patient (YYYY-MM-DD), or undefined → none
  earliestNight?: Record<string, string | undefined>;
  // patientIds that already have a 90-day report row
  alreadySent?: Set<string>;
}

const upsertCalls: Array<Record<string, unknown>> = [];

function makeClient(cfg: FakeConfig) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const ret = () => builder;
      // chainable no-ops
      for (const m of ["select", "not", "in", "eq", "order", "limit"]) {
        builder[m] = vi.fn(ret);
      }
      builder.maybeSingle = vi.fn(async () => {
        if (table === "referral_adherence_reports") {
          // idempotency probe: last .eq chain carried patient_id
          const pid = (builder as { _patientId?: string })._patientId;
          if (pid && cfg.alreadySent?.has(pid)) return { data: { id: "x" } };
          return { data: null };
        }
        return { data: null };
      });
      // capture patient_id passed to eq for the idempotency / night probes
      const origEq = builder.eq as (col: string, val: string) => unknown;
      builder.eq = vi.fn((col: string, val: string) => {
        if (col === "patient_id")
          (builder as { _patientId?: string })._patientId = val;
        return origEq(col, val);
      });
      builder.upsert = vi.fn(async (row: Record<string, unknown>) => {
        upsertCalls.push(row);
        return { error: null };
      });
      // make the builder awaitable for the list-style queries
      (builder as { then?: unknown }).then = (
        resolve: (v: { data: unknown; error: null }) => void,
      ) => {
        let data: unknown = [];
        if (table === "insurance_claims") data = cfg.claims ?? [];
        else if (table === "prescriptions") data = cfg.prescriptions ?? [];
        else if (table === "providers") data = cfg.providers ?? [];
        else if (table === "patient_therapy_nights") {
          const pid = (builder as { _patientId?: string })._patientId;
          const night = pid ? cfg.earliestNight?.[pid] : undefined;
          data = night ? [{ night_date: night }] : [];
        }
        resolve({ data, error: null });
      };
      return builder;
    },
  };
}

// A therapy anchor far enough in the past that the 90-day horizon is
// complete (so the patient is "due").
const DUE_ANCHOR = "2020-01-01";

beforeEach(() => {
  vi.clearAllMocks();
  upsertCalls.length = 0;
  // isFaxConfigured() is mocked true, but the worker still reads the
  // platform fax DID as a fallback when the tenant has none — provide it so
  // the fax branch doesn't throw on `undefined.trim()`.
  process.env.TELNYX_FAX_FROM_NUMBER = "+15550000000";
  listActiveOrgIdsMock.mockResolvedValue(["org-a"]);
  isFeatureEnabledMock.mockResolvedValue(true);
  isFaxConfiguredMock.mockReturnValue(true);
  renderPdfMock.mockResolvedValue({
    ok: true,
    pdf: Buffer.from("PDF"),
    anchorDate: DUE_ANCHOR,
    result: { qualifies: true },
  });
  sendFaxMock.mockResolvedValue({ id: "fax-1", status: "queued" });
  sendEmailMock.mockResolvedValue({ messageId: "msg-1" });
});

describe("runReferralAdherenceReport", () => {
  it("flag OFF → complete no-op (no senders, no renders)", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    getOrgScopedClientMock.mockReturnValue(makeClient({}));

    const stats = await runReferralAdherenceReport();

    expect(stats.sent).toBe(0);
    expect(stats.orgsScanned).toBe(0);
    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(sendFaxMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "referrals.adherence_report",
      "org-a",
    );
  });

  it("faxes a due patient whose provider has a fax (fax preferred)", async () => {
    getOrgScopedClientMock.mockReturnValue(
      makeClient({
        prescriptions: [{ patient_id: "p1", provider_id: "prov1" }],
        providers: [
          { id: "prov1", fax_e164: "+15551234567", email: "doc@x.test" },
        ],
        earliestNight: { p1: DUE_ANCHOR },
      }),
    );

    const stats = await runReferralAdherenceReport();

    expect(sendFaxMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(stats.sent).toBe(1);
    // recorded a 'sent' fax row for idempotency
    expect(upsertCalls[0]).toMatchObject({
      patient_id: "p1",
      provider_id: "prov1",
      window_days: 90,
      channel: "fax",
      status: "sent",
    });
  });

  it("falls back to email when the provider has no fax", async () => {
    getOrgScopedClientMock.mockReturnValue(
      makeClient({
        prescriptions: [{ patient_id: "p1", provider_id: "prov1" }],
        providers: [{ id: "prov1", fax_e164: null, email: "doc@x.test" }],
        earliestNight: { p1: DUE_ANCHOR },
      }),
    );

    const stats = await runReferralAdherenceReport();

    expect(sendFaxMock).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(stats.sent).toBe(1);
    expect(upsertCalls[0]).toMatchObject({ channel: "email", status: "sent" });
  });

  it("falls back to email when the fax send fails", async () => {
    sendFaxMock.mockRejectedValue(new TelnyxApiErrorStub("boom"));
    getOrgScopedClientMock.mockReturnValue(
      makeClient({
        prescriptions: [{ patient_id: "p1", provider_id: "prov1" }],
        providers: [
          { id: "prov1", fax_e164: "+15551234567", email: "doc@x.test" },
        ],
        earliestNight: { p1: DUE_ANCHOR },
      }),
    );

    const stats = await runReferralAdherenceReport();

    expect(sendFaxMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(stats.sent).toBe(1);
    expect(upsertCalls[0]).toMatchObject({ channel: "email", status: "sent" });
  });

  it("skips a patient already sent a 90-day report (idempotency)", async () => {
    getOrgScopedClientMock.mockReturnValue(
      makeClient({
        prescriptions: [{ patient_id: "p1", provider_id: "prov1" }],
        providers: [
          { id: "prov1", fax_e164: "+15551234567", email: "doc@x.test" },
        ],
        earliestNight: { p1: DUE_ANCHOR },
        alreadySent: new Set(["p1"]),
      }),
    );

    const stats = await runReferralAdherenceReport();

    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(sendFaxMock).not.toHaveBeenCalled();
    expect(stats.skippedAlreadySent).toBe(1);
    expect(stats.sent).toBe(0);
  });

  it("skips when the provider has neither fax nor email", async () => {
    getOrgScopedClientMock.mockReturnValue(
      makeClient({
        prescriptions: [{ patient_id: "p1", provider_id: "prov1" }],
        providers: [{ id: "prov1", fax_e164: null, email: null }],
        earliestNight: { p1: DUE_ANCHOR },
      }),
    );

    const stats = await runReferralAdherenceReport();

    expect(sendFaxMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(stats.skippedNoContact).toBe(1);
    expect(stats.sent).toBe(0);
  });

  it("skips a patient with no referring provider at all", async () => {
    getOrgScopedClientMock.mockReturnValue(
      makeClient({
        // no claims, no prescriptions with a provider
        earliestNight: { p1: DUE_ANCHOR },
      }),
    );

    const stats = await runReferralAdherenceReport();

    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(stats.sent).toBe(0);
  });

  it("a failed send records status='failed' and does not block others", async () => {
    // Provider has fax only; fax fails and there's no email → failed row.
    sendFaxMock
      .mockRejectedValueOnce(new TelnyxApiErrorStub("boom")) // p1 fails
      .mockResolvedValueOnce({ id: "fax-2", status: "queued" }); // p2 ok
    getOrgScopedClientMock.mockReturnValue(
      makeClient({
        prescriptions: [
          { patient_id: "p1", provider_id: "prov1" },
          { patient_id: "p2", provider_id: "prov2" },
        ],
        providers: [
          { id: "prov1", fax_e164: "+15551111111", email: null },
          { id: "prov2", fax_e164: "+15552222222", email: null },
        ],
        earliestNight: { p1: DUE_ANCHOR, p2: DUE_ANCHOR },
      }),
    );

    const stats = await runReferralAdherenceReport();

    // p1 failed (fax-only, no email fallback), p2 sent.
    expect(stats.failed).toBe(1);
    expect(stats.sent).toBe(1);
    const failedRow = upsertCalls.find((r) => r.status === "failed");
    expect(failedRow).toMatchObject({ patient_id: "p1", channel: "fax" });
    const sentRow = upsertCalls.find((r) => r.status === "sent");
    expect(sentRow).toMatchObject({ patient_id: "p2", channel: "fax" });
  });

  it("skips a patient who hasn't reached the 90-day mark yet", async () => {
    const today = new Date().toISOString().slice(0, 10); // anchor = today
    getOrgScopedClientMock.mockReturnValue(
      makeClient({
        prescriptions: [{ patient_id: "p1", provider_id: "prov1" }],
        providers: [
          { id: "prov1", fax_e164: "+15551234567", email: "doc@x.test" },
        ],
        earliestNight: { p1: today },
      }),
    );

    const stats = await runReferralAdherenceReport();

    expect(renderPdfMock).not.toHaveBeenCalled();
    expect(stats.skippedNotDue).toBe(1);
    expect(stats.sent).toBe(0);
  });
});
