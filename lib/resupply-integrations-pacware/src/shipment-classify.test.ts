// Shipment-row classification.
//
// The matcher decides WHICH order a row is about; this decides what to
// do with it, and the distinctions it draws are the ones that keep a bad
// ship date off a claim. Each test below is a way a real PacWare export
// has to be allowed to be wrong.

import { describe, expect, it } from "vitest";

import {
  buildShipmentDispositionCsv,
  classifyShipmentRows,
  countDispositions,
  SHIPMENT_DISPOSITIONS,
  type ClassifyShipmentRowsInput,
} from "./shipment-classify";
import type { PacwareShipmentRow } from "./parse";
import type { ShipmentMatchResult } from "./shipment-match";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

function row(overrides: Partial<PacwareShipmentRow> = {}): PacwareShipmentRow {
  return {
    pacwareId: "PW-1",
    itemSku: "A7034",
    shippedDate: isoDate(5),
    ...overrides,
  } as PacwareShipmentRow;
}

function match(
  overrides: Partial<ShipmentMatchResult> = {},
): ShipmentMatchResult {
  return {
    rowIndex: 1,
    strategy: "patient_sku_date",
    fulfillmentId: "f1",
    alreadyRecorded: false,
    candidateIds: [],
    ...overrides,
  };
}

function classify(
  input: Partial<ClassifyShipmentRowsInput> & {
    rows: readonly PacwareShipmentRow[];
    matches: readonly ShipmentMatchResult[];
  },
) {
  return classifyShipmentRows({
    rowIndexes: input.rows.map((_, i) => i + 1),
    parseErrors: [],
    now: NOW,
    ...input,
  });
}

describe("classifyShipmentRows — the happy path", () => {
  it("marks a clean, matched row as matched and names the strategy", () => {
    const [result] = classify({
      rows: [row()],
      matches: [match({ strategy: "episode_id" })],
    });
    expect(result.disposition).toBe("matched");
    expect(result.fulfillmentId).toBe("f1");
    expect(result.reason).toContain("episode id");
    expect(result.requiresException).toBe(false);
  });
});

describe("dates", () => {
  it("refuses a ship date in the future", () => {
    // A claim cannot carry a date of service that has not happened.
    const [result] = classify({
      rows: [row({ shippedDate: isoDate(-10) })],
      matches: [match()],
    });
    expect(result.disposition).toBe("future_dated");
  });

  it("tolerates one day ahead — a warehouse in a later timezone", () => {
    const [result] = classify({
      rows: [row({ shippedDate: isoDate(-1) })],
      matches: [match()],
    });
    expect(result.disposition).toBe("matched");
  });

  it("flags a ship date past the timely-filing threshold", () => {
    const [result] = classify({
      rows: [row({ shippedDate: isoDate(200) })],
      matches: [match()],
    });
    expect(result.disposition).toBe("too_old");
    expect(result.reason).toContain("timely-filing");
  });

  it("honours a raised backdate threshold for a deliberate history import", () => {
    const [result] = classify({
      rows: [row({ shippedDate: isoDate(200) })],
      matches: [match()],
      maxBackdateDays: 365,
    });
    expect(result.disposition).toBe("matched");
  });

  it("rejects an unparseable ship date as invalid, not as unmatched", () => {
    const [result] = classify({
      rows: [row({ shippedDate: "not-a-date" })],
      matches: [match()],
    });
    expect(result.disposition).toBe("invalid");
  });
});

describe("cancelled rows", () => {
  it.each(["cancelled", "canceled", "voided", "VOIDED"])(
    "never treats %j as a dispense",
    (status) => {
      const [result] = classify({
        rows: [row({ rowStatus: status } as Partial<PacwareShipmentRow>)],
        matches: [match()],
      });
      expect(result.disposition).toBe("cancelled");
      expect(result.fulfillmentId).toBeNull();
    },
  );

  it("reads the row's own status even when no matcher ran", () => {
    // The offline validation CLI has no candidates to match against.
    // Without this, every cancelled row would report as merely
    // `unmatched` — the bucket people ignore.
    const [result] = classify({
      rows: [row({ rowStatus: "cancelled" } as Partial<PacwareShipmentRow>)],
      matches: [match({ strategy: "unmatched", fulfillmentId: null })],
    });
    expect(result.disposition).toBe("cancelled");
  });
});

describe("duplicates and split shipments", () => {
  it("applies the first occurrence and marks later ones duplicate", () => {
    const rows = [
      row({ pacwareOrderRef: "SO-1" }),
      row({ pacwareOrderRef: "SO-1" }),
      row({ pacwareOrderRef: "SO-1" }),
    ];
    const results = classify({
      rows,
      matches: rows.map(() => match()),
    });
    expect(results.map((r) => r.disposition)).toEqual([
      "matched",
      "duplicate",
      "duplicate",
    ]);
    expect(results[1].reason).toContain("3 times");
    expect(results[0].lineOccurrences).toBe(3);
  });

  it("does not call two genuinely different lines duplicates", () => {
    const rows = [
      row({ pacwareOrderRef: "SO-1" }),
      row({ pacwareOrderRef: "SO-2" }),
    ];
    const results = classify({ rows, matches: rows.map(() => match()) });
    expect(results.every((r) => r.disposition === "matched")).toBe(true);
  });

  it("keys on the episode id when present, so same-SKU same-day lines stay distinct", () => {
    const rows = [
      row({ pennfitEpisodeId: "11111111-1111-1111-1111-111111111111" }),
      row({ pennfitEpisodeId: "22222222-2222-2222-2222-222222222222" }),
    ];
    const results = classify({ rows, matches: rows.map(() => match()) });
    expect(results.map((r) => r.disposition)).toEqual(["matched", "matched"]);
  });

  it("falls back to patient+SKU+date when no stronger key exists", () => {
    const rows = [row(), row()];
    const results = classify({ rows, matches: rows.map(() => match()) });
    expect(results.map((r) => r.disposition)).toEqual(["matched", "duplicate"]);
  });
});

describe("matching outcomes", () => {
  it("reports ambiguity with its candidates rather than guessing", () => {
    const [result] = classify({
      rows: [row()],
      matches: [
        match({
          strategy: "ambiguous",
          fulfillmentId: null,
          candidateIds: ["f1", "f2"],
        }),
      ],
    });
    expect(result.disposition).toBe("ambiguous");
    expect(result.candidateIds).toEqual(["f1", "f2"]);
    expect(result.fulfillmentId).toBeNull();
    expect(result.reason).toContain("refusing to guess");
  });

  it("reports an unmatched row distinctly from an ambiguous one", () => {
    const [result] = classify({
      rows: [row()],
      matches: [match({ strategy: "unmatched", fulfillmentId: null })],
    });
    expect(result.disposition).toBe("unmatched");
  });
});

describe("re-imports and corrections", () => {
  it("treats the same date already on file as already_recorded", () => {
    const [result] = classify({
      rows: [row({ shippedDate: isoDate(5) })],
      matches: [match()],
      recordedShipDates: new Map([
        ["f1", new Date(NOW.getTime() - 5 * DAY_MS).toISOString()],
      ]),
    });
    expect(result.disposition).toBe("already_recorded");
    expect(result.requiresException).toBe(false);
  });

  it("tolerates a timezone-shifted re-run as the same ship", () => {
    const [result] = classify({
      rows: [row({ shippedDate: isoDate(5) })],
      matches: [match()],
      recordedShipDates: new Map([
        [
          "f1",
          new Date(NOW.getTime() - 5 * DAY_MS + 8 * 3600_000).toISOString(),
        ],
      ]),
    });
    expect(result.disposition).toBe("already_recorded");
  });

  it("refuses to overwrite a DIFFERENT recorded date", () => {
    const [result] = classify({
      rows: [row({ shippedDate: isoDate(5) })],
      matches: [match()],
      recordedShipDates: new Map([
        ["f1", new Date(NOW.getTime() - 30 * DAY_MS).toISOString()],
      ]),
    });
    expect(result.disposition).toBe("date_conflict");
    expect(result.requiresException).toBe(false);
  });

  it("requires an exception when the recorded date has already been billed", () => {
    // The payer was told a date of service. Overwriting it would make
    // the claim and the record disagree with nobody knowing.
    const [result] = classify({
      rows: [row({ shippedDate: isoDate(5) })],
      matches: [match()],
      recordedShipDates: new Map([
        ["f1", new Date(NOW.getTime() - 30 * DAY_MS).toISOString()],
      ]),
      fulfillmentsWithClaims: new Set(["f1"]),
    });
    expect(result.disposition).toBe("date_conflict");
    expect(result.requiresException).toBe(true);
    expect(result.reason).toContain("correction exception");
  });

  it("date_conflict outranks matched — a conflict is never quietly applied", () => {
    const results = classify({
      rows: [row(), row({ pacwareOrderRef: "SO-9" })],
      matches: [match(), match({ fulfillmentId: "f2" })],
      recordedShipDates: new Map([
        ["f1", new Date(NOW.getTime() - 40 * DAY_MS).toISOString()],
      ]),
    });
    expect(results[0].disposition).toBe("date_conflict");
    expect(results[1].disposition).toBe("matched");
  });
});

describe("parse errors", () => {
  it("carries an unparseable row through as invalid with its row number", () => {
    const results = classify({
      rows: [],
      matches: [],
      parseErrors: [
        { rowIndex: 7, field: "shippedDate", message: "must be YYYY-MM-DD" },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ rowIndex: 7, disposition: "invalid" });
    expect(results[0].reason).toContain("shippedDate");
  });

  it("interleaves parse errors with classified rows in file order", () => {
    const results = classifyShipmentRows({
      rows: [row(), row({ pacwareOrderRef: "SO-2" })],
      rowIndexes: [1, 3],
      matches: [match(), match({ fulfillmentId: "f2" })],
      parseErrors: [{ rowIndex: 2, message: "blank row" }],
      now: NOW,
    });
    expect(results.map((r) => r.rowIndex)).toEqual([1, 2, 3]);
  });
});

describe("countDispositions", () => {
  it("reports every category even at zero", () => {
    // A category that is merely empty must not look absent — that is the
    // same distinction the monitoring surfaces depend on.
    const counts = countDispositions([]);
    expect(Object.keys(counts).sort()).toEqual(
      [...SHIPMENT_DISPOSITIONS].sort(),
    );
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe("buildShipmentDispositionCsv", () => {
  const rows = classify({
    rows: [
      row({ pacwareId: "PW-SECRET-123", itemSku: "A7034" }),
      row({ pacwareOrderRef: "SO-2", trackingNumber: "1Z999AA10123456784" }),
    ],
    matches: [
      match({
        strategy: "ambiguous",
        fulfillmentId: null,
        candidateIds: ["f1", "f2"],
      }),
      match({ fulfillmentId: "f9" }),
    ],
  });

  it("carries row numbers, categories and internal ids", () => {
    const csv = buildShipmentDispositionCsv(rows);
    expect(csv.split("\r\n")[0]).toBe(
      "file_row,disposition,reason,match_strategy,fulfillment_id,candidate_fulfillment_ids,requires_exception,occurrences_in_file",
    );
    expect(csv).toContain("ambiguous");
    expect(csv).toContain("f1 f2");
    expect(csv).toContain("f9");
  });

  it("carries NO cell values from the file — it is meant to leave the building", () => {
    const csv = buildShipmentDispositionCsv(rows);
    expect(csv).not.toContain("PW-SECRET-123");
    expect(csv).not.toContain("A7034");
    expect(csv).not.toContain("1Z999AA10123456784");
    expect(csv).not.toContain("SO-2");
  });

  it("escapes a reason containing a comma or a quote", () => {
    const csv = buildShipmentDispositionCsv([
      {
        rowIndex: 1,
        disposition: "invalid",
        reason: 'column "x": bad, very bad',
        strategy: null,
        fulfillmentId: null,
        candidateIds: [],
        requiresException: false,
        lineOccurrences: 0,
      },
    ]);
    expect(csv).toContain('"column ""x"": bad, very bad"');
  });
});
