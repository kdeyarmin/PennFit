import { describe, expect, it, beforeEach } from "vitest";

import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { publishEvent } from "./publisher";

describe("publishEvent", () => {
  beforeEach(() => supabaseMock.reset());

  it("inserts one delivery row per matching active subscription", async () => {
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: [
        { id: "sub-1", event_types: ["claim.paid", "claim.denied"] },
        { id: "sub-2", event_types: ["*"] },
        { id: "sub-3", event_types: ["era.ingested"] },
      ],
    });
    stageSupabaseResponse("webhook_deliveries", "insert", { data: { id: "d1" } });
    await publishEvent({
      eventType: "claim.paid",
      payload: { claim_id: "c-1", amount_cents: 12500 },
    });
    const writes = getSupabaseWritePayloads("webhook_deliveries", "insert");
    expect(writes).toHaveLength(1);
    const rows = writes[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2); // sub-1 (claim.paid) + sub-2 (*) — NOT sub-3
    const subIds = rows.map((r) => r.subscription_id).sort();
    expect(subIds).toEqual(["sub-1", "sub-2"]);
    for (const row of rows) {
      const payload = row.event_payload as { type: string; data: Record<string, unknown> };
      expect(payload.type).toBe("claim.paid");
      expect(payload.data.claim_id).toBe("c-1");
    }
  });

  it("does NOT insert anything when no subscriptions match", async () => {
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: [{ id: "sub-1", event_types: ["era.ingested"] }],
    });
    await publishEvent({
      eventType: "claim.paid",
      payload: { claim_id: "c-1" },
    });
    expect(
      getSupabaseWritePayloads("webhook_deliveries", "insert"),
    ).toEqual([]);
  });

  it("does NOT throw when supabase select returns an error", async () => {
    stageSupabaseResponse("webhook_subscriptions", "select", {
      data: null,
      error: { message: "boom" },
    });
    // Should be a no-op + suppressed (lib spec).
    await expect(
      publishEvent({ eventType: "claim.paid", payload: {} }),
    ).resolves.toBeUndefined();
  });
});
