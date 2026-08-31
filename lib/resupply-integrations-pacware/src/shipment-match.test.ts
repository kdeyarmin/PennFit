import { describe, expect, it } from "vitest";

import { parsePacwareShipmentCsv, type PacwareShipmentRow } from "./parse";
import {
  matchShipmentRows,
  type ShipmentCandidateFulfillment,
} from "./shipment-match";

const EPISODE_A = "11111111-1111-4111-8111-111111111111";
const EPISODE_B = "22222222-2222-4222-8222-222222222222";

function candidate(
  over: Partial<ShipmentCandidateFulfillment> = {},
): ShipmentCandidateFulfillment {
  return {
    id: "f1",
    episodeId: EPISODE_A,
    patientPacwareId: "ACCT-100",
    itemSku: "CUSHION-STD",
    pacwareOrderRef: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    shippedAt: null,
    status: "queued",
    ...over,
  };
}

function row(over: Partial<PacwareShipmentRow> = {}): PacwareShipmentRow {
  return {
    pacwareId: "ACCT-100",
    itemSku: "CUSHION-STD",
    shippedDate: "2026-03-05",
    ...over,
  } as PacwareShipmentRow;
}

describe("matchShipmentRows — key precedence", () => {
  it("matches on the episode id when the report carried it through", () => {
    const results = matchShipmentRows(
      [row({ pennfitEpisodeId: EPISODE_A })],
      [
        candidate({ id: "right" }),
        candidate({ id: "wrong", episodeId: EPISODE_B }),
      ],
    );
    expect(results[0]).toMatchObject({
      strategy: "episode_id",
      fulfillmentId: "right",
    });
  });

  it("matches on the PacWare order ref, case- and space-insensitively", () => {
    const results = matchShipmentRows(
      [row({ pacwareOrderRef: "  so-9001 " })],
      [candidate({ id: "right", pacwareOrderRef: "SO-9001" })],
    );
    expect(results[0]).toMatchObject({
      strategy: "order_ref",
      fulfillmentId: "right",
    });
  });

  it("falls back to patient + SKU when no stronger key resolves", () => {
    const results = matchShipmentRows([row()], [candidate({ id: "right" })]);
    expect(results[0]).toMatchObject({
      strategy: "patient_sku_date",
      fulfillmentId: "right",
    });
  });

  it("falls through a key that resolves to nothing", () => {
    // An episode id we have never seen (a stale note in PacWare) must not
    // strand the row — the weaker keys still get their turn.
    const results = matchShipmentRows(
      [row({ pennfitEpisodeId: EPISODE_B })],
      [candidate({ id: "right" })],
    );
    expect(results[0]).toMatchObject({
      strategy: "patient_sku_date",
      fulfillmentId: "right",
    });
  });

  it("does NOT fall through an ambiguous key to a weaker one", () => {
    // Two lines on the same episode for the same SKU. Retrying patient+SKU
    // would pick one arbitrarily; that wrong pick becomes a date of
    // service on a claim.
    const results = matchShipmentRows(
      [row({ pennfitEpisodeId: EPISODE_A })],
      [candidate({ id: "a" }), candidate({ id: "b" })],
    );
    expect(results[0].strategy).toBe("ambiguous");
    expect(results[0].fulfillmentId).toBeNull();
    expect(results[0].candidateIds).toHaveLength(2);
  });

  it("disambiguates a multi-line episode by SKU", () => {
    const results = matchShipmentRows(
      [row({ pennfitEpisodeId: EPISODE_A, itemSku: "TUBING-STD" })],
      [
        candidate({ id: "cushion", itemSku: "CUSHION-STD" }),
        candidate({ id: "tubing", itemSku: "TUBING-STD" }),
      ],
    );
    expect(results[0]).toMatchObject({
      strategy: "episode_id",
      fulfillmentId: "tubing",
    });
  });
});

describe("matchShipmentRows — safety", () => {
  it("never matches a cancelled fulfillment", () => {
    // Double-L is the spelling every cadence filter uses; single-L is what
    // the admin badge renders. Both must be excluded from matching.
    for (const status of ["cancelled", "canceled", "CANCELLED"]) {
      const results = matchShipmentRows([row()], [candidate({ status })]);
      expect(results[0].strategy).toBe("unmatched");
    }
  });

  it("skips a row the report itself marks cancelled or voided", () => {
    for (const rowStatus of ["cancelled", "canceled", "voided"] as const) {
      const results = matchShipmentRows(
        [row({ rowStatus })],
        [candidate({ id: "f1" })],
      );
      expect(results[0]).toMatchObject({
        strategy: "row_cancelled",
        fulfillmentId: null,
      });
    }
  });

  it("will not attach a ship that predates the queued line", () => {
    // An order queued in June cannot have shipped in March. Matching it
    // would back-date a claim past its filing window.
    const results = matchShipmentRows(
      [row({ shippedDate: "2026-03-05" })],
      [candidate({ createdAt: "2026-06-01T00:00:00.000Z" })],
    );
    expect(results[0].strategy).toBe("unmatched");
  });

  it("allows a day of slack for a same-day ship", () => {
    const results = matchShipmentRows(
      [row({ shippedDate: "2026-03-01" })],
      [candidate({ id: "f1", createdAt: "2026-03-01T18:00:00.000Z" })],
    );
    expect(results[0].fulfillmentId).toBe("f1");
  });

  it("will not reach past the lookback window for an old order", () => {
    const results = matchShipmentRows(
      [row({ shippedDate: "2026-03-05" })],
      [candidate({ createdAt: "2025-01-01T00:00:00.000Z" })],
      { windowDays: 120 },
    );
    expect(results[0].strategy).toBe("unmatched");
  });

  it("prefers an unshipped line over one that already has evidence", () => {
    const results = matchShipmentRows(
      [row()],
      [
        candidate({ id: "done", shippedAt: "2026-01-02T00:00:00.000Z" }),
        candidate({ id: "open", createdAt: "2026-03-02T00:00:00.000Z" }),
      ],
    );
    expect(results[0]).toMatchObject({
      strategy: "patient_sku_date",
      fulfillmentId: "open",
    });
  });

  it("does not confuse two patients who bought the same SKU", () => {
    const results = matchShipmentRows(
      [row({ pacwareId: "ACCT-100" })],
      [
        candidate({
          id: "theirs",
          patientPacwareId: "ACCT-999",
          episodeId: EPISODE_B,
        }),
      ],
    );
    expect(results[0].strategy).toBe("unmatched");
  });
});

describe("matchShipmentRows — idempotency", () => {
  it("reports a re-import of the same file as already recorded", () => {
    const results = matchShipmentRows(
      [row({ pennfitEpisodeId: EPISODE_A, shippedDate: "2026-03-05" })],
      [candidate({ id: "f1", shippedAt: "2026-03-05T00:00:00.000Z" })],
    );
    expect(results[0]).toMatchObject({
      fulfillmentId: "f1",
      alreadyRecorded: true,
    });
  });

  it("tolerates a timezone shift between runs", () => {
    const results = matchShipmentRows(
      [row({ pennfitEpisodeId: EPISODE_A, shippedDate: "2026-03-05" })],
      [candidate({ id: "f1", shippedAt: "2026-03-04T19:00:00.000Z" })],
    );
    expect(results[0].alreadyRecorded).toBe(true);
  });

  it("treats a genuinely different ship date as a correction, not a repeat", () => {
    const results = matchShipmentRows(
      [row({ pennfitEpisodeId: EPISODE_A, shippedDate: "2026-03-20" })],
      [candidate({ id: "f1", shippedAt: "2026-03-05T00:00:00.000Z" })],
    );
    expect(results[0].alreadyRecorded).toBe(false);
  });

  it("keeps row indices 1-based and aligned with the input", () => {
    const results = matchShipmentRows(
      [row(), row({ pacwareId: "ACCT-404" }), row()],
      [candidate({ id: "f1" })],
    );
    expect(results.map((r) => r.rowIndex)).toEqual([1, 2, 3]);
  });
});

describe("parsePacwareShipmentCsv", () => {
  it("normalizes PacWare's MM/DD/YYYY ship dates", () => {
    // The ship date becomes a claim's date of service. An operator should
    // not have to reformat it by hand for that to be right.
    const csv = [
      "pacware_id,item_sku,ship_date",
      "ACCT-100,CUSHION-STD,03/05/2026",
    ].join("\n");
    const result = parsePacwareShipmentCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0].shippedDate).toBe("2026-03-05");
  });

  it("accepts the header spellings a saved PacWare report emits", () => {
    const csv = [
      "AcctNo,ItemNo,DateShipped,OrderNo,Tracking,ShipVia,Qty",
      "ACCT-100,CUSHION-STD,2026-03-05,SO-9001,1Z999,UPS,2",
    ].join("\n");
    const result = parsePacwareShipmentCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      pacwareId: "ACCT-100",
      itemSku: "CUSHION-STD",
      pacwareOrderRef: "SO-9001",
      trackingNumber: "1Z999",
      carrier: "UPS",
      quantity: 2,
    });
  });

  it("rejects a delivery that precedes its own shipment", () => {
    const csv = [
      "pacware_id,item_sku,ship_date,delivered_date",
      "ACCT-100,CUSHION-STD,2026-03-05,2026-03-01",
    ].join("\n");
    const result = parsePacwareShipmentCsv(csv);
    expect(result.rows).toEqual([]);
    expect(result.errors[0]).toMatchObject({
      rowIndex: 1,
      field: "deliveredDate",
    });
  });

  it("reports a row index and field without echoing the bad value", () => {
    // Row errors are surfaced in an admin response; the VALUE is PHI.
    const csv = [
      "pacware_id,item_sku,ship_date",
      "ACCT-100,CUSHION-STD,not-a-date",
    ].join("\n");
    const result = parsePacwareShipmentCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(JSON.stringify(result.errors)).not.toContain("not-a-date");
  });
});
