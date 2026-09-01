// readiness.ts — "is this tenant safe to cut over?", answered per flag,
// per tenant, from that tenant's own data.
//
// WHY A READINESS ASSESSMENT AND NOT JUST A FLAG
// ----------------------------------------------
// `resupply.due_at_authoritative` and `resupply.ship_evidence_required`
// (migration 0538) are seeded OFF because each changes WHEN a live
// patient is next contacted. Flipping either on a tenant whose data is
// not ready is not a config change with a config-shaped failure — it is
// a burst of reminders across the whole book on the first tick, or a
// cohort that silently goes quiet. Both immediately, both invisible
// until patients call.
//
// So the flag is the last step, not the decision. The decision is this
// module: a dry-run measurement of the specific data conditions each flag
// depends on, which BLOCKS when they are not met.
//
// WHAT "READY" MEANS FOR EACH FLAG
// --------------------------------
//   due_at_authoritative — the stored `episodes.due_at` must already
//     agree with what the reminder scan independently computes. `due_at`
//     is written once, by `openOutreachEpisode`, from the caller's
//     `prescriptions.cadence_days`. The scan resolves cadence through
//     `resolveOutreachPlan`, which prefers `patients.cadence_override_days`
//     then a matching `frequency_rules` row. For every patient with an
//     override or a matching rule the stored date therefore encodes the
//     WRONG cadence — harmless while the scan ignores it, decisive the
//     moment the flag makes it authoritative.
//
//   ship_evidence_required — SOMETHING must be able to write
//     `fulfillments.shipped_at`. With the flag on, the next cycle waits
//     for shipment evidence; a tenant with no evidence pathway would
//     depend entirely on the safety-net grace sweep, and every cycle
//     would close assumed_shipped — which is deliberately NOT a shipment
//     and must never mint a claim date of service.
//
// PAGINATION
// ----------
// PostgREST caps a single read at ~1000 rows regardless of `.limit()`.
// Every scan here is paged, and the result carries `truncated` when a
// safety window stopped it early — a readiness verdict computed from a
// silently truncated read is worse than no verdict, because it reads as
// "clean".
//
// PHI
// ---
// Counts, day-deltas, and a capped sample of INTERNAL episode UUIDs.
// Never a name, contact detail, payer, address or clinical value. The
// sample exists so a CSR can open the record in the console; it is
// useless to anyone without console access.

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  OUTREACH_OPEN_EPISODE_STATUSES,
  resolveOutreachPlan,
  type OutreachChannel,
  type OutreachRule,
} from "@workspace/resupply-domain";

const DAY_MS = 24 * 60 * 60 * 1000;
/** PostgREST's hard per-read cap. */
const PAGE_SIZE = 1000;
/** Keeps an `.in(...)` URL bounded. */
const READ_CHUNK = 200;
/**
 * Stop after this many open episodes. A tenant past it is not
 * un-assessable — the verdict is simply reported as truncated, and the
 * operator runs the CLI, which has no window.
 */
const DEFAULT_MAX_EPISODES = 50_000;
/** Drift below this is clock jitter, not disagreement. */
const DRIFT_TOLERANCE_HOURS = 12;
/** How many internal ids to sample per finding. */
const SAMPLE_LIMIT = 10;

export type ReadinessStatus = "ready" | "blocked" | "not_evaluated" | "error";

export interface ReadinessBlocker {
  code: string;
  /** What is wrong, in the operator's terms. */
  detail: string;
  /** Internal record ids, capped. Never PHI. */
  sampleIds?: string[];
}

export interface DueAtReadinessReport {
  flagKey: "resupply.due_at_authoritative";
  status: ReadinessStatus;
  evaluatedAt: string;
  blockers: ReadinessBlocker[];
  warnings: string[];
  metrics: {
    applicablePrescriptions: number;
    openEpisodes: number;
    addressHoldEpisodes: number;
    missingDueAt: number;
    agreeing: number;
    drifting: number;
    driftingEarlier: number;
    driftingLater: number;
    /** Largest amount the stored date would move LATER, in days. */
    maxDriftLaterDays: number;
    /** Largest amount the stored date would move EARLIER, in days. */
    maxDriftEarlierDays: number;
    unresolvable: number;
    byStatus: Record<string, number>;
    byReason: Record<string, number>;
  };
  /** True when a page cap or the safety window stopped the scan early. */
  truncated: boolean;
  sampleDriftingEpisodeIds: string[];
}

export interface ShipEvidenceReadinessReport {
  flagKey: "resupply.ship_evidence_required";
  status: ReadinessStatus;
  evaluatedAt: string;
  blockers: ReadinessBlocker[];
  warnings: string[];
  metrics: {
    /** Fulfillments that carry a real `shipped_at`, in the window. */
    shippedWithEvidence: number;
    /** Recorded via the PacWare shipped-orders import. */
    viaPacwareImport: number;
    /** Recorded by a person clicking "mark shipped". */
    viaAdminManual: number;
    viaCarrier: number;
    /** Queued and never shipped, older than the grace window. */
    fulfilledNotShipped: number;
    /** Episodes closed assumed_shipped — the honest measure of the gap. */
    assumedShippedEpisodes: number;
    /** Episodes closed shipped — real evidence. */
    shippedEpisodes: number;
    /** Claims whose date of service came from real shipment evidence. */
    claimsAnchoredToShipEvidence: number;
    /** Claims built with no shipment evidence behind them. */
    claimsWithoutShipEvidence: number;
    windowDays: number;
  };
  pathways: {
    pacwareImport: boolean;
    adminManual: boolean;
    carrier: boolean;
  };
  truncated: boolean;
  sampleUnshippedFulfillmentIds: string[];
}

export interface ReadinessOptions {
  /** Cap on rows scanned. Raise it for the CLI, which has no HTTP budget. */
  maxEpisodes?: number;
  /** How far back the ship-evidence assessment looks. */
  windowDays?: number;
  /**
   * How many un-shipped, past-grace fulfillments are tolerable before
   * ship-evidence readiness is BLOCKED. A tenant whose import is broken
   * accumulates these; the point of a threshold is that "a few" is a
   * warehouse in flight and "hundreds" is a broken pipeline.
   */
  unresolvedShipmentFailureThreshold?: number;
  now?: Date;
}

/** Page through a table, honouring both the PostgREST cap and a budget. */
async function pageAll<T>(
  read: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: unknown }>,
  budget: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < budget; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, budget) - 1;
    const { data, error } = await read(from, to);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < to - from + 1) return { rows, truncated: false };
  }
  return { rows, truncated: rows.length >= budget };
}

/**
 * Assess whether `resupply.due_at_authoritative` can be turned on for
 * this tenant.
 *
 * Read-only. Writes nothing, flips nothing.
 *
 * @param orgId - Tenant to assess.
 * @param options - Row budget, evaluation clock.
 * @returns The full readiness report, verdict included.
 */
export async function assessDueAtReadiness(
  orgId: string,
  options: ReadinessOptions = {},
): Promise<DueAtReadinessReport> {
  const now = options.now ?? new Date();
  const budget = options.maxEpisodes ?? DEFAULT_MAX_EPISODES;
  const supabase = getOrgScopedClient(orgId);

  const report: DueAtReadinessReport = {
    flagKey: "resupply.due_at_authoritative",
    status: "not_evaluated",
    evaluatedAt: now.toISOString(),
    blockers: [],
    warnings: [],
    metrics: {
      applicablePrescriptions: 0,
      openEpisodes: 0,
      addressHoldEpisodes: 0,
      missingDueAt: 0,
      agreeing: 0,
      drifting: 0,
      driftingEarlier: 0,
      driftingLater: 0,
      maxDriftLaterDays: 0,
      maxDriftEarlierDays: 0,
      unresolvable: 0,
      byStatus: {},
      byReason: {},
    },
    truncated: false,
    sampleDriftingEpisodeIds: [],
  };

  // Active prescriptions — the denominator. `head: true` so the row cap
  // cannot understate it.
  const { count: rxCount, error: rxCountErr } = await supabase
    .from("prescriptions")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  if (rxCountErr) throw rxCountErr;
  report.metrics.applicablePrescriptions = rxCount ?? 0;

  const rules = await loadOutreachRules(supabase);

  // Every episode still in the ladder, INCLUDING address_hold. A held
  // episode is parked, not finished: it still carries a cadence-derived
  // due date, and releasing the hold after the flag is on hands the
  // authoritative scan that stale date. Omitting it would let a dry-run
  // call a tenant safe that is not.
  const { rows: episodes, truncated } = await pageAll<{
    id: string;
    patient_id: string;
    prescription_id: string;
    due_at: string | null;
    status: string;
  }>(
    (from, to) =>
      supabase
        .from("episodes")
        .select("id, patient_id, prescription_id, due_at, status")
        .in("status", [...OUTREACH_OPEN_EPISODE_STATUSES])
        .order("id", { ascending: true })
        .range(from, to),
    budget,
  );
  report.truncated = truncated;
  report.metrics.openEpisodes = episodes.length;

  for (const ep of episodes) {
    report.metrics.byStatus[ep.status] =
      (report.metrics.byStatus[ep.status] ?? 0) + 1;
  }
  report.metrics.addressHoldEpisodes =
    report.metrics.byStatus.address_hold ?? 0;

  if (episodes.length === 0) {
    report.status = "ready";
    report.warnings.push(
      "No open episodes for this tenant, so there is nothing for the flag " +
        "to move. Ready by vacancy — re-assess once the tenant has a live book.",
    );
    return report;
  }

  const rxById = await loadPrescriptions(supabase, [
    ...new Set(episodes.map((e) => e.prescription_id)),
  ]);
  const patientById = await loadPatients(supabase, [
    ...new Set(episodes.map((e) => e.patient_id)),
  ]);
  const lastDispense = await loadLastDispense(supabase, [
    ...new Set(episodes.map((e) => e.patient_id)),
  ]);

  const missingSamples: string[] = [];
  const unresolvableSamples: string[] = [];

  for (const ep of episodes) {
    const rx = rxById.get(ep.prescription_id);
    const patient = patientById.get(ep.patient_id);
    if (!rx || !patient) {
      report.metrics.unresolvable += 1;
      report.metrics.byReason.missing_prescription_or_patient =
        (report.metrics.byReason.missing_prescription_or_patient ?? 0) + 1;
      if (unresolvableSamples.length < SAMPLE_LIMIT) {
        unresolvableSamples.push(ep.id);
      }
      continue;
    }

    if (!ep.due_at) {
      // The flag makes this column decide who gets contacted. A NULL is
      // not "due later" — it is a patient the authoritative scan cannot
      // see at all.
      report.metrics.missingDueAt += 1;
      report.metrics.byReason.missing_due_at =
        (report.metrics.byReason.missing_due_at ?? 0) + 1;
      if (missingSamples.length < SAMPLE_LIMIT) missingSamples.push(ep.id);
      continue;
    }

    const plan = resolveOutreachPlan({
      patient: {
        id: ep.patient_id,
        createdAt: new Date(patient.created_at),
        insurancePayer: patient.insurance_payer,
        cadenceOverrideDays: patient.cadence_override_days,
        channelPreference: patient.channel_preference,
        hasPhone: Boolean(patient.phone_e164),
      },
      prescription: { itemSku: rx.item_sku, cadenceDays: rx.cadence_days },
      rules,
      now,
    });

    const baselineRaw =
      lastDispense.get(dispenseKey(ep.patient_id, rx.item_sku)) ??
      rx.created_at;
    const baseline = Date.parse(baselineRaw);
    const storedDue = Date.parse(ep.due_at);
    if (!Number.isFinite(baseline) || !Number.isFinite(storedDue)) {
      report.metrics.unresolvable += 1;
      report.metrics.byReason.unparseable_date =
        (report.metrics.byReason.unparseable_date ?? 0) + 1;
      if (unresolvableSamples.length < SAMPLE_LIMIT) {
        unresolvableSamples.push(ep.id);
      }
      continue;
    }

    const resolvedDue = baseline + plan.cadenceDays * DAY_MS;
    const shiftMs = resolvedDue - storedDue;
    if (Math.abs(shiftMs) <= DRIFT_TOLERANCE_HOURS * 60 * 60 * 1000) {
      report.metrics.agreeing += 1;
      continue;
    }

    report.metrics.drifting += 1;
    const shiftDays = Math.round(Math.abs(shiftMs) / DAY_MS);
    if (shiftMs < 0) {
      report.metrics.driftingEarlier += 1;
      report.metrics.maxDriftEarlierDays = Math.max(
        report.metrics.maxDriftEarlierDays,
        shiftDays,
      );
      report.metrics.byReason.stored_date_too_late =
        (report.metrics.byReason.stored_date_too_late ?? 0) + 1;
    } else {
      report.metrics.driftingLater += 1;
      report.metrics.maxDriftLaterDays = Math.max(
        report.metrics.maxDriftLaterDays,
        shiftDays,
      );
      report.metrics.byReason.stored_date_too_early =
        (report.metrics.byReason.stored_date_too_early ?? 0) + 1;
    }
    if (report.sampleDriftingEpisodeIds.length < SAMPLE_LIMIT) {
      report.sampleDriftingEpisodeIds.push(ep.id);
    }
  }

  if (report.metrics.drifting > 0) {
    report.blockers.push({
      code: "due_at_drift",
      detail:
        `${report.metrics.drifting} open episode(s) carry a due date that ` +
        "disagrees with the cadence the reminder scan resolves " +
        `(${report.metrics.driftingEarlier} would move earlier, up to ` +
        `${report.metrics.maxDriftEarlierDays}d; ${report.metrics.driftingLater} ` +
        `later, up to ${report.metrics.maxDriftLaterDays}d). Turning the flag ` +
        "on now would remind those patients early or leave them silent. Run " +
        "the due-date backfill for this tenant first.",
      sampleIds: report.sampleDriftingEpisodeIds,
    });
  }
  if (report.metrics.missingDueAt > 0) {
    report.blockers.push({
      code: "missing_due_at",
      detail:
        `${report.metrics.missingDueAt} open episode(s) have no due date at ` +
        "all. With the flag on, the authoritative scan cannot see them and " +
        "those patients stop being reminded entirely.",
      sampleIds: missingSamples,
    });
  }
  if (report.metrics.unresolvable > 0) {
    report.warnings.push(
      `${report.metrics.unresolvable} episode(s) could not be evaluated ` +
        "(missing prescription/patient or an unparseable date). They are " +
        "counted, not ignored — investigate before relying on the verdict. " +
        `Sample: ${unresolvableSamples.slice(0, 3).join(", ")}`,
    );
  }
  if (truncated) {
    report.blockers.push({
      code: "assessment_truncated",
      detail:
        `The scan stopped at ${budget} episodes, so this verdict covers only ` +
        "part of the tenant's book. A partial clean read is not evidence of " +
        "a clean tenant. Re-run from the CLI, which has no window.",
    });
  }

  report.status = report.blockers.length === 0 ? "ready" : "blocked";
  return report;
}

/**
 * Assess whether `resupply.ship_evidence_required` can be turned on for
 * this tenant.
 *
 * Read-only.
 *
 * @param orgId - Tenant to assess.
 * @param options - Window, thresholds, evaluation clock.
 * @returns The full readiness report, verdict included.
 */
export async function assessShipEvidenceReadiness(
  orgId: string,
  options: ReadinessOptions = {},
): Promise<ShipEvidenceReadinessReport> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? 180;
  const threshold = options.unresolvedShipmentFailureThreshold ?? 25;
  const budget = options.maxEpisodes ?? DEFAULT_MAX_EPISODES;
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const supabase = getOrgScopedClient(orgId);

  const report: ShipEvidenceReadinessReport = {
    flagKey: "resupply.ship_evidence_required",
    status: "not_evaluated",
    evaluatedAt: now.toISOString(),
    blockers: [],
    warnings: [],
    metrics: {
      shippedWithEvidence: 0,
      viaPacwareImport: 0,
      viaAdminManual: 0,
      viaCarrier: 0,
      fulfilledNotShipped: 0,
      assumedShippedEpisodes: 0,
      shippedEpisodes: 0,
      claimsAnchoredToShipEvidence: 0,
      claimsWithoutShipEvidence: 0,
      windowDays,
    },
    pathways: { pacwareImport: false, adminManual: false, carrier: false },
    truncated: false,
    sampleUnshippedFulfillmentIds: [],
  };

  // Which evidence pathways this tenant has actually USED. Configuration
  // is not the question — a PacWare account nobody imports from writes
  // no ship dates. Provenance is recorded in `shipment_metadata.source`
  // by recordShipmentEvidence, which is the only writer.
  const { rows: shipped, truncated: shippedTruncated } = await pageAll<{
    id: string;
    shipment_metadata: { source?: string } | null;
  }>(
    (from, to) =>
      supabase
        .from("fulfillments")
        .select("id, shipment_metadata")
        .not("shipped_at", "is", null)
        .gte("shipped_at", since)
        .order("id", { ascending: true })
        .range(from, to),
    budget,
  );
  report.metrics.shippedWithEvidence = shipped.length;
  for (const f of shipped) {
    const source = f.shipment_metadata?.source;
    if (source === "pacware_import") {
      report.metrics.viaPacwareImport += 1;
      report.pathways.pacwareImport = true;
    } else if (source === "admin_manual") {
      report.metrics.viaAdminManual += 1;
      report.pathways.adminManual = true;
    } else if (source === "carrier") {
      report.metrics.viaCarrier += 1;
      report.pathways.carrier = true;
    }
  }

  // Queued-and-unshipped past the grace window: the shape of a broken or
  // absent import.
  const graceCutoff = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const { rows: unshipped, truncated: unshippedTruncated } = await pageAll<{
    id: string;
  }>(
    (from, to) =>
      supabase
        .from("fulfillments")
        .select("id")
        .is("shipped_at", null)
        .eq("status", "queued")
        .lt("created_at", graceCutoff)
        .gte("created_at", since)
        .order("id", { ascending: true })
        .range(from, to),
    budget,
  );
  report.metrics.fulfilledNotShipped = unshipped.length;
  report.sampleUnshippedFulfillmentIds = unshipped
    .slice(0, SAMPLE_LIMIT)
    .map((f) => f.id);

  // assumed_shipped vs shipped. These MUST stay distinct: the grace
  // sweep advances a ladder that never got confirmation and closes the
  // episode assumed_shipped WITHOUT touching the fulfillment, because
  // inventing a ship date for a payer is a compliance problem. If these
  // two ever collapse into one number, the flag's whole premise is gone.
  for (const [reason, key] of [
    ["assumed_shipped", "assumedShippedEpisodes"],
    ["shipped", "shippedEpisodes"],
  ] as const) {
    const { count, error } = await supabase
      .from("episodes")
      .select("id", { count: "exact", head: true })
      .eq("closed_reason", reason)
      .gte("closed_at", since);
    if (error) throw error;
    report.metrics[key] = count ?? 0;
  }

  // Claim date-of-service provenance. A claim built from a fulfillment
  // with no `shipped_at` carried a fallback date; with the flag on that
  // must not happen again, and the count says how often it already has.
  const { rows: claims, truncated: claimsTruncated } = await pageAll<{
    id: string;
    fulfillment_id: string | null;
  }>(
    (from, to) =>
      supabase
        .from("insurance_claims")
        .select("id, fulfillment_id")
        .not("fulfillment_id", "is", null)
        .gte("created_at", since)
        .order("id", { ascending: true })
        .range(from, to),
    budget,
  );
  const shippedIds = new Set(shipped.map((f) => f.id));
  for (const claim of claims) {
    if (claim.fulfillment_id && shippedIds.has(claim.fulfillment_id)) {
      report.metrics.claimsAnchoredToShipEvidence += 1;
    } else {
      report.metrics.claimsWithoutShipEvidence += 1;
    }
  }

  report.truncated = shippedTruncated || unshippedTruncated || claimsTruncated;

  const anyPathway =
    report.pathways.pacwareImport ||
    report.pathways.adminManual ||
    report.pathways.carrier;

  if (!anyPathway) {
    report.blockers.push({
      code: "no_shipment_evidence_pathway",
      detail:
        `No fulfillment in the last ${windowDays} days carries shipment ` +
        "evidence from any source. With the flag on, the next cycle waits " +
        "for evidence that never arrives, so every cycle would be advanced " +
        "by the safety-net sweep and closed assumed_shipped — which is " +
        "deliberately not a shipment and can never date a claim. Configure " +
        "the PacWare shipped-orders import, or have staff mark shipments, " +
        "and re-assess once real evidence is flowing.",
    });
  } else if (!report.pathways.pacwareImport) {
    report.warnings.push(
      "Shipment evidence is arriving only from manual entry. That works, " +
        "but it depends on a person remembering; the PacWare shipped-orders " +
        "import is the durable pathway.",
    );
  }

  if (report.metrics.fulfilledNotShipped > threshold) {
    report.blockers.push({
      code: "unresolved_shipment_backlog",
      detail:
        `${report.metrics.fulfilledNotShipped} fulfillment(s) have been queued ` +
        `for more than 30 days with no shipment evidence (threshold ${threshold}). ` +
        "That is the shape of a broken or absent import. Resolve the backlog " +
        "before making the next cycle depend on evidence.",
      sampleIds: report.sampleUnshippedFulfillmentIds,
    });
  } else if (report.metrics.fulfilledNotShipped > 0) {
    report.warnings.push(
      `${report.metrics.fulfilledNotShipped} fulfillment(s) are queued past ` +
        "the grace window with no shipment evidence — within threshold, but " +
        "worth a look.",
    );
  }

  if (
    report.metrics.assumedShippedEpisodes >
    report.metrics.shippedEpisodes + threshold
  ) {
    report.blockers.push({
      code: "assumed_shipped_dominates",
      detail:
        `${report.metrics.assumedShippedEpisodes} cycle(s) closed ` +
        `assumed_shipped versus ${report.metrics.shippedEpisodes} with real ` +
        "evidence. The ladder is being kept alive by the safety net rather " +
        "than by shipments, so the flag would change nothing except make " +
        "that dependence total.",
    });
  }

  if (report.truncated) {
    report.blockers.push({
      code: "assessment_truncated",
      detail:
        "The scan hit its row budget, so this verdict covers only part of " +
        "the tenant's history. Re-run from the CLI, which has no window.",
    });
  }

  report.status = report.blockers.length === 0 ? "ready" : "blocked";
  return report;
}

export type ReadinessReport =
  | DueAtReadinessReport
  | ShipEvidenceReadinessReport;

export const CUTOVER_FLAG_KEYS = [
  "resupply.due_at_authoritative",
  "resupply.ship_evidence_required",
] as const;

export type CutoverFlagKey = (typeof CUTOVER_FLAG_KEYS)[number];

/**
 * Assess one cutover flag by key.
 *
 * @param orgId - Tenant to assess.
 * @param flagKey - Which flag's preconditions to measure.
 * @param options - Row budget, window, thresholds, clock.
 * @returns The readiness report for that flag.
 */
export async function assessReadiness(
  orgId: string,
  flagKey: CutoverFlagKey,
  options: ReadinessOptions = {},
): Promise<ReadinessReport> {
  return flagKey === "resupply.due_at_authoritative"
    ? assessDueAtReadiness(orgId, options)
    : assessShipEvidenceReadiness(orgId, options);
}

/**
 * Current on/off state of a cutover flag for a tenant.
 *
 * Reads the row directly rather than going through the API's cached
 * `isFeatureEnabled`, for two reasons. This package must stay importable
 * from a `tsx` script that never builds the API. And the cutover console
 * has to show what is STORED, not what a 5-second process cache last
 * resolved — an operator who just flipped a flag and sees the old value
 * has no way to tell a stale cache from a failed write.
 *
 * Fails CLOSED: an unreadable flag row reports `false`, matching the
 * posture of `isFeatureEnabled` and of the flags themselves, both of
 * which are seeded OFF.
 *
 * @param orgId - Tenant.
 * @param flagKey - Cutover flag.
 * @returns Whether the flag is currently enabled.
 */
export async function readCutoverFlagState(
  orgId: string,
  flagKey: CutoverFlagKey,
): Promise<boolean> {
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await supabase
    .from("feature_flags")
    .select("enabled")
    .eq("key", flagKey)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean((data as { enabled?: boolean } | null)?.enabled);
}

// ── Loaders ──────────────────────────────────────────────────────────

/** Composite map key. A space is safe: neither part can contain one. */
function dispenseKey(patientId: string, itemSku: string): string {
  return `${patientId}::${itemSku}`;
}

async function loadOutreachRules(
  supabase: ReturnType<typeof getOrgScopedClient>,
): Promise<OutreachRule[]> {
  const { data, error } = await supabase
    .from("frequency_rules")
    .select(
      "id, priority, created_at, active, match_item_sku_prefix, match_insurance_payer, min_tenure_days, max_tenure_days, cadence_days, default_channel",
    )
    .eq("active", true);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    priority: Number(r.priority ?? 100),
    createdAt: new Date(String(r.created_at)),
    active: true,
    matchItemSkuPrefix: (r.match_item_sku_prefix as string | null) ?? null,
    matchInsurancePayer: (r.match_insurance_payer as string | null) ?? null,
    minTenureDays: (r.min_tenure_days as number | null) ?? null,
    maxTenureDays: (r.max_tenure_days as number | null) ?? null,
    cadenceDays: Number(r.cadence_days),
    defaultChannel: (r.default_channel as OutreachChannel | null) ?? null,
  }));
}

async function loadPrescriptions(
  supabase: ReturnType<typeof getOrgScopedClient>,
  ids: readonly string[],
): Promise<
  Map<string, { item_sku: string; cadence_days: number; created_at: string }>
> {
  const byId = new Map<
    string,
    { item_sku: string; cadence_days: number; created_at: string }
  >();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await supabase
      .from("prescriptions")
      .select("id, item_sku, cadence_days, created_at")
      .in("id", ids.slice(i, i + READ_CHUNK));
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      byId.set(String(r.id), {
        item_sku: String(r.item_sku),
        cadence_days: Number(r.cadence_days),
        created_at: String(r.created_at),
      });
    }
  }
  return byId;
}

interface PatientCadenceFields {
  created_at: string;
  insurance_payer: string | null;
  cadence_override_days: number | null;
  channel_preference: OutreachChannel | null;
  phone_e164: string | null;
}

async function loadPatients(
  supabase: ReturnType<typeof getOrgScopedClient>,
  ids: readonly string[],
): Promise<Map<string, PatientCadenceFields>> {
  const byId = new Map<string, PatientCadenceFields>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await supabase
      .from("patients")
      .select(
        "id, created_at, insurance_payer, cadence_override_days, channel_preference, phone_e164",
      )
      .in("id", ids.slice(i, i + READ_CHUNK));
    if (error) throw error;
    for (const p of (data ?? []) as Array<Record<string, unknown>>) {
      byId.set(String(p.id), {
        created_at: String(p.created_at),
        insurance_payer: (p.insurance_payer as string | null) ?? null,
        cadence_override_days:
          (p.cadence_override_days as number | null) ?? null,
        channel_preference:
          (p.channel_preference as OutreachChannel | null) ?? null,
        phone_e164: (p.phone_e164 as string | null) ?? null,
      });
    }
  }
  return byId;
}

/**
 * Last dispense per (patient, sku) — the same anchor the reminder scan
 * uses: MAX(COALESCE(shipped_at, created_at)) over non-cancelled
 * fulfillments. Paged inside each chunk: 200 patients can own far more
 * than one page of dispense history, and an unpaginated read would
 * silently pick a stale anchor and manufacture drift that is not there.
 */
async function loadLastDispense(
  supabase: ReturnType<typeof getOrgScopedClient>,
  patientIds: readonly string[],
): Promise<Map<string, string>> {
  const last = new Map<string, string>();
  for (let i = 0; i < patientIds.length; i += READ_CHUNK) {
    const chunk = patientIds.slice(i, i + READ_CHUNK);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("fulfillments")
        .select("patient_id, item_sku, shipped_at, created_at")
        .in("patient_id", chunk)
        .neq("status", "cancelled")
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      for (const f of rows) {
        const at = (f.shipped_at as string | null) ?? String(f.created_at);
        const key = dispenseKey(String(f.patient_id), String(f.item_sku));
        const prev = last.get(key);
        if (!prev || at > prev) last.set(key, at);
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return last;
}
