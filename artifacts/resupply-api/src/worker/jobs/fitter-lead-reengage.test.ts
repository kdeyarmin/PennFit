// Tests for the abandoned-fitter re-engagement dispatcher.
//
// Covers the pure compose helper plus the sweep's three branches:
//   * no SendGrid config — log + exit cleanly, no DB writes.
//   * happy path — eligible lead becomes one sendEmail call plus
//     one `nudged_at` stamp.
//   * converted skip — a lead whose email already appears in
//     public.orders is left untouched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseFilterCalls,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const sendEmailMock = vi.fn(async () => undefined);
vi.mock("@workspace/resupply-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/resupply-email")>()),
  createSendgridClient: () => ({
    sendEmail: sendEmailMock,
  }),
  DEFAULT_SENDGRID_FROM_EMAIL: "noreply@cmbreathe.com",
}));

// The sweep now fans out per active tenant and gates each on the
// `fitter_reengage.dispatcher` flag; force it on so the per-org body runs.
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => true),
}));

// Tenant link base: tests use a synthetic org without a verified custom
// domain row — pin the platform fallback so the sweep still exercises
// the send path (production skips non-seed orgs without a domain).
vi.mock("../../lib/tenant-branding", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/tenant-branding")>();
  return {
    ...actual,
    resolveTenantLinkBaseUrl: vi.fn(
      async (_orgId: string, platformFallback: string) =>
        platformFallback.replace(/\/$/, ""),
    ),
  };
});

import {
  composeReengageEmail,
  readReengageMessagingConfig,
  runFitterLeadReengageSweep,
} from "./fitter-lead-reengage";

const FULL_CFG = {
  sendgridApiKey: "SG.fake",
  sendgridFromEmail: "info@pennpaps.example",
  sendgridFromName: "Penn Home Medical Supply",
  practiceName: "Penn Home Medical Supply",
  publicBaseUrl: "https://pennfit.example",
};

beforeEach(() => {
  sendEmailMock.mockClear();
  supabaseMock.reset();
  // Fan-out reads `organizations`; stage a single active org so the
  // per-tenant cases behave as the prior one-tenant sweep.
  stageSupabaseResponse("organizations", "select", {
    data: [{ id: "00000000-0000-4000-8000-000000000001" }],
  });
});

describe("composeReengageEmail", () => {
  it("includes the practice name in the subject + body", () => {
    const out = composeReengageEmail({
      practiceName: "Foo DME",
      publicBaseUrl: "https://example.test",
    });
    expect(out.subject).toBe("Finish your mask fitting with Foo DME");
    expect(out.text).toContain("Foo DME");
    expect(out.html).toContain("Foo DME");
  });

  it("links back to /consent on the public base URL", () => {
    const out = composeReengageEmail({
      practiceName: "Penn Home Medical Supply",
      publicBaseUrl: "https://pennfit.example",
    });
    expect(out.text).toContain("https://pennfit.example/consent");
    expect(out.html).toContain('href="https://pennfit.example/consent"');
  });

  it("escapes user-controlled practice name in HTML", () => {
    const out = composeReengageEmail({
      practiceName: "<script>x</script>",
      publicBaseUrl: "https://x",
    });
    // Tag should not appear unescaped anywhere in the html
    expect(out.html).not.toContain("<script>x</script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

describe("runFitterLeadReengageSweep", () => {
  it("exits cleanly when SendGrid creds are missing", async () => {
    const stats = await runFitterLeadReengageSweep({
      sendgridApiKey: null,
      sendgridFromEmail: "info@example.test",
      sendgridFromName: null,
      publicBaseUrl: "https://example.test",
    });
    expect(stats).toEqual({
      scanned: 0,
      emailed: 0,
      skippedConverted: 0,
      skippedNoConfig: 1,
      skippedAlreadyClaimed: 0,
      errors: 0,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("emails an eligible lead and stamps nudged_at", async () => {
    // Eligibility scan — one row.
    stageSupabaseResponse("fitter_leads", "select", {
      data: [
        {
          id: "fl_1",
          email: "alice@example.com",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    // Conversion check — alice has not ordered.
    stageSupabaseResponse("orders", "select", { data: [] });
    // Atomic claim: returning a non-empty array means the conditional
    // UPDATE matched and "won" the claim. An empty array (or null)
    // would mean another worker already stamped nudged_at — exactly
    // the skippedAlreadyClaimed branch we DON'T want here.
    stageSupabaseResponse("fitter_leads", "update", {
      data: [{ id: "fl_1" }],
    });

    const stats = await runFitterLeadReengageSweep(FULL_CFG);

    expect(stats).toMatchObject({
      scanned: 1,
      emailed: 1,
      skippedConverted: 0,
      errors: 0,
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const firstCall = sendEmailMock.mock.calls[0] as unknown as [
      { to: string },
    ];
    const sentTo = firstCall[0].to;
    expect(sentTo).toBe("alice@example.com");

    const updates = getSupabaseWritePayloads("fitter_leads", "update");
    expect(updates).toHaveLength(1);
    const u = updates[0] as { nudged_at?: string };
    expect(typeof u.nudged_at).toBe("string");
  });

  it("skips leads whose email already converted to an order", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      data: [
        {
          id: "fl_2",
          email: "bob@example.com",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "fl_3",
          email: "carol@example.com",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    // Bob already ordered; carol did not.
    stageSupabaseResponse("orders", "select", {
      data: [{ patient_email: "bob@example.com" }],
    });
    // Only carol reaches the claim step; the response represents
    // the row returned by `UPDATE ... .select()` after a successful
    // conditional update.
    stageSupabaseResponse("fitter_leads", "update", {
      data: [{ id: "fl_3" }],
    });

    const stats = await runFitterLeadReengageSweep(FULL_CFG);

    expect(stats).toMatchObject({
      scanned: 2,
      emailed: 1,
      skippedConverted: 1,
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const firstCall = sendEmailMock.mock.calls[0] as unknown as [
      { to: string },
    ];
    const sentTo = firstCall[0].to;
    expect(sentTo).toBe("carol@example.com");
  });

  it("skips leads that a concurrent worker already claimed", async () => {
    // Two workers can run the sweep in overlapping windows. The
    // `update(...).is("nudged_at", null).select()` claim is the
    // serialization point: only the first worker's conditional
    // UPDATE matches, the second sees zero rows returned. This
    // branch increments `skippedAlreadyClaimed` and MUST NOT send.
    stageSupabaseResponse("fitter_leads", "select", {
      data: [
        {
          id: "fl_race",
          email: "race@example.com",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("orders", "select", { data: [] });
    // Empty array = the conditional UPDATE matched zero rows, i.e.
    // another worker already stamped `nudged_at`.
    stageSupabaseResponse("fitter_leads", "update", { data: [] });

    const stats = await runFitterLeadReengageSweep(FULL_CFG);

    expect(stats).toMatchObject({
      scanned: 1,
      emailed: 0,
      skippedAlreadyClaimed: 1,
      errors: 0,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns early with scanned=0 when no leads match", async () => {
    stageSupabaseResponse("fitter_leads", "select", { data: [] });
    const stats = await runFitterLeadReengageSweep(FULL_CFG);
    expect(stats).toMatchObject({ scanned: 0, emailed: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("excludes leads that already completed the fitter (owned by the supply campaign)", async () => {
    // The eligibility scan must filter on `completed_at IS NULL`.
    // A completed lead is enrolled in the multi-touch supply campaign;
    // sending it this "you didn't finish" nudge would contradict that
    // cadence. We can't make the in-memory mock evaluate the predicate
    // (filtering is DB-side), so we assert the worker applies the
    // filter — the closest behavioural check available.
    stageSupabaseResponse("fitter_leads", "select", { data: [] });
    await runFitterLeadReengageSweep(FULL_CFG);
    const filters = getSupabaseFilterCalls("fitter_leads", "select");
    expect(filters).toContainEqual({
      verb: "is",
      args: ["completed_at", null],
    });
    // Sanity: the existing opt-in + unnudged predicates are still applied.
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["marketing_opt_in", true],
    });
    expect(filters).toContainEqual({ verb: "is", args: ["nudged_at", null] });
  });

  it("excludes unsubscribed leads even when marketing_opt_in is still true", async () => {
    // The admin force-unsubscribe and the signed unsubscribe link both
    // stamp unsubscribed_at WITHOUT flipping marketing_opt_in (the
    // original consent record stays intact). The re-engage email must
    // honour the stop request, not the stale opt-in.
    stageSupabaseResponse("fitter_leads", "select", { data: [] });
    await runFitterLeadReengageSweep(FULL_CFG);
    const filters = getSupabaseFilterCalls("fitter_leads", "select");
    expect(filters).toContainEqual({
      verb: "is",
      args: ["unsubscribed_at", null],
    });
  });

  it("counts a send failure as errors AND stamps the row to prevent retry storm", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      data: [
        {
          id: "fl_4",
          email: "dave@example.com",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("orders", "select", { data: [] });
    stageSupabaseResponse("fitter_leads", "update", {
      data: [{ id: "fl_4" }],
    });
    sendEmailMock.mockRejectedValueOnce(new Error("sendgrid 5xx"));

    const stats = await runFitterLeadReengageSweep(FULL_CFG);

    expect(stats).toMatchObject({
      scanned: 1,
      emailed: 0,
      errors: 1,
    });
    // Stamp happens regardless of send outcome. Without this, a
    // permanently-bad address (or a SendGrid 5xx for a specific
    // recipient) would re-fire every day for ~27 days until the row
    // aged out of the 30-day window. Policy is one attempt per
    // session — spam-side failure is preferable to spam-side success.
    const updates = getSupabaseWritePayloads("fitter_leads", "update");
    expect(updates).toHaveLength(1);
    const u = updates[0] as { nudged_at?: string };
    expect(typeof u.nudged_at).toBe("string");
  });

  it("processes remaining leads after one send failure (sweep is not halted)", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      data: [
        {
          id: "fl_5",
          email: "err@example.com",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "fl_6",
          email: "ok@example.com",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
    });
    stageSupabaseResponse("orders", "select", { data: [] });
    // First send fails; second succeeds.
    sendEmailMock.mockRejectedValueOnce(new Error("sendgrid transient"));
    // Both leads win their atomic claim — staged in the order the
    // sweep processes them.
    stageSupabaseResponse("fitter_leads", "update", {
      data: [{ id: "fl_5" }],
    });
    stageSupabaseResponse("fitter_leads", "update", {
      data: [{ id: "fl_6" }],
    });

    const stats = await runFitterLeadReengageSweep(FULL_CFG);

    expect(stats).toMatchObject({
      scanned: 2,
      emailed: 1,
      errors: 1,
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    // Each scanned lead gets a nudged_at stamp, regardless of send outcome.
    expect(getSupabaseWritePayloads("fitter_leads", "update")).toHaveLength(2);
  });

  it("skips the run when publicBaseUrl is an empty string", async () => {
    const stats = await runFitterLeadReengageSweep({
      ...FULL_CFG,
      publicBaseUrl: "",
    });
    expect(stats.skippedNoConfig).toBe(1);
    expect(stats.scanned).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("scans each active tenant's leads (multi-tenant fan-out)", async () => {
    supabaseMock.reset();
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's lead scan comes back empty → nothing sent.
    stageSupabaseResponse("fitter_leads", "select", { data: [] });
    stageSupabaseResponse("fitter_leads", "select", { data: [] });

    const stats = await runFitterLeadReengageSweep(FULL_CFG);
    expect(stats.scanned).toBe(0);
    expect(stats.emailed).toBe(0);
    // Each active tenant ran its own lead scan.
    expect(getSupabaseCallCount("fitter_leads", "select")).toBe(2);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("composeReengageEmail — HTML escaping", () => {
  it("escapes ampersands in the practice name", () => {
    const out = composeReengageEmail({
      practiceName: "Penn & Paps",
      publicBaseUrl: "https://x",
    });
    expect(out.html).not.toContain("Penn & Paps");
    expect(out.html).toContain("Penn &amp; Paps");
    // Plain-text version is NOT escaped
    expect(out.text).toContain("Penn & Paps");
  });

  it("escapes double-quotes in the practice name", () => {
    const out = composeReengageEmail({
      practiceName: 'A "CPAP" Clinic',
      publicBaseUrl: "https://x",
    });
    expect(out.html).not.toContain('"CPAP"');
    expect(out.html).toContain("&quot;CPAP&quot;");
  });
});

describe("readReengageMessagingConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads all expected env vars", () => {
    vi.stubEnv("SENDGRID_API_KEY", "SG.testkey");
    vi.stubEnv("SENDGRID_FROM_EMAIL", "from@example.com");
    vi.stubEnv("SENDGRID_FROM_NAME", "Test Sender");
    vi.stubEnv("RESUPPLY_VOICE_PUBLIC_BASE_URL", "https://test.example");

    const cfg = readReengageMessagingConfig(process.env);
    expect(cfg.sendgridApiKey).toBe("SG.testkey");
    expect(cfg.sendgridFromEmail).toBe("from@example.com");
    expect(cfg.sendgridFromName).toBe("Test Sender");
    expect(cfg.publicBaseUrl).toBe("https://test.example");
  });

  it("carries no practice name — the brand is resolved per tenant", () => {
    const cfg = readReengageMessagingConfig({
      SENDGRID_API_KEY: "SG.x",
      SENDGRID_FROM_EMAIL: "f@x.com",
      SENDGRID_FROM_NAME: "X",
      RESUPPLY_PRACTICE_NAME: "Seed Tenant Practice",
      RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://x.example",
    });
    // RESUPPLY_PRACTICE_NAME is folded to the SEED tenant's name at boot, so
    // a process-global read here brands every tenant's re-engagement email
    // as the seed. The env config must not carry a name at all; the per-org
    // sweep resolves the sweeping tenant's own brand.
    expect(cfg).not.toHaveProperty("practiceName");
  });

  it("falls back to RAILWAY_PUBLIC_DOMAIN when RESUPPLY_VOICE_PUBLIC_BASE_URL is absent", () => {
    const cfg = readReengageMessagingConfig({
      SENDGRID_API_KEY: "SG.x",
      SENDGRID_FROM_EMAIL: "f@x.com",
      SENDGRID_FROM_NAME: "X",
      RAILWAY_PUBLIC_DOMAIN: "pennfit.up.railway.app",
    });
    expect(cfg.publicBaseUrl).toBe("https://pennfit.up.railway.app");
  });

  it("returns null for credentials that are not in env", () => {
    const cfg = readReengageMessagingConfig({});
    expect(cfg.sendgridApiKey).toBeNull();
    // From address always resolves to the platform default — it is no
    // longer gated on the env var being set.
    expect(cfg.sendgridFromEmail).toBe("noreply@cmbreathe.com");
    expect(cfg.sendgridFromName).toBeNull();
    expect(cfg.publicBaseUrl).toBe("");
  });
});
