// Tests for the abandoned-fitter re-engagement dispatcher.
//
// Covers the pure compose helper plus the sweep's three branches:
//   * no SendGrid config — log + exit cleanly, no DB writes.
//   * happy path — eligible lead becomes one sendEmail call plus
//     one `nudged_at` stamp.
//   * converted skip — a lead whose email already appears in
//     public.orders is left untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
    // Stamp update.
    stageSupabaseResponse("fitter_leads", "update", { data: null });

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
    stageSupabaseResponse("fitter_leads", "update", { data: null });

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
    stageSupabaseResponse("fitter_leads", "update", { data: null });
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
});
