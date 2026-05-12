// Tests for runRecallBulkMatch.
//
// Coverage:
//   * No assets match → all counts zero, skippedNonMatchCount = candidates
//   * Match flagging stamps recall_id + status and inserts notifications
//   * Re-run is idempotent (newlyQueued=0 if all already queued)
//   * Throws when recall id is unknown

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { runRecallBulkMatch } from "./recall-bulk-match";

const supabaseMock = installSupabaseMock();

beforeEach(() => {
  supabaseMock.reset();
});

describe("runRecallBulkMatch", () => {
  it("throws when the recall row doesn't exist", async () => {
    stageSupabaseResponse("equipment_recalls", "select", { data: null });
    await expect(
      runRecallBulkMatch(getSupabaseServiceRoleClient(), "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/not found/);
  });

  it("returns zero matches when no candidate satisfies the criteria", async () => {
    stageSupabaseResponse("equipment_recalls", "select", {
      data: {
        id: "r_1",
        manufacturer: "Philips",
        model_match: "DreamStation",
        serial_match: { kind: "range", from: "S100", to: "S200" },
        status: "open",
      },
    });
    stageSupabaseResponse("equipment_assets", "select", {
      data: [
        {
          id: "a_1",
          patient_id: "p_1",
          manufacturer: "Philips",
          model: "AirSense", // wrong model
          serial_number: "S150",
          recall_id: null,
        },
      ],
    });
    const r = await runRecallBulkMatch(getSupabaseServiceRoleClient(), "r_1");
    expect(r.matchedCount).toBe(0);
    expect(r.skippedNonMatchCount).toBe(1);
    expect(r.newlyQueuedCount).toBe(0);
  });

  it("flags matched assets and queues notifications", async () => {
    stageSupabaseResponse("equipment_recalls", "select", {
      data: {
        id: "r_1",
        manufacturer: "Philips",
        model_match: "DreamStation",
        serial_match: { kind: "range", from: "S100", to: "S200" },
        status: "open",
      },
    });
    stageSupabaseResponse("equipment_assets", "select", {
      data: [
        {
          id: "a_match_1",
          patient_id: "p_1",
          manufacturer: "Philips",
          model: "DreamStation",
          serial_number: "S150",
          recall_id: null,
        },
        {
          id: "a_match_2",
          patient_id: "p_2",
          manufacturer: "Philips",
          model: "DreamStation",
          serial_number: "S199",
          recall_id: null,
        },
        {
          id: "a_skip",
          patient_id: "p_3",
          manufacturer: "Philips",
          model: "DreamStation",
          serial_number: "S999", // outside the range
          recall_id: null,
        },
      ],
    });
    // Bulk asset stamp.
    stageSupabaseResponse("equipment_assets", "update", { data: null });
    // No prior notifications for these assets.
    stageSupabaseResponse("recall_notifications", "select", { data: [] });
    // Insert path.
    stageSupabaseResponse("recall_notifications", "insert", {
      data: null,
    });

    const r = await runRecallBulkMatch(getSupabaseServiceRoleClient(), "r_1");
    expect(r.matchedCount).toBe(2);
    expect(r.newlyQueuedCount).toBe(2);
    expect(r.alreadyQueuedCount).toBe(0);
    expect(r.skippedNonMatchCount).toBe(1);
  });

  it("is idempotent — re-run returns alreadyQueued counts", async () => {
    stageSupabaseResponse("equipment_recalls", "select", {
      data: {
        id: "r_1",
        manufacturer: "Philips",
        model_match: null,
        serial_match: null,
        status: "open",
      },
    });
    stageSupabaseResponse("equipment_assets", "select", {
      data: [
        {
          id: "a_1",
          patient_id: "p_1",
          manufacturer: "Philips",
          model: "X",
          serial_number: "S1",
          recall_id: "r_1",
        },
      ],
    });
    stageSupabaseResponse("equipment_assets", "update", { data: null });
    // Notification ALREADY exists.
    stageSupabaseResponse("recall_notifications", "select", {
      data: [{ asset_id: "a_1" }],
    });
    const r = await runRecallBulkMatch(getSupabaseServiceRoleClient(), "r_1");
    expect(r.matchedCount).toBe(1);
    expect(r.alreadyQueuedCount).toBe(1);
    expect(r.newlyQueuedCount).toBe(0);
  });
});
