// shipment-classify.ts — turn a parsed + matched shipment file into a set
// of DISPOSITIONS an operator can actually work.
//
// WHY THIS IS SEPARATE FROM THE MATCHER
// -------------------------------------
// `matchShipmentRows` answers one question: which fulfillment is this
// row about? That is the dangerous question, so it lives alone and stays
// pure.
//
// This answers the rest of them, and there are more than the matcher's
// vocabulary can express. A row can match perfectly and still be
// unusable because its ship date is next month, or three years old, or
// because the same order line appears twice in the same file, or because
// it is the second half of a split shipment. Folding those into
// "unmatched" loses the only information that tells an operator what to
// DO — and "unmatched" is the bucket people ignore.
//
// So every row lands in exactly one disposition, and each names its own
// remedy.
//
// THE ORDER MATTERS
// -----------------
// Dispositions are decided in a fixed precedence, because several can be
// true at once and the operator needs the most actionable one:
//
//   invalid       — the row could not be parsed at all
//   cancelled     — the report itself says this order was voided
//   future_dated  — a date of service that has not happened
//   too_old       — past the timely-filing risk threshold
//   duplicate     — the same line already appeared in THIS file
//   ambiguous     — more than one fulfillment could be meant
//   unmatched     — no fulfillment could be found
//   already_recorded — evidence already on file, same date
//   date_conflict — evidence already on file, DIFFERENT date
//   matched       — usable
//
// `date_conflict` outranks `matched` deliberately. A ship date that has
// already contributed to a claim is not a field to overwrite: it is the
// date of service a payer was told. Changing it silently would make the
// claim and the record disagree with nobody knowing. See
// `requiresException` below.
//
// PHI
// ---
// A disposition carries a ROW INDEX, a category, a reason string built
// from constants, and internal UUIDs. It never carries a patient
// identifier, a SKU, a tracking number or a date drawn from the row —
// which is what makes the result safe to download, attach to a ticket,
// and hand to a vendor.

import type { PacwareRowError, PacwareShipmentRow } from "./parse";
import type { ShipmentMatchResult } from "./shipment-match";

export const SHIPMENT_DISPOSITIONS = [
  "matched",
  "ambiguous",
  "unmatched",
  "duplicate",
  "cancelled",
  "invalid",
  "too_old",
  "future_dated",
  "already_recorded",
  "date_conflict",
] as const;

export type ShipmentDisposition = (typeof SHIPMENT_DISPOSITIONS)[number];

/** Dispositions whose rows are written on a commit. Everything else is
 *  reported and skipped. */
export const COMMITTABLE_DISPOSITIONS: readonly ShipmentDisposition[] = [
  "matched",
];

export interface ClassifiedShipmentRow {
  /** 1-based index into the DATA rows, matching PacwareRowError. */
  rowIndex: number;
  disposition: ShipmentDisposition;
  /** Why, in operator language. Built from constants — never row data. */
  reason: string;
  /** Which match strategy resolved it, when one did. */
  strategy: ShipmentMatchResult["strategy"] | null;
  fulfillmentId: string | null;
  /** Populated for `ambiguous` so a person can go look. */
  candidateIds: string[];
  /**
   * True when acting on this row would change a ship date that has
   * already been recorded. The route must route these through the
   * exception workflow rather than writing them.
   */
  requiresException: boolean;
  /**
   * How many rows in this file share this row's order line. >1 means a
   * split or partial shipment (or a duplicated export) — reported, never
   * silently collapsed.
   */
  lineOccurrences: number;
}

export interface ClassifyShipmentRowsInput {
  /** Rows that PARSED. Index i here is `usableIndex[i]` in the file. */
  rows: readonly PacwareShipmentRow[];
  /** Original 1-based file row number for each entry of `rows`. */
  rowIndexes: readonly number[];
  /** Matcher output, aligned with `rows`. */
  matches: readonly ShipmentMatchResult[];
  /** Rows that failed to parse. */
  parseErrors: readonly PacwareRowError[];
  /**
   * Ship date already on file for a matched fulfillment, ISO. Supplied by
   * the route from the same read that produced the candidates. Absent
   * means no evidence recorded.
   */
  recordedShipDates?: ReadonlyMap<string, string>;
  /** Fulfillments that already contributed to a claim. */
  fulfillmentsWithClaims?: ReadonlySet<string>;
  now: Date;
  /** Ship dates older than this are `too_old`. */
  maxBackdateDays?: number;
  /** Tolerance for a report generated in a later timezone. */
  futureToleranceDays?: number;
  /** Two ship dates within this many days are the same ship. */
  sameShipToleranceDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cancelled/voided spellings a PacWare report can emit. Kept in step
 *  with the matcher's own set — both read the same column. */
const CANCELLED_ROW_STATUSES = new Set(["cancelled", "canceled", "voided"]);
/**
 * Past this, a matched row would mint a claim dated far enough back to
 * risk a payer's timely-filing limit (CARC 29). Not a hygiene threshold —
 * a billing one.
 */
export const DEFAULT_MAX_BACKDATE_DAYS = 180;
const DEFAULT_FUTURE_TOLERANCE_DAYS = 1;
const DEFAULT_SAME_SHIP_TOLERANCE_DAYS = 1;

/**
 * The key that identifies "the same order line". Deliberately built from
 * the strongest identifier present, so a file that carries episode ids
 * does not report a false duplicate for two different lines of the same
 * SKU on the same day.
 */
function lineKey(row: PacwareShipmentRow): string {
  if (row.pennfitEpisodeId) return `ep:${row.pennfitEpisodeId}`;
  if (row.pacwareOrderRef) {
    return `ref:${row.pacwareOrderRef.trim().toLowerCase()}`;
  }
  return `ps:${row.pacwareId.trim().toLowerCase()}|${row.itemSku
    .trim()
    .toLowerCase()}|${row.shippedDate}`;
}

/**
 * Classify every row of a shipment file into exactly one disposition.
 *
 * Pure: no DB, no clock of its own, no logging.
 *
 * @param input - Parsed rows, matcher output, and the state the route read.
 * @returns One classified row per FILE row, in file order.
 */
export function classifyShipmentRows(
  input: ClassifyShipmentRowsInput,
): ClassifiedShipmentRow[] {
  const maxBackdateDays = input.maxBackdateDays ?? DEFAULT_MAX_BACKDATE_DAYS;
  const futureToleranceDays =
    input.futureToleranceDays ?? DEFAULT_FUTURE_TOLERANCE_DAYS;
  const sameShipToleranceDays =
    input.sameShipToleranceDays ?? DEFAULT_SAME_SHIP_TOLERANCE_DAYS;
  const nowMs = input.now.getTime();

  // How many times each order line appears in THIS file. A split
  // shipment legitimately produces several; a duplicated export also
  // does. Both are reported, never silently collapsed.
  const occurrences = new Map<string, number>();
  for (const row of input.rows) {
    const key = lineKey(row);
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }

  const out: ClassifiedShipmentRow[] = [];

  // Rows that never parsed. They have a file row index and nothing else.
  for (const err of input.parseErrors) {
    out.push({
      rowIndex: err.rowIndex,
      disposition: "invalid",
      reason: err.field ? `column "${err.field}": ${err.message}` : err.message,
      strategy: null,
      fulfillmentId: null,
      candidateIds: [],
      requiresException: false,
      lineOccurrences: 0,
    });
  }

  const seen = new Map<string, number>();

  input.rows.forEach((row, i) => {
    const rowIndex = input.rowIndexes[i] ?? i + 1;
    const match = input.matches[i];
    const key = lineKey(row);
    const lineOccurrences = occurrences.get(key) ?? 1;
    const base = {
      rowIndex,
      strategy: match?.strategy ?? null,
      fulfillmentId: null as string | null,
      candidateIds: [] as string[],
      requiresException: false,
      lineOccurrences,
    };

    // 1. The report itself says this order was voided. Never a dispense,
    //    whatever else is true about the row.
    //
    //    Read from the ROW, not only from the matcher's verdict. The
    //    matcher reaches the same conclusion, but it is not always the
    //    thing that ran: the offline validation CLI has no candidates to
    //    match against and would otherwise report every cancelled row as
    //    merely `unmatched`, which is the bucket people ignore.
    const cancelledByReport =
      typeof row.rowStatus === "string" &&
      CANCELLED_ROW_STATUSES.has(row.rowStatus.trim().toLowerCase());
    if (cancelledByReport || match?.strategy === "row_cancelled") {
      out.push({
        ...base,
        disposition: "cancelled",
        reason:
          "the report marks this order cancelled or voided; no shipment recorded",
      });
      return;
    }

    const shippedMs = Date.parse(`${row.shippedDate}T00:00:00.000Z`);
    if (!Number.isFinite(shippedMs)) {
      out.push({
        ...base,
        disposition: "invalid",
        reason: "ship date is not a real date",
      });
      return;
    }

    // 2. A date of service that has not happened yet. One day of slack
    //    for a warehouse in a later timezone, or a report run just after
    //    midnight — beyond that it is a typo, and a typo here bills a
    //    payer for a future date.
    if (shippedMs - nowMs > futureToleranceDays * DAY_MS) {
      out.push({
        ...base,
        disposition: "future_dated",
        reason:
          "ship date is in the future; a claim cannot carry a date of service that has not happened",
      });
      return;
    }

    // 3. Old enough that importing it would mint a claim at timely-filing
    //    risk. Reported rather than silently dropped: a first import that
    //    backfills history legitimately hits this, and the operator
    //    decides.
    if (nowMs - shippedMs > maxBackdateDays * DAY_MS) {
      out.push({
        ...base,
        disposition: "too_old",
        reason: `ship date is more than ${maxBackdateDays} days old; importing it would date a claim that far back (timely-filing risk)`,
      });
      return;
    }

    // 4. The same line, twice in one file. The FIRST occurrence is
    //    classified normally; later ones are duplicates. Order matters,
    //    so this is decided by arrival, not by count.
    const priorCount = seen.get(key) ?? 0;
    seen.set(key, priorCount + 1);
    if (priorCount > 0) {
      out.push({
        ...base,
        disposition: "duplicate",
        reason:
          lineOccurrences > 1
            ? `this order line appears ${lineOccurrences} times in the file (a split shipment, or a duplicated export); only the first occurrence is applied`
            : "this order line already appeared earlier in the file",
      });
      return;
    }

    if (!match || match.strategy === "ambiguous") {
      out.push({
        ...base,
        disposition: "ambiguous",
        reason:
          "more than one order could be meant; refusing to guess — attaching a ship date to the wrong order sets the date of service on the wrong patient's claim",
        candidateIds: match?.candidateIds ?? [],
      });
      return;
    }

    if (match.strategy === "unmatched" || !match.fulfillmentId) {
      out.push({
        ...base,
        disposition: "unmatched",
        reason:
          "no order in this tenant matches the episode id, order reference, or patient + SKU on this row",
      });
      return;
    }

    const fulfillmentId = match.fulfillmentId;
    const recorded = input.recordedShipDates?.get(fulfillmentId);

    if (recorded) {
      const recordedMs = Date.parse(recorded);
      const sameShip =
        Number.isFinite(recordedMs) &&
        Math.abs(recordedMs - shippedMs) <= sameShipToleranceDays * DAY_MS;

      if (sameShip) {
        out.push({
          ...base,
          disposition: "already_recorded",
          reason:
            "this shipment is already on file with the same date; re-importing the file changes nothing",
          fulfillmentId,
        });
        return;
      }

      // A DIFFERENT date for a shipment already on file. If that date has
      // already gone out on a claim, it is not a field to correct in
      // place — the payer was told something, and the record has to keep
      // saying what it said until an exception is worked.
      const billed = input.fulfillmentsWithClaims?.has(fulfillmentId) ?? false;
      out.push({
        ...base,
        disposition: "date_conflict",
        reason: billed
          ? "a different ship date is already on file for this order AND it has been billed; the date of service on the claim cannot be changed silently — this needs a correction exception"
          : "a different ship date is already on file for this order; refusing to overwrite it without review",
        fulfillmentId,
        requiresException: billed,
      });
      return;
    }

    out.push({
      ...base,
      disposition: "matched",
      reason: `matched on ${describeStrategy(match.strategy)}`,
      fulfillmentId,
    });
  });

  return out.sort((a, b) => a.rowIndex - b.rowIndex);
}

function describeStrategy(strategy: ShipmentMatchResult["strategy"]): string {
  switch (strategy) {
    case "episode_id":
      return "the PennFit episode id carried in the report";
    case "order_ref":
      return "the PacWare order reference";
    case "patient_sku_date":
      return "patient account + SKU, within the dispense window";
    default:
      return strategy;
  }
}

export type ShipmentDispositionCounts = Record<ShipmentDisposition, number>;

/**
 * Tally dispositions. Every key is present even at zero, so a report
 * cannot make a category look absent when it is merely empty — the same
 * distinction the monitoring surfaces depend on.
 *
 * @param rows - Classified rows.
 * @returns One count per disposition.
 */
export function countDispositions(
  rows: readonly ClassifiedShipmentRow[],
): ShipmentDispositionCounts {
  const counts = Object.fromEntries(
    SHIPMENT_DISPOSITIONS.map((d) => [d, 0]),
  ) as ShipmentDispositionCounts;
  for (const row of rows) counts[row.disposition] += 1;
  return counts;
}

/**
 * Render the classification as a CSV an operator can download, attach to
 * a ticket, or send to a vendor.
 *
 * Deliberately carries NO row content — row number, disposition, reason,
 * strategy and internal UUIDs only. That is what makes it safe to leave
 * the building. An operator finds the offending line by row number in
 * their own copy of the file, which never left their machine.
 *
 * @param rows - Classified rows.
 * @returns CSV text with a header row.
 */
export function buildShipmentDispositionCsv(
  rows: readonly ClassifiedShipmentRow[],
): string {
  const header = [
    "file_row",
    "disposition",
    "reason",
    "match_strategy",
    "fulfillment_id",
    "candidate_fulfillment_ids",
    "requires_exception",
    "occurrences_in_file",
  ];
  const escape = (value: string): string =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        String(row.rowIndex),
        row.disposition,
        escape(row.reason),
        row.strategy ?? "",
        row.fulfillmentId ?? "",
        row.candidateIds.join(" "),
        row.requiresException ? "yes" : "no",
        String(row.lineOccurrences),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
