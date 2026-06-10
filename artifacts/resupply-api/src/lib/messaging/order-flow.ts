// order-flow.ts — shared "place an order from the active prescription"
// logic used by both the SMS-confirm path AND the email-link-click path.
//
// What it does:
//   Given a (conversationId), find the bound patient + episode + the
//   active prescription, transition the episode to `confirmed`, and
//   create one fulfillment row per prescribed item in `queued` state.
//   The Pacware CSV exporter (separate worker job) picks queued rows
//   up on its next sweep — we never call Pacware inline.
//
// What it does NOT do:
//   - Touch the patient's encrypted PHI columns. The fulfillment rows
//     join back to the patient through `patientId` — we never read or
//     mutate name/DOB/address here.
//   - Audit. The caller audits `messaging.order.confirmed` so the audit
//     row carries the correct channel context (sms vs email link).
//   - Send any outbound message. The caller renders the response (TwiML
//     for SMS, HTML for email click) — order-flow only mutates state.
//
// Idempotency:
//   If the episode is already `confirmed` or `fulfilled` we DO NOT
//   double-create fulfillments. We return `{status: 'already_confirmed'}`
//   so the caller can render "you've already confirmed this order".
//   Re-confirming a `declined` episode is allowed and flips it back to
//   `confirmed` — admins have asked for this so a patient who
//   accidentally typed NO can still ship.
//
// Concurrency posture:
//   The original SQL path opened a transaction and locked the
//   episode row with `SELECT … FOR UPDATE` so two concurrent confirms
//   (e.g. patient clicks email AND replies YES via SMS within the
//   same second) couldn't both insert fulfillment rows.
//
//   PostgREST has neither transactions nor row-level locks. The
//   substitute is a conditional UPDATE that atomically claims the
//   episode by transitioning status from any non-terminal state to
//   `confirmed` ONLY when it isn't already confirmed/fulfilled.
//   Postgres serialises the UPDATEs at the row level: the loser
//   matches 0 rows and short-circuits to `already_confirmed` without
//   inserting fulfillments. The defensive "fulfillments already exist"
//   re-check after the claim catches the rare misordered-write case
//   where a prior crash left fulfillments behind without flipping
//   the status.

import {
  getSupabaseServiceRoleClient,
  type Json,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";

import { resolveFulfillmentSku } from "../backorder/resolve-fulfillment-sku";
import {
  consultCoverageEligibilityForCoverage,
  type CoverageBlock,
} from "../billing/coverage-eligibility";
import {
  resolveSkuEntitlement,
  type SkuEntitlement,
} from "../entitlement/resolve-sku-entitlement";
import { isFeatureEnabled } from "../feature-flags";
import { logger } from "../logger";

export interface NotEligibleEntitlement {
  status: string;
  reason: string;
  /** ISO timestamp of the earliest payable date. */
  eligibleOn: string;
  daysUntilEligible: number;
  hcpcsCode: string;
}

/**
 * Continued-use snapshot that flagged a confirmation for CSR review.
 * Counts only — never per-night detail — so it's safe in logs and
 * alert snapshots.
 */
export interface UsageReviewBlock {
  windowDays: number;
  dataNights: number;
  compliantNights: number;
}

export type PlaceOrderResult =
  | {
      status: "ok";
      patientId: string;
      episodeId: string;
      fulfillmentIds: string[];
    }
  | { status: "already_confirmed"; patientId: string; episodeId: string }
  | {
      status: "not_eligible";
      patientId: string;
      episodeId: string;
      entitlement: NotEligibleEntitlement;
    }
  | {
      status: "coverage_blocked";
      patientId: string;
      episodeId: string;
      coverage: CoverageBlock;
    }
  | {
      status: "usage_review";
      patientId: string;
      episodeId: string;
      usage: UsageReviewBlock;
    }
  | { status: "conversation_not_found" }
  | { status: "episode_not_found" }
  | { status: "no_active_prescription" };

export interface PlaceOrderInput {
  conversationId: string;
}

export async function placeResupplyOrderForConversation(
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const supabase = getSupabaseServiceRoleClient();

  // 1. Resolve the conversation → episode + patient.
  const { data: conv, error: convErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("id, patient_id, episode_id")
    .eq("id", input.conversationId)
    .limit(1)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!conv) return { status: "conversation_not_found" };
  // Post-0033 conversations.episode_id / patient_id are nullable so
  // in-app shop-customer threads can omit them. Order-flow only
  // makes sense for patient-flow conversations (SMS/email replies
  // that confirm a fulfillment); a missing episode_id here means
  // the caller has wired this helper to an in-app row by mistake.
  if (!conv.episode_id || !conv.patient_id) {
    return { status: "episode_not_found" };
  }
  const convEpisodeId = conv.episode_id;
  const convPatientId = conv.patient_id;

  // 2. Read the episode so we can short-circuit on already_confirmed
  // BEFORE the conditional UPDATE — saves a write round-trip in the
  // hot path where the patient just hit refresh on their email click.
  const { data: episode, error: episodeErr } = await supabase
    .schema("resupply")
    .from("episodes")
    .select("id, patient_id, prescription_id, status")
    .eq("id", convEpisodeId)
    .limit(1)
    .maybeSingle();
  if (episodeErr) throw episodeErr;
  if (!episode) return { status: "episode_not_found" };

  if (episode.status === "confirmed" || episode.status === "fulfilled") {
    return {
      status: "already_confirmed",
      patientId: convPatientId,
      episodeId: convEpisodeId,
    };
  }

  // 3. Find the active prescription that backs this episode. Look
  // up by id (not by patient + sku) because the episode already
  // pinned a specific script at creation time.
  if (!episode.prescription_id) return { status: "no_active_prescription" };
  const { data: rx, error: rxErr } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select("id, item_sku")
    .eq("id", episode.prescription_id)
    .limit(1)
    .maybeSingle();
  if (rxErr) throw rxErr;
  if (!rx) return { status: "no_active_prescription" };

  // 3b. Entitlement guard (feature-flagged). Block a reorder that
  // isn't yet payable under the replacement schedule — too soon since
  // the last dispense, or over the per-period quantity cap — so we
  // don't ship a claim that denies and leaves the patient with the
  // bill. FAIL OPEN: an unmapped SKU (resolveSkuEntitlement → null) or
  // ANY lookup error allows the confirmation through. We never strand
  // a legitimate reorder on our own eligibility bug. The guard runs
  // before the atomic claim so a blocked episode is left untouched
  // (stays pending) for the CSR to work.
  if (await isFeatureEnabled("resupply.entitlement_enforcement")) {
    try {
      const entitlement = await resolveSkuEntitlement(supabase, {
        patientId: episode.patient_id,
        itemSku: rx.item_sku,
      });
      if (entitlement && !entitlement.eligible) {
        await raiseTooSoonAlert(supabase, episode.patient_id, entitlement);
        return {
          status: "not_eligible",
          patientId: episode.patient_id,
          episodeId: episode.id,
          entitlement: {
            status: entitlement.status,
            reason: entitlement.reason,
            eligibleOn: entitlement.eligibleOn.toISOString(),
            daysUntilEligible: entitlement.daysUntilEligible,
            hcpcsCode: entitlement.hcpcsCode,
          },
        };
      }
    } catch (err) {
      logger.warn(
        {
          event: "resupply.entitlement.check_failed",
          episodeId: episode.id,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "resupply: entitlement check failed; allowing confirmation (fail open)",
      );
    }
  }

  // 3c. Coverage guard (feature-flagged). Before we ship, consult the
  // most recent parsed 270/271 for the patient's PRIMARY coverage. An
  // explicitly inactive plan or a prior-auth-required flag means the
  // claim would deny and leave the patient with the bill, so we hold
  // the confirmation for a CSR instead of auto-shipping. FAIL OPEN: no
  // coverage on file, no/stale parsed result, or ANY lookup error
  // allows the confirmation through — we never strand a legitimate
  // reorder on our own eligibility plumbing. Runs before the atomic
  // claim so a blocked episode is left untouched (stays pending) for
  // the CSR to work, exactly like the entitlement guard above.
  if (await isFeatureEnabled("resupply.eligibility_enforcement")) {
    try {
      const block = await consultCoverageEligibility(
        supabase,
        episode.patient_id,
      );
      if (block) {
        await raiseCoverageAlert(supabase, episode.patient_id, block);
        return {
          status: "coverage_blocked",
          patientId: episode.patient_id,
          episodeId: episode.id,
          coverage: block,
        };
      }
    } catch (err) {
      logger.warn(
        {
          event: "resupply.coverage.check_failed",
          episodeId: episode.id,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "resupply: coverage check failed; allowing confirmation (fail open)",
      );
    }
  }

  // 3d. Continued-use guard (feature-flagged). Medicare (and most
  // payers) require evidence the patient is still USING the device
  // for a resupply claim to be payable. When the patient's own
  // therapy-cloud data over the last 30 days affirmatively shows the
  // device is effectively unused, hold the confirmation for a CSR
  // check-in instead of auto-shipping a claim that risks denial /
  // claw-back. FAIL OPEN: no therapy data on file (most patients —
  // cloud integrations are optional), a sparse window, or ANY lookup
  // error allows the confirmation through. Runs before the atomic
  // claim so a held episode stays pending for the CSR, exactly like
  // the two guards above.
  if (await isFeatureEnabled("resupply.usage_compliance_check")) {
    try {
      const usage = await consultRecentTherapyUsage(
        supabase,
        episode.patient_id,
      );
      if (usage) {
        await raiseUsageReviewAlert(supabase, episode.patient_id, usage);
        return {
          status: "usage_review",
          patientId: episode.patient_id,
          episodeId: episode.id,
          usage,
        };
      }
    } catch (err) {
      logger.warn(
        {
          event: "resupply.usage_compliance.check_failed",
          episodeId: episode.id,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "resupply: continued-use check failed; allowing confirmation (fail open)",
      );
    }
  }

  // 4. Atomic claim: flip status from any non-terminal value to
  // `confirmed`, ONLY when it isn't already confirmed/fulfilled.
  // Two concurrent calls into this helper both try this same UPDATE
  // — Postgres serialises the row writes, so the loser matches 0
  // rows and we resolve via the post-claim re-read below.
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .schema("resupply")
    .from("episodes")
    .update({ status: "confirmed", updated_at: nowIso })
    .eq("id", episode.id)
    .eq("patient_id", episode.patient_id)
    .not("status", "in", "(confirmed,fulfilled)")
    .select("id");
  if (claimErr) throw claimErr;

  if ((claimed ?? []).length === 0) {
    // Either we lost the race or the row moved off pending between
    // the read above and the UPDATE here. Re-read to disambiguate.
    return {
      status: "already_confirmed",
      patientId: episode.patient_id,
      episodeId: episode.id,
    };
  }

  // 5. Defense in depth: if a PRIOR run crashed after fulfillments
  // were inserted but before status flipped to confirmed, a fresh
  // confirm here would otherwise duplicate the fulfillment row. We
  // re-check existence after the claim and short-circuit if found.
  // The FOR-UPDATE-equivalent UPDATE above already eliminated the
  // common concurrent-race; this catches the misordered-write case.
  const fulfillmentIds = await ensureFulfillments(supabase, {
    patientId: episode.patient_id,
    episodeId: episode.id,
    itemSku: rx.item_sku,
  });

  return {
    status: "ok",
    patientId: episode.patient_id,
    episodeId: episode.id,
    fulfillmentIds,
  };
}

async function ensureFulfillments(
  supabase: ResupplySupabaseClient,
  args: { patientId: string; episodeId: string; itemSku: string },
): Promise<string[]> {
  // If a prior crash left fulfillments behind, surface their ids
  // rather than insert duplicates.
  const { data: existing, error: existingErr } = await supabase
    .schema("resupply")
    .from("fulfillments")
    .select("id")
    .eq("episode_id", args.episodeId)
    .limit(50);
  if (existingErr) throw existingErr;
  if ((existing ?? []).length > 0) {
    return (existing ?? []).map((r) => r.id);
  }

  // Backorder substitution. resolveFulfillmentSku reads
  // shop_backorders + shop_sku_substitutes and either passes the
  // primary through (common path) or hands us an alternative
  // when the primary is currently backordered. See
  // lib/backorder/resolve-fulfillment-sku.ts for the full
  // contract. Failures here MUST NOT block confirmation — fall
  // back to the prescription's primary SKU and let ops handle
  // it via the existing manual Pacware CSV flow.
  let shipSku = args.itemSku;
  let substitutedFromSku: string | null = null;
  try {
    const resolved = await resolveFulfillmentSku(supabase, args.itemSku);
    shipSku = resolved.sku;
    substitutedFromSku = resolved.substituted
      ? (resolved.substitutedFromSku ?? null)
      : null;
    if (resolved.substituted) {
      logger.info(
        {
          event: "resupply.substitution.applied",
          episodeId: args.episodeId,
          primarySku: resolved.substitutedFromSku,
          shippedSku: resolved.sku,
        },
        "resupply: backorder substitution applied",
      );
    } else if (resolved.noAlternative) {
      logger.warn(
        {
          event: "resupply.substitution.no_alternative",
          episodeId: args.episodeId,
          primarySku: args.itemSku,
        },
        "resupply: primary backordered + no in-stock alternative; queueing primary anyway",
      );
    }
  } catch (err) {
    logger.warn(
      {
        event: "resupply.substitution.resolve_failed",
        err: err instanceof Error ? err.message : "unknown",
      },
      "resupply: substitution lookup failed; falling back to primary SKU",
    );
  }

  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("fulfillments")
    .insert({
      patient_id: args.patientId,
      episode_id: args.episodeId,
      item_sku: shipSku,
      substituted_from_sku: substitutedFromSku,
      status: "queued",
    })
    .select("id");
  if (insertErr) throw insertErr;
  return (inserted ?? []).map((r) => r.id);
}

/**
 * Best-effort CSR alert when the entitlement guard blocks a reorder.
 * Centralized here so every caller of placeResupplyOrderForConversation
 * gets the same work-queue row without duplicating the logic. NEVER
 * throws into the caller — a failed alert must not turn a clean
 * "not_eligible" return into a 500 on the patient's confirm. The
 * `(patient_id, alert_type) WHERE status='open'` partial unique index
 * collapses repeats, so we check for an existing open alert first to
 * avoid a 23505 on the insert.
 */
async function raiseTooSoonAlert(
  supabase: ResupplySupabaseClient,
  patientId: string,
  entitlement: SkuEntitlement,
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .select("id")
      .eq("patient_id", patientId)
      .eq("alert_type", "resupply_too_soon")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (existing) return;
    const { error: insertAlertErr } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .insert({
        patient_id: patientId,
        alert_type: "resupply_too_soon",
        severity: "warning",
        summary: `Reorder blocked — ${entitlement.hcpcsCode} not yet payable. ${entitlement.reason}`,
        metric_snapshot: {
          hcpcsCode: entitlement.hcpcsCode,
          skuPrefix: entitlement.skuPrefix,
          status: entitlement.status,
          daysUntilEligible: entitlement.daysUntilEligible,
          eligibleOn: entitlement.eligibleOn.toISOString(),
        } as unknown as Json,
      });
    if (insertAlertErr) {
      logger.warn(
        {
          event: "resupply.entitlement.alert_failed",
          err: insertAlertErr.message,
          patientId,
        },
        "resupply: failed to raise too-soon CSR alert (non-fatal)",
      );
    }
  } catch (err) {
    logger.warn(
      {
        event: "resupply.entitlement.alert_failed",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "resupply: failed to raise too-soon CSR alert",
    );
  }
}

/**
 * Consult the most recent parsed 270/271 for the patient's PRIMARY
 * insurance coverage. Returns a `CoverageBlock` when the coverage is
 * explicitly inactive or flags prior-auth-required, else null. The
 * decision matrix + freshness window live in
 * `lib/billing/coverage-eligibility` and are shared with the claim-submit
 * gate so both behave identically.
 *
 * FAIL OPEN by omission: a patient with no coverage on file (cash-pay),
 * no/stale parsed result returns null → the order proceeds. A thrown DB
 * error propagates to the caller's fail-open catch.
 */
async function consultCoverageEligibility(
  supabase: ResupplySupabaseClient,
  patientId: string,
): Promise<CoverageBlock | null> {
  const { data: coverage, error: covErr } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select("id, payer_name")
    .eq("patient_id", patientId)
    .eq("rank", "primary")
    .limit(1)
    .maybeSingle();
  if (covErr) throw covErr;
  if (!coverage) return null; // no coverage on file → no opinion

  return consultCoverageEligibilityForCoverage(
    coverage.id,
    coverage.payer_name,
  );
}

/**
 * Best-effort CSR alert when the coverage guard blocks a reorder.
 * Mirrors `raiseTooSoonAlert`: NEVER throws into the caller (a failed
 * alert must not turn a clean "coverage_blocked" return into a 500 on
 * the patient's confirm), and de-dupes against the existing open alert
 * via the `(patient_id, alert_type) WHERE status='open'` partial unique
 * index so a repeat confirm doesn't 23505.
 */
async function raiseCoverageAlert(
  supabase: ResupplySupabaseClient,
  patientId: string,
  block: CoverageBlock,
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .select("id")
      .eq("patient_id", patientId)
      .eq("alert_type", "resupply_coverage_blocked")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (existing) return;
    const summary =
      block.reason === "inactive"
        ? `Reorder held — ${block.payerName} coverage is inactive on the last eligibility check. Verify coverage before shipping.`
        : `Reorder held — ${block.payerName} requires prior authorization on the last eligibility check. Confirm PA before shipping.`;
    const { error: insertAlertErr } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .insert({
        patient_id: patientId,
        alert_type: "resupply_coverage_blocked",
        severity: "warning",
        summary,
        metric_snapshot: {
          reason: block.reason,
          payerName: block.payerName,
          eligibilityCheckId: block.eligibilityCheckId,
        } as unknown as Json,
      });
    if (insertAlertErr) {
      logger.warn(
        {
          event: "resupply.coverage.alert_failed",
          err: insertAlertErr.message,
          patientId,
        },
        "resupply: failed to raise coverage-blocked CSR alert (non-fatal)",
      );
    }
  } catch (err) {
    logger.warn(
      {
        event: "resupply.coverage.alert_failed",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "resupply: failed to raise coverage-blocked CSR alert",
    );
  }
}

// Continued-use thresholds. Medicare's classic adherence yardstick is
// ≥4 hours/night; we hold a reorder only when a statistically useful
// sample (≥21 reported nights in the 30-day window) shows the patient
// under 4 hours on more than half of those nights. Patients with no
// cloud integration report zero nights and are never held.
const USAGE_WINDOW_DAYS = 30;
const USAGE_MIN_DATA_NIGHTS = 21;
const USAGE_COMPLIANT_NIGHT_MINUTES = 240;
const USAGE_MIN_COMPLIANT_RATIO = 0.5;

/**
 * Read the patient's last 30 days of therapy nights and decide whether
 * the data AFFIRMATIVELY shows non-use. Returns a `UsageReviewBlock`
 * when the reorder should be held for CSR review, else null (no
 * opinion — proceed). A thrown DB error propagates to the caller's
 * fail-open catch.
 */
async function consultRecentTherapyUsage(
  supabase: ResupplySupabaseClient,
  patientId: string,
): Promise<UsageReviewBlock | null> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - USAGE_WINDOW_DAYS);
  const sinceDate = since.toISOString().slice(0, 10);
  const { data: nights, error: nightsErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("usage_minutes")
    .eq("patient_id", patientId)
    .gte("night_date", sinceDate)
    .limit(USAGE_WINDOW_DAYS + 1);
  if (nightsErr) throw nightsErr;

  const rows = nights ?? [];
  if (rows.length < USAGE_MIN_DATA_NIGHTS) return null; // sparse data → no opinion
  const compliantNights = rows.filter(
    (n) => (n.usage_minutes ?? 0) >= USAGE_COMPLIANT_NIGHT_MINUTES,
  ).length;
  if (compliantNights / rows.length >= USAGE_MIN_COMPLIANT_RATIO) return null;

  return {
    windowDays: USAGE_WINDOW_DAYS,
    dataNights: rows.length,
    compliantNights,
  };
}

/**
 * Best-effort CSR alert when the continued-use guard holds a reorder.
 * Mirrors `raiseTooSoonAlert` / `raiseCoverageAlert`: NEVER throws
 * into the caller, and de-dupes against the existing open alert via
 * the `(patient_id, alert_type) WHERE status='open'` partial unique
 * index so a repeat confirm doesn't 23505. Snapshot carries counts
 * only — no per-night therapy detail.
 */
async function raiseUsageReviewAlert(
  supabase: ResupplySupabaseClient,
  patientId: string,
  usage: UsageReviewBlock,
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .select("id")
      .eq("patient_id", patientId)
      .eq("alert_type", "resupply_usage_review")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (existing) return;
    const { error: insertAlertErr } = await supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .insert({
        patient_id: patientId,
        alert_type: "resupply_usage_review",
        severity: "warning",
        summary: `Reorder held — recent therapy data shows low device use (${usage.compliantNights} of ${usage.dataNights} reported nights at 4+ hours in the last ${usage.windowDays} days). Verify continued use before shipping.`,
        metric_snapshot: {
          windowDays: usage.windowDays,
          dataNights: usage.dataNights,
          compliantNights: usage.compliantNights,
          minNightMinutes: USAGE_COMPLIANT_NIGHT_MINUTES,
        } as unknown as Json,
      });
    if (insertAlertErr) {
      logger.warn(
        {
          event: "resupply.usage_compliance.alert_failed",
          err: insertAlertErr.message,
          patientId,
        },
        "resupply: failed to raise usage-review CSR alert (non-fatal)",
      );
    }
  } catch (err) {
    logger.warn(
      {
        event: "resupply.usage_compliance.alert_failed",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "resupply: failed to raise usage-review CSR alert",
    );
  }
}

/**
 * Mark a patient as paused — used by both the SMS STOP keyword path
 * and the email "stop reminders" link click.
 *
 * Idempotent: paused → paused is a no-op.
 *
 * Also mirrors the opt-out into any matching shop_customers row's
 * communication_preferences JSON so the cart-abandonment dispatcher,
 * back-in-stock notifier, and other shop-side dispatchers see the
 * STOP. Twilio's per-number opt-out covers the same Messaging
 * Service, but the per-customer prefs row is what shop-side code
 * consults — without this mirror, a patient who STOPs via the
 * resupply phone would still receive shop-side SMS if the storefront
 * later uses a different Messaging Service.
 */
export async function pausePatient(patientId: string): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const { data: patient, error } = await supabase
    .schema("resupply")
    .from("patients")
    .update({ status: "paused", updated_at: nowIso })
    .eq("id", patientId)
    .select("id, email")
    .maybeSingle();
  if (error) throw error;
  if (!patient?.email) return;
  // Look up the matching shop_customers row by lowercased email and
  // flip both sms-mode flags off. Marketing emails stay on (the
  // patient's STOP was about SMS, not email). Patients without a
  // shop account have no row to update — no-op.
  const emailLower = patient.email.toLowerCase();
  const { data: cust } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, communication_preferences")
    .eq("email_lower", emailLower)
    .limit(1)
    .maybeSingle();
  if (!cust) return;
  const prefs = (cust.communication_preferences ?? {}) as Record<
    string,
    unknown
  >;
  const nextPrefs = {
    ...prefs,
    smsMarketing: false,
    smsTransactional: false,
  };
  const { error: prefsUpdateErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .update({
      communication_preferences: nextPrefs as unknown as Json,
      updated_at: nowIso,
    })
    .eq("customer_id", cust.customer_id);
  if (prefsUpdateErr) throw prefsUpdateErr;
}

/**
 * Re-activate a patient who previously texted STOP (CTIA START / UNSTOP
 * opt-in). The exact inverse of `pausePatient`: flips a `paused` patient
 * back to `active` and re-enables the shop_customers SMS flags.
 *
 * The status update is guarded to `paused` rows only so a START reply
 * can never resurrect an `archived` (or otherwise non-paused) patient —
 * it only undoes a STOP-induced pause. A no-op (already active, or never
 * paused) returns cleanly so the caller can still send the canonical
 * opt-in confirmation reply.
 */
export async function reactivatePatient(patientId: string): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const { data: patient, error } = await supabase
    .schema("resupply")
    .from("patients")
    .update({ status: "active", updated_at: nowIso })
    .eq("id", patientId)
    .eq("status", "paused")
    .select("id, email")
    .maybeSingle();
  if (error) throw error;
  if (!patient?.email) return;
  const emailLower = patient.email.toLowerCase();
  const { data: cust, error: custErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, communication_preferences")
    .eq("email_lower", emailLower)
    .limit(1)
    .maybeSingle();
  if (custErr) throw custErr;
  if (!cust) return;
  const prefs = (cust.communication_preferences ?? {}) as Record<
    string,
    unknown
  >;
  const nextPrefs = {
    ...prefs,
    smsMarketing: true,
    smsTransactional: true,
  };
  const { error: prefsUpdateErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .update({
      communication_preferences: nextPrefs as unknown as Json,
      updated_at: nowIso,
    })
    .eq("customer_id", cust.customer_id);
  if (prefsUpdateErr) throw prefsUpdateErr;
}
