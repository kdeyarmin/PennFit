// reconcile.ts — diff what we hold against what the manufacturer portal
// says.
//
// WHY THIS EXISTS
// ---------------
// The nightly sync could be silently behind for months and nothing would
// notice. `lib/integrations/diff-settings.ts` compares our new snapshot
// to our own PREVIOUS snapshot, which by construction cannot detect that
// we are missing a patient, missing nights, or reading a different device
// than the portal shows. Every check we had was a check against
// ourselves.
//
// So: an operator exports the vendor's own report from the portal, and
// this diffs it against what we stored. That is the only comparison that
// can catch a link that quietly stopped syncing, a patient nobody ever
// linked, or a device that was swapped without our knowing.
//
// PURE: no DB, no HTTP, no clock. The caller loads both sides and passes
// them in.
//
// PHI: partner patient ids and device serials are identifiers, not
// clinical content, and both sides of this diff already hold them. The
// result carries COUNTS plus a CAPPED sample of ids so a CSR can go look
// — without a sample the report says "14 patients disagree" and gives
// nobody a way to act on it.

import type { IntegrationSource } from "./types";

/** One row of the operator's portal export, normalized. */
export interface PortalPatientRow {
  partnerPatientId: string;
  /** Device serial as the portal reports it, if the export carries one. */
  deviceSerial?: string | null;
  /** Nights with usage in the compared window, if the export carries it. */
  nightsWithUsage?: number | null;
  /** Average nightly usage in minutes over the window, if present. */
  avgUsageMinutes?: number | null;
}

/** What we hold for the same patient. */
export interface LocalPatientRow {
  partnerPatientId: string;
  deviceSerial?: string | null;
  nightsWithUsage?: number | null;
  avgUsageMinutes?: number | null;
  /** ISO instant of our last successful sync, or null if never. */
  lastSyncedAt?: string | null;
}

export type DiscrepancyKind =
  /** The portal has this patient; we have never linked or synced them. */
  | "missing_locally"
  /** We hold a link the portal no longer lists — usually a patient who
   *  left the practice, occasionally a link pointed at the wrong id. */
  | "missing_in_portal"
  /** Both sides know the patient and disagree about their device. */
  | "device_serial_mismatch"
  /** Both sides know the patient and disagree about how much therapy we
   *  have. This is the one that matters clinically: compliance decisions
   *  and resupply eligibility are made from these numbers. */
  | "night_count_mismatch"
  | "usage_mismatch";

export interface Discrepancy {
  kind: DiscrepancyKind;
  partnerPatientId: string;
  /** Portal value, stringified for display. Absent for a pure presence
   *  difference. */
  portal?: string;
  /** Our value. */
  local?: string;
}

export interface ReconcileOptions {
  /**
   * How many nights the two sides may differ by before it counts.
   *
   * Not zero, deliberately: the portal and the sync run at different
   * times in different timezones, so the most recent night is routinely
   * on one side and not the other. A tolerance of 1 stops that from
   * reporting every patient in the practice as a discrepancy, which is
   * indistinguishable from reporting none.
   */
  nightToleranceDays?: number;
  /**
   * Minutes of average-usage difference to tolerate. Portals round.
   */
  usageToleranceMinutes?: number;
  /** Ids sampled per discrepancy kind. Bounded so the stored result
   *  cannot grow with the size of the practice. */
  sampleSize?: number;
}

export interface ReconcileResult {
  source: IntegrationSource;
  portalRows: number;
  localRows: number;
  matchedCount: number;
  missingLocallyCount: number;
  missingInPortalCount: number;
  mismatchedCount: number;
  /** Per-kind counts plus a capped id sample. */
  discrepancies: Record<
    DiscrepancyKind,
    { count: number; sample: Discrepancy[] }
  >;
}

const DEFAULT_NIGHT_TOLERANCE = 1;
const DEFAULT_USAGE_TOLERANCE_MINUTES = 15;
const DEFAULT_SAMPLE_SIZE = 20;

const KINDS: DiscrepancyKind[] = [
  "missing_locally",
  "missing_in_portal",
  "device_serial_mismatch",
  "night_count_mismatch",
  "usage_mismatch",
];

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSerial(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  // Serials are transcribed by hand into portals often enough that
  // separators drift; comparing on alphanumerics avoids reporting
  // "SN-123" vs "SN123" as a device swap.
  const stripped = v.replace(/[^a-z0-9]/g, "");
  return stripped === "" ? null : stripped;
}

export function reconcileIntegrationSource(
  source: IntegrationSource,
  portal: readonly PortalPatientRow[],
  local: readonly LocalPatientRow[],
  opts: ReconcileOptions = {},
): ReconcileResult {
  const nightTolerance = opts.nightToleranceDays ?? DEFAULT_NIGHT_TOLERANCE;
  const usageTolerance =
    opts.usageToleranceMinutes ?? DEFAULT_USAGE_TOLERANCE_MINUTES;
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;

  const localById = new Map<string, LocalPatientRow>();
  for (const row of local) {
    if (!row.partnerPatientId) continue;
    localById.set(normalizeId(row.partnerPatientId), row);
  }
  const portalById = new Map<string, PortalPatientRow>();
  for (const row of portal) {
    if (!row.partnerPatientId) continue;
    portalById.set(normalizeId(row.partnerPatientId), row);
  }

  const buckets: ReconcileResult["discrepancies"] = Object.fromEntries(
    KINDS.map((k) => [k, { count: 0, sample: [] as Discrepancy[] }]),
  ) as ReconcileResult["discrepancies"];

  const record = (d: Discrepancy): void => {
    const bucket = buckets[d.kind];
    bucket.count += 1;
    if (bucket.sample.length < sampleSize) bucket.sample.push(d);
  };

  let matched = 0;
  let mismatched = 0;

  for (const [key, portalRow] of portalById) {
    const localRow = localById.get(key);
    if (!localRow) {
      record({
        kind: "missing_locally",
        partnerPatientId: portalRow.partnerPatientId,
      });
      continue;
    }
    matched += 1;

    let rowMismatched = false;

    const portalSerial = normalizeSerial(portalRow.deviceSerial);
    const localSerial = normalizeSerial(localRow.deviceSerial);
    // Only compare when BOTH sides have a serial. One side missing it is
    // an incomplete export, not a device swap, and reporting it as one
    // sends a CSR chasing a machine that never moved.
    if (portalSerial && localSerial && portalSerial !== localSerial) {
      rowMismatched = true;
      record({
        kind: "device_serial_mismatch",
        partnerPatientId: portalRow.partnerPatientId,
        portal: portalRow.deviceSerial ?? undefined,
        local: localRow.deviceSerial ?? undefined,
      });
    }

    if (
      typeof portalRow.nightsWithUsage === "number" &&
      typeof localRow.nightsWithUsage === "number" &&
      Math.abs(portalRow.nightsWithUsage - localRow.nightsWithUsage) >
        nightTolerance
    ) {
      rowMismatched = true;
      record({
        kind: "night_count_mismatch",
        partnerPatientId: portalRow.partnerPatientId,
        portal: String(portalRow.nightsWithUsage),
        local: String(localRow.nightsWithUsage),
      });
    }

    if (
      typeof portalRow.avgUsageMinutes === "number" &&
      typeof localRow.avgUsageMinutes === "number" &&
      Math.abs(portalRow.avgUsageMinutes - localRow.avgUsageMinutes) >
        usageTolerance
    ) {
      rowMismatched = true;
      record({
        kind: "usage_mismatch",
        partnerPatientId: portalRow.partnerPatientId,
        portal: String(Math.round(portalRow.avgUsageMinutes)),
        local: String(Math.round(localRow.avgUsageMinutes)),
      });
    }

    if (rowMismatched) mismatched += 1;
  }

  for (const [key, localRow] of localById) {
    if (portalById.has(key)) continue;
    record({
      kind: "missing_in_portal",
      partnerPatientId: localRow.partnerPatientId,
      local: localRow.lastSyncedAt ?? undefined,
    });
  }

  return {
    source,
    portalRows: portalById.size,
    localRows: localById.size,
    matchedCount: matched,
    missingLocallyCount: buckets.missing_locally.count,
    missingInPortalCount: buckets.missing_in_portal.count,
    mismatchedCount: mismatched,
    discrepancies: buckets,
  };
}
