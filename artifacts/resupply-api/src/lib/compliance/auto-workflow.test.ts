import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// audit_log writes go through the HMAC-chain logAudit() helper, which
// needs an HMAC key at module load. Stub it before importing.
process.env.RESUPPLY_AUDIT_HMAC_KEY ??=
  "OTYxYjFkM2VlNzhmYzFhM2EwZjI0OTU5ZTI3ZjU2YzNkZTQ0OWE5OQ==";

import { runComplianceWorkflowPass } from "./auto-workflow";

function todayPlusDays(days: number): string {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

describe("runComplianceWorkflowPass — BAA expiry pass", () => {
  beforeEach(() => supabaseMock.reset());
  afterEach(() => vi.restoreAllMocks());

  it("publishes baa_expiring_soon for BAAs expiring within 60 days (cooldown clear)", async () => {
    stageSupabaseResponse("business_associate_agreements", "select", {
      data: [
        {
          id: "baa-1",
          vendor_slug: "office-ally",
          vendor_kind: "clearinghouse",
          agreement_expires_on: todayPlusDays(30),
          status: "active",
        },
      ],
    });
    // OIG pass: pretend a recent screen exists so it short-circuits.
    stageSupabaseResponse("oig_leie_screenings", "select", {
      data: [{ id: "s-1" }],
    });
    // Rights pass: no overdue rows.
    stageSupabaseResponse("patient_rights_requests", "select", { data: [] });
    // Cooldown gate: no prior row for this BAA.
    stageSupabaseResponse("audit_log", "select", { data: [] });
    // Webhook subscription resolution returns one *-subscriber.
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: [{ id: "sub-1", event_types: ["*"] }],
    });
    stageSupabaseResponse("webhook_deliveries", "insert", {
      data: { id: "d-1" },
    });
    // logAudit chain reads tip.
    stageSupabaseResponse("audit_log", "select", { data: [] });
    stageSupabaseResponse("audit_log", "insert", { data: { id: "a-1" } });

    const stats = await runComplianceWorkflowPass();
    expect(stats.baaExpiringPublished).toBe(1);
    expect(stats.baaExpiredPublished).toBe(0);

    const writes = getSupabaseWritePayloads("webhook_deliveries", "insert");
    expect(writes).toHaveLength(1);
    const rows = writes[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const payload = rows[0]?.event_payload as {
      type: string;
      data: Record<string, unknown>;
    };
    expect(payload.type).toBe("compliance.baa_expiring_soon");
    expect(payload.data.baa_id).toBe("baa-1");
    expect(payload.data.vendor_slug).toBe("office-ally");
  });

  it("emits baa_expired (not expiring_soon) for past-due BAAs", async () => {
    stageSupabaseResponse("business_associate_agreements", "select", {
      data: [
        {
          id: "baa-old",
          vendor_slug: "stripe",
          vendor_kind: "payment_processor",
          agreement_expires_on: todayPlusDays(-7),
          status: "active",
        },
      ],
    });
    stageSupabaseResponse("oig_leie_screenings", "select", {
      data: [{ id: "s-1" }],
    });
    stageSupabaseResponse("patient_rights_requests", "select", { data: [] });
    stageSupabaseResponse("audit_log", "select", { data: [] });
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: [{ id: "sub-1", event_types: ["*"] }],
    });
    stageSupabaseResponse("webhook_deliveries", "insert", { data: {} });
    stageSupabaseResponse("audit_log", "select", { data: [] });
    stageSupabaseResponse("audit_log", "insert", { data: { id: "a-1" } });

    const stats = await runComplianceWorkflowPass();
    expect(stats.baaExpiredPublished).toBe(1);
    expect(stats.baaExpiringPublished).toBe(0);

    const writes = getSupabaseWritePayloads("webhook_deliveries", "insert");
    const payload = (writes[0] as Array<Record<string, unknown>>)[0]
      ?.event_payload as { type: string };
    expect(payload.type).toBe("compliance.baa_expired");
  });

  it("skips when audit_log shows a recent cooldown row", async () => {
    stageSupabaseResponse("business_associate_agreements", "select", {
      data: [
        {
          id: "baa-1",
          vendor_slug: "office-ally",
          vendor_kind: "clearinghouse",
          agreement_expires_on: todayPlusDays(30),
          status: "active",
        },
      ],
    });
    // Cooldown gate HIT — prior row exists.
    stageSupabaseResponse("audit_log", "select", {
      data: [{ id: "prior" }],
    });
    stageSupabaseResponse("oig_leie_screenings", "select", {
      data: [{ id: "s-1" }],
    });
    stageSupabaseResponse("patient_rights_requests", "select", { data: [] });

    const stats = await runComplianceWorkflowPass();
    expect(stats.baaExpiringPublished).toBe(0);
    expect(
      getSupabaseWritePayloads("webhook_deliveries", "insert"),
    ).toEqual([]);
  });
});

describe("runComplianceWorkflowPass — OIG overdue pass", () => {
  beforeEach(() => supabaseMock.reset());

  it("publishes oig_screening_overdue when no screening in 35d (cooldown clear)", async () => {
    // BAA pass: no candidates.
    stageSupabaseResponse("business_associate_agreements", "select", {
      data: [],
    });
    // OIG: no recent screening.
    stageSupabaseResponse("oig_leie_screenings", "select", { data: [] });
    // Cooldown clear.
    stageSupabaseResponse("audit_log", "select", { data: [] });
    // Rights pass: empty.
    stageSupabaseResponse("patient_rights_requests", "select", { data: [] });
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: [{ id: "sub-1", event_types: ["*"] }],
    });
    stageSupabaseResponse("webhook_deliveries", "insert", { data: {} });
    stageSupabaseResponse("audit_log", "select", { data: [] });
    stageSupabaseResponse("audit_log", "insert", { data: { id: "a-2" } });

    const stats = await runComplianceWorkflowPass();
    expect(stats.oigOverduePublished).toBe(1);
    const writes = getSupabaseWritePayloads("webhook_deliveries", "insert");
    const payload = (writes[0] as Array<Record<string, unknown>>)[0]
      ?.event_payload as { type: string };
    expect(payload.type).toBe("compliance.oig_screening_overdue");
  });

  it("does nothing when a screening exists inside the window", async () => {
    stageSupabaseResponse("business_associate_agreements", "select", {
      data: [],
    });
    stageSupabaseResponse("oig_leie_screenings", "select", {
      data: [{ id: "s-recent" }],
    });
    stageSupabaseResponse("patient_rights_requests", "select", { data: [] });

    const stats = await runComplianceWorkflowPass();
    expect(stats.oigOverduePublished).toBe(0);
    expect(
      getSupabaseWritePayloads("webhook_deliveries", "insert"),
    ).toEqual([]);
  });
});

describe("runComplianceWorkflowPass — patient rights overdue pass", () => {
  beforeEach(() => supabaseMock.reset());

  it("publishes patient_rights_overdue for unextended requests past 30d", async () => {
    stageSupabaseResponse("business_associate_agreements", "select", {
      data: [],
    });
    stageSupabaseResponse("oig_leie_screenings", "select", {
      data: [{ id: "s-1" }],
    });
    const fortyDaysAgo = new Date(
      Date.now() - 40 * 24 * 3600 * 1000,
    ).toISOString();
    stageSupabaseResponse("patient_rights_requests", "select", {
      data: [
        {
          id: "req-1",
          patient_id: "pat-1",
          request_kind: "access",
          status: "in_review",
          received_at: fortyDaysAgo,
          extension_granted_at: null,
        },
      ],
    });
    // Cooldown clear.
    stageSupabaseResponse("audit_log", "select", { data: [] });
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: [{ id: "sub-1", event_types: ["*"] }],
    });
    stageSupabaseResponse("webhook_deliveries", "insert", { data: {} });
    stageSupabaseResponse("audit_log", "select", { data: [] });
    stageSupabaseResponse("audit_log", "insert", { data: { id: "a-3" } });

    const stats = await runComplianceWorkflowPass();
    expect(stats.rightsOverduePublished).toBe(1);
    const writes = getSupabaseWritePayloads("webhook_deliveries", "insert");
    const payload = (writes[0] as Array<Record<string, unknown>>)[0]
      ?.event_payload as { type: string; data: Record<string, unknown> };
    expect(payload.type).toBe("compliance.patient_rights_overdue");
    expect(payload.data.request_id).toBe("req-1");
    expect(payload.data.patient_id).toBe("pat-1");
    expect(payload.data.extended).toBe(false);
  });

  it("skips extended requests that are still inside the 60d window", async () => {
    stageSupabaseResponse("business_associate_agreements", "select", {
      data: [],
    });
    stageSupabaseResponse("oig_leie_screenings", "select", {
      data: [{ id: "s-1" }],
    });
    const fortyDaysAgo = new Date(
      Date.now() - 40 * 24 * 3600 * 1000,
    ).toISOString();
    stageSupabaseResponse("patient_rights_requests", "select", {
      data: [
        {
          id: "req-ext",
          patient_id: "pat-2",
          request_kind: "amendment",
          status: "extended",
          received_at: fortyDaysAgo,
          extension_granted_at: new Date(
            Date.now() - 5 * 24 * 3600 * 1000,
          ).toISOString(),
        },
      ],
    });

    const stats = await runComplianceWorkflowPass();
    expect(stats.rightsOverduePublished).toBe(0);
  });
});
