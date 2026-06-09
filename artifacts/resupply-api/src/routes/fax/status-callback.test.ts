// Route tests for the Telnyx fax delivery handler
// (faxStatusCallbackHandler).
//
// Coverage:
//   * 200 JSON ACK on every request (Telnyx retries non-2xx)
//   * Missing fax_id → no DB update
//   * Unmapped event types (fax.received / unknown) → no DB update
//   * fax.queued / fax.media.processed / fax.sending.started → "sent"
//   * fax.delivered → "delivered" + delivered_at
//   * fax.failed → "failed" + failed_at + failure_reason
//   * Audit emits only the fax id + event/status (no fax numbers)
//
// The Ed25519 signature middleware is exercised separately; here we
// mount the handler directly with express.json.
//
// PHI invariant: audit metadata contains only the Telnyx fax id and
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

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import { faxStatusCallbackHandler } from "./status-callback";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.post("/fax/status-callback", faxStatusCallbackHandler);
  return app;
}

/** Build a wrapped Telnyx outbound fax event. */
function faxEvent(eventType: string, payload: Record<string, unknown>) {
  return { data: { event_type: eventType, payload } };
}

beforeEach(() => {
  supabaseMock.reset();
  logAuditMock.mockClear();
});

function stageUpdateOk() {
  stageSupabaseResponse("physician_fax_outreach", "update", { error: null });
}

describe("POST /fax/status-callback", () => {
  it("returns 200 with a JSON ACK", async () => {
    stageUpdateOk();
    const res = await request(makeApp())
      .post("/fax/status-callback")
      .send(faxEvent("fax.delivered", { fax_id: "fx-abc" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("skips DB update when fax_id is missing", async () => {
    await request(makeApp())
      .post("/fax/status-callback")
      .send(faxEvent("fax.delivered", {}));
    expect(getSupabaseCallCount("physician_fax_outreach", "update")).toBe(0);
  });

  it("skips DB update for unmapped event types", async () => {
    await request(makeApp())
      .post("/fax/status-callback")
      .send(faxEvent("fax.received", { fax_id: "fx-abc" }));
    expect(getSupabaseCallCount("physician_fax_outreach", "update")).toBe(0);
  });

  it.each([
    "fax.queued",
    "fax.media.processed",
    "fax.sending.started",
  ] as const)("maps %s → status='sent' in DB", async (eventType) => {
    stageUpdateOk();
    await request(makeApp())
      .post("/fax/status-callback")
      .send(faxEvent(eventType, { fax_id: "fx-abc" }));
    const updates = getSupabaseWritePayloads(
      "physician_fax_outreach",
      "update",
    );
    expect(updates).toHaveLength(1);
    const patch = updates[0] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: "sent" });
    expect(patch).not.toHaveProperty("delivered_at");
    expect(patch).not.toHaveProperty("failed_at");
  });

  it("maps fax.delivered → status='delivered' + delivered_at", async () => {
    stageUpdateOk();
    await request(makeApp())
      .post("/fax/status-callback")
      .send(faxEvent("fax.delivered", { fax_id: "fx-abc" }));
    const patch = getSupabaseWritePayloads(
      "physician_fax_outreach",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: "delivered" });
    expect(typeof patch.delivered_at).toBe("string");
    expect(patch).not.toHaveProperty("failed_at");
  });

  it("maps fax.failed → status='failed' + failed_at + failure_reason", async () => {
    stageUpdateOk();
    await request(makeApp())
      .post("/fax/status-callback")
      .send(
        faxEvent("fax.failed", {
          fax_id: "fx-abc",
          failure_reason: "user_busy",
        }),
      );
    const patch = getSupabaseWritePayloads(
      "physician_fax_outreach",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: "failed" });
    expect(typeof patch.failed_at).toBe("string");
    expect(String(patch.failure_reason)).toContain("user_busy");
  });

  it("emits an audit event with a non-PHI envelope", async () => {
    stageUpdateOk();
    await request(makeApp())
      .post("/fax/status-callback")
      .send(
        faxEvent("fax.delivered", {
          fax_id: "fx-delivered",
          to: "+15551230000",
        }),
      );

    expect(logAuditMock).toHaveBeenCalledOnce();
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("physician_fax_outreach.status_updated");
    expect(audit.metadata.fax_id).toBe("fx-delivered");
    expect(audit.metadata.telnyx_event_type).toBe("fax.delivered");
    expect(audit.metadata.db_status).toBe("delivered");
    // PHI invariant: no fax numbers in audit
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toMatch(/\+\d{10,}/);
  });
});
