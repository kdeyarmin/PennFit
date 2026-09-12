import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSupabaseFilterCalls,
  installSupabaseMock,
  stageSupabaseResponse as stage,
} from "../../test-helpers/supabase-mock";

const db = installSupabaseMock();
const close = vi.hoisted(() => vi.fn(async () => ({ closed: true })));
vi.mock("../episodes/close-episode", () => ({ closeEpisode: close }));
vi.mock("../episodes/open-outreach-episode", () => ({
  openOutreachEpisode: vi.fn(),
}));
vi.mock("../episodes/reanchor-due-at", () => ({
  reanchorEpisodeDueAt: vi.fn(),
}));
import { recordShipmentEvidence } from "./record-shipment-evidence";

const input = {
  orgId: "org-a",
  fulfillmentId: "fill-a",
  shippedAt: new Date("2026-09-08T12:00:00Z"),
  source: "admin_manual" as const,
};
const queued = {
  id: input.fulfillmentId,
  patient_id: "patient-a",
  episode_id: "episode-a",
  status: "queued",
  shipped_at: null,
  item_sku: "MASK-M",
  pacware_order_ref: null,
};

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
});

describe("shipment evidence under concurrent updates", () => {
  it("does not resurrect a cancellation that wins after the initial read", async () => {
    stage("fulfillments", "select", { data: queued });
    // The cancellation commits after the read, before the conditional write.
    stage("fulfillments", "update", { data: [] });
    stage("fulfillments", "select", {
      data: { status: "cancelled", shipped_at: null },
    });
    const result = await recordShipmentEvidence(input);
    expect(result.status).toBe("not_shippable");
    expect(close).not.toHaveBeenCalled();
    expect(getSupabaseFilterCalls("fulfillments", "update")).toEqual(
      expect.arrayContaining([
        { verb: "eq", args: ["org_id", "org-a"] },
        { verb: "is", args: ["shipped_at", null] },
        { verb: "neq", args: ["status", "cancelled"] },
      ]),
    );
  });

  it("repairs a prior shipment using its stored date after losing the claim", async () => {
    stage("fulfillments", "select", { data: queued });
    stage("fulfillments", "update", { data: [] });
    stage("fulfillments", "select", {
      data: { status: "shipped", shipped_at: "2026-09-07T12:00:00Z" },
    });
    const result = await recordShipmentEvidence(input);
    expect(result.status).toBe("already_recorded");
    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ at: new Date("2026-09-07T12:00:00Z") }),
    );
  });

  it("returns not found when the fulfillment disappears before the claim", async () => {
    stage("fulfillments", "select", { data: queued });
    stage("fulfillments", "update", { data: [] });
    stage("fulfillments", "select", { data: null });
    expect((await recordShipmentEvidence(input)).status).toBe("not_found");
    expect(close).not.toHaveBeenCalled();
  });

  it("surfaces a failed reread so a shipment can be retried", async () => {
    stage("fulfillments", "select", { data: queued });
    stage("fulfillments", "update", { data: [] });
    stage("fulfillments", "select", { error: new Error("offline") });
    await expect(recordShipmentEvidence(input)).rejects.toThrow("offline");
    expect(close).not.toHaveBeenCalled();
  });
});
