// Auto-submit engine — closes the last loop on billing automation.
//
// The auto-workflow engine (auto-workflow-engine.ts) already scores +
// AI-scrubs draft claims and analyses denials, but it never SENDS the
// clean, ready ones — a human has to push every batch. This engine
// selects the claims that are genuinely ready and submits them through
// the same Office Ally batch core used by the manual route, so the two
// paths can never drift.
//
// "Ready to submit" is the STRICTEST gate (per the product decision):
//
//   1. status = 'draft'
//   2. preflightClaim() returns zero blocking errors (readyToSubmit)
//   3. the claim's coverage has a parsed 270/271 on file showing
//      ACTIVE eligibility, no older than ELIGIBILITY_FRESH_DAYS
//
// Claims that fail any gate are returned in `excluded` with a reason so
// the worklist UI can show "why isn't this one ready?" without a second
// round-trip.
//
// Two entry points share this core:
//   * selectSubmissionReadyClaims() — read-only preview (the worklist).
//   * runAutoSubmitBatch()          — select + submit, used by BOTH the
//     operator "approve & submit" route and the opt-in cron job.
//
// PHI posture: patient + payer NAMES are joined for the admin worklist
// (an admin-gated API response, never a log line). Nothing in this
// module logs names — only counts + ids ever reach the logger. The
// Office Ally batch core owns the EDI build and never logs the payload.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { preflightClaim } from "./claim-preflight";
import {
  executeOfficeAllyBatchSubmit,
  type BatchSubmitInput,
  type BatchSubmitResult,
} from "./office-ally-batch";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/** A parsed 270/271 older than this no longer counts as current. */
export const ELIGIBILITY_FRESH_DAYS = 90;
/** How many draft claims to scan per call. Bounds preflight cost. */
export const DEFAULT_SCAN_CAP = 300;
/** How many ready claims to submit in a single run (operator or cron). */
export const DEFAULT_MAX_CLAIMS_PER_RUN = 50;
/** Hard cap on claims per 837P file — matches the manual batch route. */
export const MAX_CLAIMS_PER_BATCH = 100;
/** Upper bound on parsed-eligibility rows read in one selection pass. */
export const ELIGIBILITY_ROW_SCAN_LIMIT = 2000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ExclusionReason =
  | "no_payer_profile"
  | "no_coverage"
  | "eligibility_missing"
  | "eligibility_inactive"
  | "eligibility_stale"
  | "preflight_blocked";

export interface ReadyClaim {
  claimId: string;
  patientId: string;
  patientName: string;
  payerProfileId: string;
  payerName: string;
  totalBilledCents: number;
  dateOfService: string | null;
  /** responded_at of the active 270/271 that cleared the eligibility gate. */
  eligibilityVerifiedAt: string;
}

/** One payer's worth of ready claims — the logical worklist grouping. */
export interface ReadyGroup {
  payerProfileId: string;
  payerName: string;
  claimCount: number;
  totalBilledCents: number;
  claims: ReadyClaim[];
}

export interface ExcludedClaim {
  claimId: string;
  patientId: string;
  reason: ExclusionReason;
  detail: string;
}

export interface SubmissionReadiness {
  groups: ReadyGroup[];
  readyClaimCount: number;
  readyPayerCount: number;
  readyTotalBilledCents: number;
  excluded: ExcludedClaim[];
  scannedCount: number;
  generatedAt: string;
}

// ── Pure helpers (unit-tested without a DB) ─────────────────────────

export type EligibilityVerdict = "ok" | "missing" | "inactive" | "stale";

/**
 * Decide whether a coverage's latest parsed eligibility result clears
 * the active-coverage gate. Pure so the freshness + active-flag rules
 * can be exercised without a database.
 */
export function classifyEligibility(
  latest: { isActive: boolean | null; respondedAt: string | null } | undefined,
  opts: { nowMs: number; freshDays?: number },
): EligibilityVerdict {
  if (!latest) return "missing";
  if (latest.isActive !== true) return "inactive";
  if (!latest.respondedAt) return "stale";
  const respondedMs = Date.parse(latest.respondedAt);
  if (!Number.isFinite(respondedMs)) return "stale";
  const freshDays = opts.freshDays ?? ELIGIBILITY_FRESH_DAYS;
  if (opts.nowMs - respondedMs > freshDays * MS_PER_DAY) return "stale";
  return "ok";
}

/**
 * Split ready claims into submittable batches: one batch per payer, each
 * no larger than `maxPerBatch` (so a payer with 250 ready claims yields
 * 100 + 100 + 50). Each batch becomes exactly one 837P file. Pure.
 */
export function chunkClaimsByPayer(
  claims: ReadyClaim[],
  maxPerBatch: number = MAX_CLAIMS_PER_BATCH,
): Array<{ payerProfileId: string; payerName: string; claimIds: string[] }> {
  const cap = Math.max(1, maxPerBatch);
  const byPayer = new Map<string, ReadyClaim[]>();
  for (const c of claims) {
    const list = byPayer.get(c.payerProfileId) ?? [];
    list.push(c);
    byPayer.set(c.payerProfileId, list);
  }
  const batches: Array<{
    payerProfileId: string;
    payerName: string;
    claimIds: string[];
  }> = [];
  for (const [payerProfileId, list] of byPayer) {
    for (let i = 0; i < list.length; i += cap) {
      const slice = list.slice(i, i + cap);
      batches.push({
        payerProfileId,
        payerName: slice[0]?.payerName ?? "",
        claimIds: slice.map((c) => c.claimId),
      });
    }
  }
  return batches;
}

/** Group ready claims into per-payer worklist rows (no size cap). */
export function groupReadyClaims(claims: ReadyClaim[]): ReadyGroup[] {
  const byPayer = new Map<string, ReadyGroup>();
  for (const c of claims) {
    const existing = byPayer.get(c.payerProfileId);
    if (existing) {
      existing.claims.push(c);
      existing.claimCount += 1;
      existing.totalBilledCents += c.totalBilledCents;
    } else {
      byPayer.set(c.payerProfileId, {
        payerProfileId: c.payerProfileId,
        payerName: c.payerName,
        claimCount: 1,
        totalBilledCents: c.totalBilledCents,
        claims: [c],
      });
    }
  }
  return [...byPayer.values()].sort((a, b) => b.claimCount - a.claimCount);
}

// ── DB-bound selection ──────────────────────────────────────────────

export interface SelectReadyOpts {
  /** Cap the number of ready claims returned (preflight is run up to this). */
  maxClaims?: number;
  /** Cap the draft-claim scan window. */
  scanCap?: number;
  /** Override eligibility freshness window (days). */
  freshDays?: number;
  /** Only consider claims for this payer profile. */
  payerProfileId?: string;
  /** Restrict the scan to these specific draft claim ids (the operator
   *  "approve & submit" path). When set, every one of these claims is
   *  evaluated against the gate regardless of age-ranking, so an approved
   *  claim is never silently dropped by the per-run cap. */
  claimIds?: string[];
  /** Injectable for tests. */
  supabase?: SupabaseClient;
  /** Injectable for tests (defaults to the real preflight). */
  preflight?: (
    claimId: string,
  ) => Promise<{ readyToSubmit: boolean; errorCount: number }>;
  /** Stable clock for tests. */
  nowMs?: number;
}

interface DraftClaimRow {
  id: string;
  patient_id: string;
  payer_profile_id: string | null;
  insurance_coverage_id: string | null;
  total_billed_cents: number;
  date_of_service: string | null;
}

/**
 * Find the draft claims that are ready to transmit right now. Returns
 * both the per-payer ready groups and the excluded claims (with the
 * reason each failed the gate).
 */
export async function selectSubmissionReadyClaims(
  opts: SelectReadyOpts = {},
): Promise<SubmissionReadiness> {
  const supabase = opts.supabase ?? getSupabaseServiceRoleClient();
  const preflight = opts.preflight ?? preflightClaim;
  const nowMs = opts.nowMs ?? Date.now();
  const maxClaims = opts.maxClaims ?? DEFAULT_MAX_CLAIMS_PER_RUN;
  // When a specific claim-id set is supplied (operator approval), the
  // scan must cover all of them so none is dropped by the default cap.
  const scanCap =
    opts.scanCap ??
    (opts.claimIds
      ? Math.max(DEFAULT_SCAN_CAP, opts.claimIds.length)
      : DEFAULT_SCAN_CAP);

  const excluded: ExcludedClaim[] = [];

  // 1. Pull the oldest draft claims (oldest first → submit the claims
  //    closest to their timely-filing deadline before newer ones).
  let filter = supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, patient_id, payer_profile_id, insurance_coverage_id, total_billed_cents, date_of_service",
    )
    .eq("status", "draft");
  if (opts.payerProfileId) {
    filter = filter.eq("payer_profile_id", opts.payerProfileId);
  }
  if (opts.claimIds && opts.claimIds.length > 0) {
    filter = filter.in("id", opts.claimIds);
  }
  const { data: draftRows, error } = await filter
    .order("created_at", { ascending: true })
    .limit(scanCap);
  if (error) throw error;
  const drafts = (draftRows ?? []) as DraftClaimRow[];

  // 2. Cheap structural gate first (avoids preflight on obvious misses).
  const structurallyOk: DraftClaimRow[] = [];
  for (const c of drafts) {
    if (!c.payer_profile_id) {
      excluded.push({
        claimId: c.id,
        patientId: c.patient_id,
        reason: "no_payer_profile",
        detail: "Claim has no payer profile selected.",
      });
      continue;
    }
    if (!c.insurance_coverage_id) {
      excluded.push({
        claimId: c.id,
        patientId: c.patient_id,
        reason: "no_coverage",
        detail: "Claim has no insurance coverage linked.",
      });
      continue;
    }
    structurallyOk.push(c);
  }

  // 3. Eligibility gate — one batched read for the latest parsed 271 per
  //    coverage, then classify each claim.
  const coverageIds = [
    ...new Set(structurallyOk.map((c) => c.insurance_coverage_id!)),
  ];
  const latestByCoverage = await loadLatestParsedEligibility(
    supabase,
    coverageIds,
  );
  const eligibilityOk: DraftClaimRow[] = [];
  for (const c of structurallyOk) {
    const latest = latestByCoverage.get(c.insurance_coverage_id!);
    const verdict = classifyEligibility(latest, {
      nowMs,
      freshDays: opts.freshDays,
    });
    if (verdict === "ok") {
      eligibilityOk.push(c);
    } else {
      excluded.push({
        claimId: c.id,
        patientId: c.patient_id,
        reason:
          verdict === "missing"
            ? "eligibility_missing"
            : verdict === "inactive"
              ? "eligibility_inactive"
              : "eligibility_stale",
        detail:
          verdict === "missing"
            ? "No parsed 270/271 on file for this coverage."
            : verdict === "inactive"
              ? "Latest 271 reports the coverage is not active."
              : `Latest 271 is older than ${opts.freshDays ?? ELIGIBILITY_FRESH_DAYS} days; re-verify first.`,
      });
    }
  }

  // 4. Preflight gate — the expensive per-claim check, bounded by
  //    maxClaims. Claims beyond the cap that passed eligibility are
  //    simply left for the next run (not marked excluded).
  const readyRows: DraftClaimRow[] = [];
  for (const c of eligibilityOk) {
    if (readyRows.length >= maxClaims) break;
    const summary = await preflight(c.id);
    if (summary.readyToSubmit) {
      readyRows.push(c);
    } else {
      excluded.push({
        claimId: c.id,
        patientId: c.patient_id,
        reason: "preflight_blocked",
        detail: `Preflight found ${summary.errorCount} blocking issue${
          summary.errorCount === 1 ? "" : "s"
        }.`,
      });
    }
  }

  // 5. Join payer + patient display names for the ready claims only.
  const eligibilityWhenByClaim = new Map<string, string>();
  for (const c of eligibilityOk) {
    const latest = latestByCoverage.get(c.insurance_coverage_id!);
    if (latest?.respondedAt) {
      eligibilityWhenByClaim.set(c.id, latest.respondedAt);
    }
  }
  const payerNames = await loadPayerNames(supabase, [
    ...new Set(readyRows.map((c) => c.payer_profile_id!)),
  ]);
  const patientNames = await loadPatientNames(supabase, [
    ...new Set(readyRows.map((c) => c.patient_id)),
  ]);

  const ready: ReadyClaim[] = readyRows.map((c) => ({
    claimId: c.id,
    patientId: c.patient_id,
    patientName: patientNames.get(c.patient_id) ?? "(unknown patient)",
    payerProfileId: c.payer_profile_id!,
    payerName: payerNames.get(c.payer_profile_id!) ?? "(unknown payer)",
    totalBilledCents: c.total_billed_cents,
    dateOfService: c.date_of_service,
    eligibilityVerifiedAt: eligibilityWhenByClaim.get(c.id) ?? "",
  }));

  const groups = groupReadyClaims(ready);
  return {
    groups,
    readyClaimCount: ready.length,
    readyPayerCount: groups.length,
    readyTotalBilledCents: ready.reduce((s, c) => s + c.totalBilledCents, 0),
    excluded,
    scannedCount: drafts.length,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

async function loadLatestParsedEligibility(
  supabase: SupabaseClient,
  coverageIds: string[],
): Promise<
  Map<string, { isActive: boolean | null; respondedAt: string | null }>
> {
  const map = new Map<
    string,
    { isActive: boolean | null; respondedAt: string | null }
  >();
  if (coverageIds.length === 0) return map;
  const { data, error } = await supabase
    .schema("resupply")
    .from("eligibility_checks")
    .select("insurance_coverage_id, is_active, responded_at")
    .in("insurance_coverage_id", coverageIds)
    .eq("status", "parsed")
    // Newest first, NULLS LAST — Postgres defaults to NULLS FIRST on a
    // DESC sort, which would let a parsed row with a null responded_at
    // shadow the real latest 271 and flip a fresh-active coverage to
    // "stale". nullsFirst:false keeps timestamped rows ahead of nulls.
    .order("responded_at", { ascending: false, nullsFirst: false })
    // Bound the read so the "first seen per coverage = latest" reduction
    // is deterministic regardless of the server's max-rows setting. The
    // scan is already capped to <= scanCap coverages upstream.
    .limit(ELIGIBILITY_ROW_SCAN_LIMIT);
  // Surface infra errors instead of silently returning an empty map (which
  // would mis-classify every claim as eligibility_missing → false "0 ready").
  if (error) throw error;
  for (const row of data ?? []) {
    const cid = row.insurance_coverage_id as string;
    // Rows arrive newest-first; keep the first (latest) seen per coverage.
    if (!map.has(cid)) {
      map.set(cid, {
        isActive: (row.is_active as boolean | null) ?? null,
        respondedAt: (row.responded_at as string | null) ?? null,
      });
    }
  }
  return map;
}

async function loadPayerNames(
  supabase: SupabaseClient,
  payerProfileIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (payerProfileIds.length === 0) return map;
  const { data, error } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("id, display_name")
    .in("id", payerProfileIds);
  if (error) throw error;
  for (const row of data ?? []) {
    map.set(row.id as string, (row.display_name as string) ?? "");
  }
  return map;
}

async function loadPatientNames(
  supabase: SupabaseClient,
  patientIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (patientIds.length === 0) return map;
  const { data, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, legal_last_name")
    .in("id", patientIds);
  if (error) throw error;
  for (const row of data ?? []) {
    const first = (row.legal_first_name as string | null) ?? "";
    const last = (row.legal_last_name as string | null) ?? "";
    map.set(row.id as string, `${first} ${last}`.trim());
  }
  return map;
}

// ── Run (select + submit) ───────────────────────────────────────────

export interface RunAutoSubmitOpts {
  /** When set, only these claim ids are submitted — and only if they're
   *  still in the ready set (a safety re-check against the live gate).
   *  When omitted, every ready claim (up to maxClaims) is submitted. */
  approvedClaimIds?: string[];
  maxClaims?: number;
  maxClaimsPerBatch?: number;
  submittedByEmail: string;
  submittedByUserId?: string | null;
  /** "operator" (staged approval) or "cron" (unattended). Audit only. */
  triggeredBy: "operator" | "cron";
  ip?: string | null;
  userAgent?: string | null;
}

export interface AutoSubmitRunResult {
  triggeredBy: "operator" | "cron";
  /** 837P files transmitted (one per payer batch). */
  batchesAttempted: number;
  /** Claims in batches whose upload succeeded. */
  claimsSubmitted: number;
  submissions: Array<{
    submissionId: string;
    payerProfileId: string;
    claimCount: number;
    uploadOk: boolean;
    isaControlNumber: string;
  }>;
  /** Per-batch hard failures (ok:false from the batch core). */
  failures: Array<{ payerProfileId: string; kind: string }>;
  /** Approved ids that were no longer in the ready set when we ran. */
  skippedNotReady: string[];
  readyClaimCount: number;
}

export interface RunAutoSubmitDeps {
  select?: (opts: SelectReadyOpts) => Promise<SubmissionReadiness>;
  submit?: (input: BatchSubmitInput) => Promise<BatchSubmitResult>;
}

/**
 * Select the ready claims and submit them per payer. Shared by the
 * operator "approve & submit" route and the opt-in cron job. The cron
 * gates this behind the billing.auto_submit_claims feature flag BEFORE
 * calling here; the operator path does not (an explicit human action).
 */
export async function runAutoSubmitBatch(
  opts: RunAutoSubmitOpts,
  deps: RunAutoSubmitDeps = {},
): Promise<AutoSubmitRunResult> {
  const select = deps.select ?? selectSubmissionReadyClaims;
  const submit = deps.submit ?? executeOfficeAllyBatchSubmit;
  const maxClaims = opts.maxClaims ?? DEFAULT_MAX_CLAIMS_PER_RUN;
  const maxClaimsPerBatch = opts.maxClaimsPerBatch ?? MAX_CLAIMS_PER_BATCH;

  // Dedupe approved ids so a repeated id can't be sent twice in one 837P
  // (the batch core rejects the whole batch as "some_claims_not_found"
  // when the id count and matched-row count diverge).
  const approvedClaimIds =
    opts.approvedClaimIds && opts.approvedClaimIds.length > 0
      ? [...new Set(opts.approvedClaimIds)]
      : null;

  // Operator-approval path: evaluate EXACTLY the approved claims (scoped
  // by id) so a claim the operator picked is never silently dropped by
  // the per-run cap that bounds the unattended "submit all" scan.
  const readiness = await select(
    approvedClaimIds
      ? { claimIds: approvedClaimIds, maxClaims: approvedClaimIds.length }
      : { maxClaims },
  );
  const readyById = new Map<string, ReadyClaim>();
  for (const g of readiness.groups) {
    for (const c of g.claims) readyById.set(c.claimId, c);
  }

  let targetClaims: ReadyClaim[];
  const skippedNotReady: string[] = [];
  if (approvedClaimIds) {
    targetClaims = [];
    for (const id of approvedClaimIds) {
      const claim = readyById.get(id);
      if (claim) targetClaims.push(claim);
      else skippedNotReady.push(id);
    }
  } else {
    targetClaims = [...readyById.values()].slice(0, maxClaims);
  }

  const batches = chunkClaimsByPayer(targetClaims, maxClaimsPerBatch);

  const submissions: AutoSubmitRunResult["submissions"] = [];
  const failures: AutoSubmitRunResult["failures"] = [];
  let claimsSubmitted = 0;
  for (const batch of batches) {
    const result = await submit({
      claimIds: batch.claimIds,
      adminEmail: opts.submittedByEmail,
      adminUserId: opts.submittedByUserId ?? null,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
    });
    if (result.ok) {
      submissions.push({
        submissionId: result.submissionId,
        payerProfileId: batch.payerProfileId,
        claimCount: result.claimCount,
        uploadOk: result.uploadOk,
        isaControlNumber: result.isaControlNumber,
      });
      if (result.uploadOk) claimsSubmitted += result.claimCount;
    } else {
      failures.push({
        payerProfileId: batch.payerProfileId,
        kind: result.kind,
      });
    }
  }

  return {
    triggeredBy: opts.triggeredBy,
    batchesAttempted: batches.length,
    claimsSubmitted,
    submissions,
    failures,
    skippedNotReady,
    readyClaimCount: readiness.readyClaimCount,
  };
}
