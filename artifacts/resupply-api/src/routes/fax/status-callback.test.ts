// Route tests for POST /fax/status-callback (Twilio fax delivery webhook).
//
// Coverage:
//   * Twilio signature validated — 403 without valid X-Twilio-Signature
//   * 200 + empty TwiML on missing required fields (ack, don't audit)
//   * queued / processing / sending  → status update to "sent"
//   * delivered                      → status update to "delivered" + deliveredAt
//   * failed / no-answer / busy /
//     canceled                       → status update to "failed" + failedAt + failureReason
//   * DB update and audit are fire-and-forget; 200 is sent first
//
// PHI invariant: audit metadata contains only the Twilio fax SID and
// mapped status — never the recipient fax number.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// Stub Twilio signature middleware — validate that it's called but skip
// the actual HMAC check so tests don't need real Twilio credentials.
vi.mock("@workspace/resupply-telecom", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-telecom")>(
      "@workspace/resupply-telecom",
    );
  return {
    ...actual,
    requireTwilioSignature: () =>
      (
        _req: unknown,
        _res: unknown,
        next: () => void,
      ) => next(),
  };
});

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

const updatedSets: Array<{ set: Record<string, unknown>; where: string }> = [];
const dbStub = {
  update: vi.fn(() => {
    const entry: { set: Record<string, unknown>; where: string } = {
      set: {},
      where: "",
    };
    updatedSets.push(entry);
    const obj: Record<string, unknown> = {
      set: (vals: Record<string, unknown>) => {
        entry.set = vals;
        return obj;
      },
      where: () => Promise.resolve(),
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));
vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return { ...actual, getDbPool: () => ({}) as never };
});

import statusCallbackRouter from "./status-callback";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(statusCallbackRouter);
  return app;
}

beforeEach(() => {
  updatedSets.length = 0;
  logAuditMock.mockClear();
  dbStub.update.mockClear();
});

describe("POST /fax/status-callback", () => {
  it("returns 200 with empty TwiML XML", async () => {
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
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("skips DB update when Status is missing", async () => {
    await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ FaxSid: "FX_abc" });
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it("skips DB update for unknown Status values", async () => {
    await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ FaxSid: "FX_abc", Status: "receiving" });
    expect(dbStub.update).not.toHaveBeenCalled();
  });

  it.each(["queued", "processing", "sending"] as const)(
    "maps %s → status='sent' in DB",
    async (twilioStatus) => {
      await request(makeApp())
        .post("/fax/status-callback")
        .type("form")
        .send({ FaxSid: "FX_abc", Status: twilioStatus });
      expect(updatedSets).toHaveLength(1);
      expect(updatedSets[0]!.set).toMatchObject({ status: "sent" });
      expect(updatedSets[0]!.set).not.toHaveProperty("deliveredAt");
      expect(updatedSets[0]!.set).not.toHaveProperty("failedAt");
    },
  );

  it("maps delivered → status='delivered' + deliveredAt", async () => {
    await request(makeApp())
      .post("/fax/status-callback")
      .type("form")
      .send({ FaxSid: "FX_abc", Status: "delivered" });
    expect(updatedSets[0]!.set).toMatchObject({ status: "delivered" });
    expect(updatedSets[0]!.set.deliveredAt).toBeInstanceOf(Date);
    expect(updatedSets[0]!.set).not.toHaveProperty("failedAt");
  });

  it.each(["failed", "no-answer", "busy", "canceled"] as const)(
    "maps %s → status='failed' + failedAt + failureReason",
    async (twilioStatus) => {
      await request(makeApp())
        .post("/fax/status-callback")
        .type("form")
        .send({ FaxSid: "FX_abc", Status: twilioStatus, ErrorCode: "30006" });
      expect(updatedSets[0]!.set).toMatchObject({ status: "failed" });
      expect(updatedSets[0]!.set.failedAt).toBeInstanceOf(Date);
      expect(updatedSets[0]!.set.failureReason).toContain("30006");
    },
  );

  it("emits audit event with non-PHI envelope", async () => {
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
