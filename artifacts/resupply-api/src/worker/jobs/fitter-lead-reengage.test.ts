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
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const sendEmailMock = vi.fn(async () => undefined);
vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: () => ({
    sendEmail: sendEmailMock,
  }),
}));

import {
  composeReengageEmail,
  readReengageMessagingConfig,
  runFitterLeadReengageSweep,
} from "./fitter-lead-reengage";

const FULL_CFG = {
  sendgridApiKey: "SG.fake",
  sendgridFromEmail: "info@pennpaps.example",
  sendgridFromName: "PennPaps",
  practiceName: "PennPaps",
  publicBaseUrl: "https://pennfit.example",
};

beforeEach(() => {
  sendEmailMock.mockClear();
  supabaseMock.reset();
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
      practiceName: "PennPaps",
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
      sendgridFromEmail: null,
      sendgridFromName: null,
      practiceName: "PennPaps",
      publicBaseUrl: "https://pennfit.example",
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
    vi.stubEnv("RESUPPLY_PRACTICE_NAME", "Test Practice");
    vi.stubEnv("RESUPPLY_VOICE_PUBLIC_BASE_URL", "https://test.example");

    const cfg = readReengageMessagingConfig(process.env);
    expect(cfg.sendgridApiKey).toBe("SG.testkey");
    expect(cfg.sendgridFromEmail).toBe("from@example.com");
    expect(cfg.sendgridFromName).toBe("Test Sender");
    expect(cfg.practiceName).toBe("Test Practice");
    expect(cfg.publicBaseUrl).toBe("https://test.example");
  });

  it("falls back to 'PennPaps' when RESUPPLY_PRACTICE_NAME is not set", () => {
    const cfg = readReengageMessagingConfig({
      SENDGRID_API_KEY: "SG.x",
      SENDGRID_FROM_EMAIL: "f@x.com",
      SENDGRID_FROM_NAME: "X",
      RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://x.example",
    });
    expect(cfg.practiceName).toBe("PennPaps");
  });

  it("falls back to REPLIT_DEV_DOMAIN when RESUPPLY_VOICE_PUBLIC_BASE_URL is absent", () => {
    const cfg = readReengageMessagingConfig({
      SENDGRID_API_KEY: "SG.x",
      SENDGRID_FROM_EMAIL: "f@x.com",
      SENDGRID_FROM_NAME: "X",
      REPLIT_DEV_DOMAIN: "my-repl.repl.co",
    });
    expect(cfg.publicBaseUrl).toBe("https://my-repl.repl.co");
  });

  it("returns null for credentials that are not in env", () => {
    const cfg = readReengageMessagingConfig({});
    expect(cfg.sendgridApiKey).toBeNull();
    expect(cfg.sendgridFromEmail).toBeNull();
    expect(cfg.sendgridFromName).toBeNull();
    expect(cfg.publicBaseUrl).toBe("");
  });
});
