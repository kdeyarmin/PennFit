// Eligibility re-verification batch (Biller #31 — the write half).
//
// The read half (`buildVerificationWorklist`) ranks active coverages by
// re-verification urgency. This half ACTS on that ranking: pick the most
// urgent coverages that aren't already mid-flight (throttled by their
// last 270 attempt), cap the run, and fire a fresh 270 for each through
// the existing per-coverage `verifyEligibility` round-trip.
//
// Outbound clearinghouse traffic, so two safety rails:
//   * a per-run `cap` (never blast the whole panel at once), and
//   * `minHoursBetweenAttempts` — skip any coverage whose last 270 went
//     out inside the window, so a still-pending check (271 not yet
//     parsed, so `verified_at` hasn't moved) doesn't re-fire every run.
//
// PHI posture: counts + coverage ids only. No member ids, no names.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import {
  buildVerificationWorklist,
  type VerificationWorkItem,
} from "./eligibility-worklist";
import {
  verifyEligibility,
  type VerifyEligibilityInput,
  type VerifyEligibilityResult,
} from "./eligibility-verifier";

const SYSTEM_ACTOR_EMAIL = "system:worker:eligibility-reverify";

export interface BatchSelectOpts {
  cap: number;
  minHoursBetweenAttempts: number;
  asOf?: string;
}

/**
 * Pure: from the ranked worklist, choose which coverages to fire a 270
 * for this run. Drops `ok` (recently verified, not terminating), drops
 * any attempted within the throttle window, sorts most-urgent first, and
 * caps. No I/O — unit-tested directly.
 */
export function selectReverificationBatch(
  items: readonly VerificationWorkItem[],
  lastAttemptByCoverage: ReadonlyMap<string, string>,
  opts: BatchSelectOpts,
): string[] {
  const nowMs = opts.asOf ? Date.parse(opts.asOf) : Date.now();
  const baseMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
  const throttleMs = Math.max(0, opts.minHoursBetweenAttempts) * 3_600_000;

  return items
    .filter((i) => i.status !== "ok")
    .filter((i) => {
      const last = lastAttemptByCoverage.get(i.id);
      if (!last) return true;
      const lastMs = Date.parse(last);
      if (Number.isNaN(lastMs)) return true;
      return baseMs - lastMs >= throttleMs;
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.max(0, opts.cap))
    .map((i) => i.id);
}

export interface ReverifyBatchOpts {
  /** Max 270s to fire this run. Default 50. */
  cap?: number;
  /** Skip coverages attempted within this many hours. Default 168 (7d). */
  minHoursBetweenAttempts?: number;
  /** verified_at older than this is "stale". Default 30. */
  staleDays?: number;
  /** Stamped on each eligibility_checks row. Default a system actor. */
  requestedByEmail?: string;
}

export interface ReverifyBatchResult {
  /** Active coverages loaded. */
  scanned: number;
  /** Coverages needing a check (status !== ok). */
  due: number;
  /** Chosen this run (after throttle + cap). */
  selected: number;
  /** verify() invocations that returned (didn't throw). */
  fired: number;
  /** …of which the 270 upload succeeded. */
  uploadOk: number;
  /** verify() threw before it could attempt (e.g. paper-only payer). */
  errored: number;
}

export interface ReverifyBatchDeps {
  /** Injected for tests; defaults to the real round-trip. */
  verify?: (input: VerifyEligibilityInput) => Promise<VerifyEligibilityResult>;
  /** Sleep between sends so a rate-limited clearinghouse doesn't 429. */
  throttleMs?: number;
}

/**
 * Load active coverages → rank → select (throttled, capped) → fire a 270
 * for each. Idempotent in the sense that re-running inside the throttle
 * window is a no-op. Fail-soft per coverage. Returns a counts summary.
 */
export async function runEligibilityReverificationBatch(
  opts: ReverifyBatchOpts = {},
  deps: ReverifyBatchDeps = {},
): Promise<ReverifyBatchResult> {
  const supabase = getSupabaseServiceRoleClient();
  const verify = deps.verify ?? verifyEligibility;
  const throttleMs = deps.throttleMs ?? 200;
  const cap = opts.cap ?? 50;
  const minHoursBetweenAttempts = opts.minHoursBetweenAttempts ?? 168;
  const staleDays = opts.staleDays ?? 30;
  const requestedByEmail = opts.requestedByEmail ?? SYSTEM_ACTOR_EMAIL;

  const result: ReverifyBatchResult = {
    scanned: 0,
    due: 0,
    selected: 0,
    fired: 0,
    uploadOk: 0,
    errored: 0,
  };

  const todayIso = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select(
      "id, patient_id, rank, payer_name, member_id, verified_at, termination_date",
    )
    .or(`termination_date.is.null,termination_date.gte.${todayIso}`)
    .limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  result.scanned = rows.length;

  const worklist = buildVerificationWorklist(
    rows.map((r) => ({
      id: String(r.id),
      patientId: String(r.patient_id),
      rank: String(r.rank ?? ""),
      payerName: typeof r.payer_name === "string" ? r.payer_name : null,
      memberIdTail: null, // selection doesn't need it
      verifiedAt: typeof r.verified_at === "string" ? r.verified_at : null,
      terminationDate:
        typeof r.termination_date === "string" ? r.termination_date : null,
    })),
    { staleDays },
  );
  const candidates = worklist.items.filter((i) => i.status !== "ok");
  result.due = candidates.length;
  if (candidates.length === 0) return result;

  // Most-recent attempt per coverage (any status — a still-pending 270
  // counts so we don't re-fire it).
  const candidateIds = candidates.map((i) => i.id);
  const lastAttempt = new Map<string, string>();
  const { data: checks } = await supabase
    .schema("resupply")
    .from("eligibility_checks")
    .select("insurance_coverage_id, requested_at")
    .in("insurance_coverage_id", candidateIds)
    .order("requested_at", { ascending: false });
  for (const c of (checks ?? []) as Array<{
    insurance_coverage_id: string;
    requested_at: string;
  }>) {
    if (!lastAttempt.has(c.insurance_coverage_id)) {
      lastAttempt.set(c.insurance_coverage_id, c.requested_at);
    }
  }

  const selected = selectReverificationBatch(worklist.items, lastAttempt, {
    cap,
    minHoursBetweenAttempts,
  });
  result.selected = selected.length;

  const patientByCoverage = new Map(
    rows.map((r) => [String(r.id), String(r.patient_id)]),
  );

  for (const coverageId of selected) {
    const patientId = patientByCoverage.get(coverageId);
    if (!patientId) {
      result.errored += 1;
      continue;
    }
    try {
      const r = await verify({
        insuranceCoverageId: coverageId,
        patientId,
        requestedByEmail,
      });
      result.fired += 1;
      if (r.uploadOk) result.uploadOk += 1;
    } catch (err) {
      // Per-coverage failure (paper-only payer, missing data) must not
      // abort the batch. Coverage id only — no PHI.
      logger.warn(
        { err, coverageId },
        "eligibility reverify-batch: verify threw",
      );
      result.errored += 1;
    }
    if (throttleMs > 0) {
      await new Promise((res) => setTimeout(res, throttleMs));
    }
  }

  return result;
}
