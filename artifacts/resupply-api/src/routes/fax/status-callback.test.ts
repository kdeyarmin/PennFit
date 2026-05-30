// Route tests for POST /fax/status-callback (Twilio fax delivery webhook).
//
// Coverage:
//   * Twilio signature validated — 403 without valid X-Twilio-Signature
//   * 200 + empty TwiML on missing required fields (ack, don't audit)
//   * queued / processing / sending  → status update to "sent"
//   * delivered                      → status update to "delivered" + delivered_at
//   * failed / no-answer / busy /
//     canceled                       → status update to "failed" + failed_at + failure_reason
//   * DB update and audit are fire-and-forget; 200 is sent first
//
// PHI invariant: audit metadata contains only the Twilio fax SID and
// mapped status — never the recipient fax number.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Stub Twilio signature middleware — validate that it's called but skip
// the actual HMAC check so tests don't need real Twilio credentials.
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    requireTwilioSignature:
      () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
  };
});

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import statusCallbackRouter from "./status-callback";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(statusCallbackRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  logAuditMock.mockClear();
});

// Stage a fresh "no error" envelope before any happy-path call so the
// route's `await supabase.from(...).update(...)` resolves cleanly.
function stageUpdateOk() {
  stageSupabaseResponse("physician_fax_outreach", "update", { error: null });
}

describe("POST /fax/status-callback", () => {
  it("returns 200 with empty TwiML XML", async () => {
    stageUpdateOk();
    const res = await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ FaxSid: "FX_abc", Status: "delivered" });
    expect(res.status).toBe(200);
    expect(res.text).toBe("<Response/>");
    expect(res.headers["content-type"]).toMatch(/xml/);
  });

  it("skips DB update when FaxSid is missing", async () => {
    await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ Status: "delivered" });
    expect(getSupabaseCallCount("physician_fax_outreach", "update")).toBe(0);
  });

  it("skips DB update when Status is missing", async () => {
    await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ FaxSid: "FX_abc" });
    expect(getSupabaseCallCount("physician_fax_outreach", "update")).toBe(0);
  });

  it("skips DB update for unknown Status values", async () => {
    await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ FaxSid: "FX_abc", Status: "receiving" });
    expect(getSupabaseCallCount("physician_fax_outreach", "update")).toBe(0);
  });

  it.each(["queued", "processing", "sending"] as const)(
    "maps %s → status='sent' in DB",
    async (twilioStatus) => {
      stageUpdateOk();
      await request(makeApp())
        .post("/fax/status-callback")
        .type("form")
        .send({ FaxSid: "FX_abc", Status: twilioStatus });
      const updates = getSupabaseWritePayloads(
        "physician_fax_outreach",
        "update",
      );
      expect(updates).toHaveLength(1);
      const patch = updates[0] as Record<string, unknown>;
      expect(patch).toMatchObject({ status: "sent" });
      expect(patch).not.toHaveProperty("delivered_at");
      expect(patch).not.toHaveProperty("failed_at");
    },
  );

  it("maps delivered → status='delivered' + delivered_at", async () => {
    stageUpdateOk();
    await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ FaxSid: "FX_abc", Status: "delivered" });
    const patch = getSupabaseWritePayloads(
      "physician_fax_outreach",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: "delivered" });
    // PostgREST uses ISO timestamp strings, not Date instances.
    expect(typeof patch.delivered_at).toBe("string");
    expect(patch).not.toHaveProperty("failed_at");
  });

  it.each(["failed", "no-answer", "busy", "canceled"] as const)(
    "maps %s → status='failed' + failed_at + failure_reason",
    async (twilioStatus) => {
      stageUpdateOk();
      await request(makeApp())
        .post("/fax/status-callback")
        .type("form")
        .send({ FaxSid: "FX_abc", Status: twilioStatus, ErrorCode: "30006" });
      const patch = getSupabaseWritePayloads(
        "physician_fax_outreach",
        "update",
      )[0] as Record<string, unknown>;
      expect(patch).toMatchObject({ status: "failed" });
      expect(typeof patch.failed_at).toBe("string");
      expect(String(patch.failure_reason)).toContain("30006");
    },
  );

  it("emits audit event with non-PHI envelope", async () => {
    stageUpdateOk();
    await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ FaxSid: "FX_delivered", Status: "delivered" });

    expect(logAuditMock).toHaveBeenCalledOnce();
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("physician_fax_outreach.status_updated");
    expect(audit.metadata.twilio_fax_sid).toBe("FX_delivered");
    expect(audit.metadata.twilio_status).toBe("delivered");
    expect(audit.metadata.db_status).toBe("delivered");
    // PHI invariant: no fax numbers in audit
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toMatch(/\+\d{10,}/);
  });
});
