// shipment-match.ts — decide which fulfillment each shipment-confirmation
// row refers to.
//
// Pure: no DB, no clock, no logging. The route loads candidate
// fulfillments and hands them in; this decides. That split is what makes
// the matching rules — the part that can silently attach a ship event to
// the wrong patient's order — testable without a database.
//
// WHY THREE STRATEGIES
// --------------------
// A PacWare shipment report is whatever the operator's saved report
// happens to emit, so the key degrades:
//
//   1. `pennfitEpisodeId` — round-trips from our own resupply-due export,
//      which already asks the operator to keep it in PacWare notes.
//      Unambiguous when present.
//   2. `pacwareOrderRef` — PacWare's own order number. We do not know it
//      on the first import; it is stamped on match, so every subsequent
//      import is an exact key.
//   3. `pacwareId` + `itemSku` — the fallback. Resolved against the most
//      recent unshipped queued line for that patient and SKU.
//
// AMBIGUITY IS NOT A GUESS
// ------------------------
// When a strategy yields more than one candidate the row is reported
// `ambiguous` and left for a person. Attaching a ship date to the wrong
// fulfillment does not just mis-report: `shipped_at` becomes the date of
// service on that patient's claim, and it re-times their next refill.
// A row an operator has to look at costs minutes; a wrong one costs a
// denied claim and a patient who runs out of supplies.

import type { PacwareShipmentRow } from "./parse";

export type ShipmentMatchStrategy =
  | "episode_id"
  | "order_ref"
  | "patient_sku_date"
  | "ambiguous"
  | "unmatched"
  /** The row says the order was cancelled or voided. Never a dispense. */
  | "row_cancelled";

/** The subset of a fulfillment the matcher needs. No PHI beyond the
 *  patient's PacWare account number, which is the join key itself. */
export interface ShipmentCandidateFulfillment {
  id: string;
  episodeId: string | null;
  patientPacwareId: string | null;
  itemSku: string;
  pacwareOrderRef: string | null;
  /** ISO. When the line was queued — a ship cannot precede it. */
  createdAt: string;
  /** ISO, or null when no evidence has been recorded yet. */
  shippedAt: string | null;
  status: string;
}

export interface ShipmentMatchResult {
  /** 1-based, matching `PacwareRowError.rowIndex` so a preview can line
   *  errors and matches up in one table. */
  rowIndex: number;
  strategy: ShipmentMatchStrategy;
  fulfillmentId: string | null;
  /** Already carries a ship date within a day of this row's — a re-import
   *  of the same file. Reported as unchanged, never rewritten. */
  alreadyRecorded: boolean;
  /** Populated only for `ambiguous`, so a person can go look. */
  candidateIds: string[];
}

export interface MatchShipmentRowsOptions {
  /**
   * How far back from a ship date to look for the queued line it belongs
   * to. Wide enough to cover a warehouse that batches, narrow enough that
   * a ship date does not reach back to last year's order for the same
   * SKU. Only used by the patient+SKU fallback.
   */
  windowDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 120;

/** Cancelled/voided spellings a PacWare report can emit. */
const CANCELLED_ROW_STATUSES = new Set(["cancelled", "canceled", "voided"]);

function normalizeRef(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isShippable(candidate: ShipmentCandidateFulfillment): boolean {
  // "cancelled" is the double-L spelling the cadence filters use; accept
  // both here because this is reading data, not writing it, and a legacy
  // single-L row must still be excluded from matching.
  const status = candidate.status.trim().toLowerCase();
  return status !== "cancelled" && status !== "canceled";
}

export function matchShipmentRows(
  rows: readonly PacwareShipmentRow[],
  candidates: readonly ShipmentCandidateFulfillment[],
  opts: MatchShipmentRowsOptions = {},
): ShipmentMatchResult[] {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;

  const byEpisode = new Map<string, ShipmentCandidateFulfillment[]>();
  const byOrderRef = new Map<string, ShipmentCandidateFulfillment[]>();
  const byPatientSku = new Map<string, ShipmentCandidateFulfillment[]>();

  for (const c of candidates) {
    if (!isShippable(c)) continue;
    if (c.episodeId) {
      byEpisode.set(c.episodeId, [...(byEpisode.get(c.episodeId) ?? []), c]);
    }
    const ref = normalizeRef(c.pacwareOrderRef);
    if (ref) {
      byOrderRef.set(ref, [...(byOrderRef.get(ref) ?? []), c]);
    }
    if (c.patientPacwareId) {
      const key = `${normalizeRef(c.patientPacwareId)}|${normalizeRef(c.itemSku)}`;
      byPatientSku.set(key, [...(byPatientSku.get(key) ?? []), c]);
    }
  }

  return rows.map((row, i) => {
    const rowIndex = i + 1;
    const empty = { rowIndex, fulfillmentId: null, candidateIds: [] };

    if (row.rowStatus && CANCELLED_ROW_STATUSES.has(row.rowStatus)) {
      return {
        ...empty,
        strategy: "row_cancelled" as const,
        alreadyRecorded: false,
      };
    }

    const shippedMs = Date.parse(`${row.shippedDate}T00:00:00.000Z`);

    // 1. Episode id — our own handle, round-tripped through PacWare notes.
    if (row.pennfitEpisodeId) {
      const pool = byEpisode.get(row.pennfitEpisodeId) ?? [];
      const narrowed =
        pool.length > 1
          ? pool.filter(
              (c) => normalizeRef(c.itemSku) === normalizeRef(row.itemSku),
            )
          : pool;
      const decided = decide(narrowed, rowIndex, shippedMs, "episode_id");
      if (decided) return decided;
    }

    // 2. PacWare's own order ref — exact once we have stamped it.
    if (row.pacwareOrderRef) {
      const pool = byOrderRef.get(normalizeRef(row.pacwareOrderRef)) ?? [];
      const decided = decide(pool, rowIndex, shippedMs, "order_ref");
      if (decided) return decided;
    }

    // 3. Patient + SKU, newest queued line inside the window that could
    //    plausibly have produced this ship.
    const key = `${normalizeRef(row.pacwareId)}|${normalizeRef(row.itemSku)}`;
    const pool = (byPatientSku.get(key) ?? []).filter((c) => {
      const createdMs = Date.parse(c.createdAt);
      if (!Number.isFinite(createdMs) || !Number.isFinite(shippedMs)) {
        return false;
      }
      // A ship cannot precede the queue (allow one day of slack for a
      // warehouse that ships same-day and a report that stores dates in
      // local time).
      if (createdMs - shippedMs > DAY_MS) return false;
      return shippedMs - createdMs <= windowDays * DAY_MS;
    });

    // Prefer lines with no evidence yet; only fall back to already-shipped
    // ones so a re-import can still recognise itself as unchanged.
    const unshipped = pool.filter((c) => !c.shippedAt);
    const decided = decide(
      unshipped.length > 0 ? unshipped : pool,
      rowIndex,
      shippedMs,
      "patient_sku_date",
    );
    if (decided) return decided;

    return {
      ...empty,
      strategy: "unmatched" as const,
      alreadyRecorded: false,
    };
  });
}

/**
 * Turn a candidate pool into a decision, or null to fall through to the
 * next strategy.
 *
 * An EMPTY pool falls through (this key did not resolve — try the next
 * one). A pool with more than one entry does NOT: an ambiguous key is a
 * real finding, and quietly retrying a weaker key would be how a ship
 * event lands on the wrong order.
 */
function decide(
  pool: readonly ShipmentCandidateFulfillment[],
  rowIndex: number,
  shippedMs: number,
  strategy: Exclude<
    ShipmentMatchStrategy,
    "ambiguous" | "unmatched" | "row_cancelled"
  >,
): ShipmentMatchResult | null {
  if (pool.length === 0) return null;

  if (pool.length > 1) {
    // Newest-first, so a person reading the preview sees the likeliest
    // candidate first.
    const sorted = [...pool].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
    return {
      rowIndex,
      strategy: "ambiguous",
      fulfillmentId: null,
      alreadyRecorded: false,
      candidateIds: sorted.map((c) => c.id),
    };
  }

  const only = pool[0];
  return {
    rowIndex,
    strategy,
    fulfillmentId: only.id,
    alreadyRecorded: isSameShip(only.shippedAt, shippedMs),
    candidateIds: [],
  };
}

/** Within a day counts as the same ship: a report re-run after a timezone
 *  shift must read as unchanged, not as a correction. */
function isSameShip(existing: string | null, shippedMs: number): boolean {
  if (!existing) return false;
  const existingMs = Date.parse(existing);
  if (!Number.isFinite(existingMs) || !Number.isFinite(shippedMs)) return false;
  return Math.abs(existingMs - shippedMs) <= DAY_MS;
}
