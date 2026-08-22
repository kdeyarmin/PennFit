/**
 * Record a finished fitting onto its `fitter_invites` row.
 *
 * WHY THIS EXISTS
 * ---------------
 * The invite row is what the staff worklist reads. Until this helper it
 * was written from exactly one place — the patient's browser, via
 * `POST /shop/fitter-invite/complete` — and that call is gated on the
 * page having a mask to name:
 *
 *     if (!inviteToken || !measurements || !topPick) return;   // results.tsx
 *
 * `topPick` is null whenever the clinical engine DECLINES to name one —
 * `contraindicated`, `outside_validated_range`, a formulary that ruled
 * every candidate out. Those are the fittings staff most need to see, and
 * they were the exact fittings that transmitted nothing: the invite sat at
 * `opened` forever, with no measurements, no completion time, and no trace
 * on any invite surface — while a complete `fit_sessions` record of the
 * same fitting sat in the review queue nobody had been pointed at.
 *
 * A fitting is finished when the ENGINE says so, not when it happens to
 * like the answer, and "finished" is a fact the server already holds at
 * that moment. So `/api/fit/assess` now records it here directly, and the
 * browser's transmission became the backup for the legacy engine path
 * rather than the only writer.
 *
 * EXACTLY-ONCE
 * ------------
 * Both callers can fire for the same fitting (a clinical assessment
 * persists the session AND the page still transmits), and per-fitting
 * billing hangs off this transition — so the completion is CLAIMED with a
 * conditional update that matches only while the row is still
 * un-completed. Exactly one caller wins it and meters; the loser falls
 * through to a data-only refresh so its (newer) values are still stored,
 * unbilled. That is the same guard the route has always applied to a
 * double-tap; it now spans both writers.
 *
 * PHI: measurements + questionnaire answers, same class the row already
 * held. Nothing here is logged beyond ids, counts and flags.
 */

import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { recordTenantUsage } from "../metering/usage";
import { reportFitterFittingMeterEvent } from "../platform-billing/stripe";

type FitterInvitesUpdate =
  Database["resupply"]["Tables"]["fitter_invites"]["Update"];
type FitterInvitesRow = Database["resupply"]["Tables"]["fitter_invites"]["Row"];

/**
 * Collapse a clinical `InterfaceType` onto the four-value mask type the
 * invite's legacy columns (and the storefront's own recommendation
 * engine) have always spoken. Mirrors `toLegacyMaskType` in the SPA's
 * fit-assess-api — the two describe the same mapping from opposite ends
 * of the wire, and the invite row is written from both.
 */
export function toLegacyMaskType(
  interfaceType: string,
): "nasal" | "nasalPillow" | "fullFace" | "hybrid" {
  switch (interfaceType) {
    case "nasal_pillow":
    case "nasal_cradle":
      return "nasalPillow";
    case "hybrid":
      return "hybrid";
    case "full_face":
    case "total_face":
    case "oral":
      return "fullFace";
    case "nasal":
    default:
      return "nasal";
  }
}

/** One entry of the ranked list the patient was shown. */
export interface RankedMask {
  maskId: string;
  name: string;
  type: string;
  confidence?: number;
}

export interface CompleteInviteInput {
  orgId: string;
  inviteId: string;
  /** Numeric facial measurements. Never images — see the repo invariant. */
  measurements: unknown;
  /** Questionnaire / fit-profile answers, scalars only. */
  answers: unknown;
  /**
   * The mask the fitting landed on, and the ranked list behind it.
   * `primary` is null for a fitting that deliberately named no mask
   * (contraindicated, out of validated range, everything excluded) —
   * `ranked` may still carry the alternatives that were considered.
   */
  primary: { maskId: string; name: string; type: string } | null;
  ranked: RankedMask[];
  /** The clinical session backing this fitting, when one was recorded. */
  fitSessionId?: string | null;
  /** Where the completion came from — audit/telemetry only. */
  source: "fitter.invite.complete" | "fitter.assess.complete";
}

export type CompleteInviteOutcome =
  /** Written. `billable` is true only for the caller that won the claim. */
  | { kind: "recorded"; matched: boolean; billable: boolean }
  | { kind: "not_found" }
  | { kind: "revoked" }
  | { kind: "expired" }
  /** A DB hiccup — nothing was written, and the caller must not 500. */
  | { kind: "unrecorded" };

/**
 * Find the single patient that owns this email/phone, if any. More than
 * one match is treated as "no match" — we never auto-cross-link PHI on an
 * ambiguous identity (mirrors me-documents findPatientByEmail).
 */
async function findUniquePatient(
  orgId: string,
  email: string | null,
  phone: string | null,
): Promise<string | null> {
  const supabase = getOrgScopedClient(orgId);
  if (email) {
    const { data, error } = await supabase
      .from("patients")
      .select("id")
      .eq("email", email)
      .limit(2);
    if (error) throw error;
    if (data && data.length === 1) return data[0]!.id;
    if (data && data.length > 1) return null;
  }
  if (phone) {
    const { data, error } = await supabase
      .from("patients")
      .select("id")
      .eq("phone_e164", phone)
      .limit(2);
    if (error) throw error;
    if (data && data.length === 1) return data[0]!.id;
  }
  return null;
}

/**
 * Store the fitting on its invite, auto-attaching to a chart when the
 * recipient's email (then phone) matches exactly one patient on file.
 *
 * Never throws: every caller is on a path where the patient has already
 * been given their result, and losing the record must not fail them.
 */
export async function completeInviteFromFitting(
  input: CompleteInviteInput,
): Promise<CompleteInviteOutcome> {
  // The outer guard is not belt-and-braces, it is the contract. One
  // caller runs INSIDE the fit-session write, so anything thrown here
  // would abort that write's own try block and cost the patient their
  // `fitSessionId` — losing the clinical record over a failure to update
  // a worklist row. Nothing this function can hit is worth that.
  try {
    return await recordCompletion(input);
  } catch (err) {
    logger.warn(
      { err, inviteId: input.inviteId },
      "fitter-invite: completion write threw",
    );
    return { kind: "unrecorded" };
  }
}

async function recordCompletion(
  input: CompleteInviteInput,
): Promise<CompleteInviteOutcome> {
  const { orgId, inviteId } = input;
  const supabase = getOrgScopedClient(orgId);

  const { data: invite, error } = await supabase
    .from("fitter_invites")
    .select(
      "id, status, patient_id, recipient_email, recipient_phone_e164, opened_at, expires_at",
    )
    .eq("id", inviteId)
    .limit(1)
    .maybeSingle();
  // Fail soft on a DB hiccup — the patient already sees their result;
  // losing the best-effort transmission must not 500 them.
  if (error) {
    logger.warn({ err: error, inviteId }, "fitter-invite: lookup failed");
    return { kind: "unrecorded" };
  }
  if (!invite) return { kind: "not_found" };
  if (invite.status === "revoked") return { kind: "revoked" };
  // Enforce the row's expiry here too, exactly as /resolve does. Without
  // it, a token whose own HMAC window outlives the row's `expires_at`
  // (staff resend rewrites the row's expiry while older tokens stay valid
  // to their embedded one) could keep writing measurements onto an invite
  // staff consider dead.
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now())
    return { kind: "expired" };

  const nowIso = new Date().toISOString();

  // A re-submit of an already-completed/attached fitting must not be
  // double-counted for per-fitting billing (migration 0419). Only the
  // transition into a completed state from sent/opened is a new fitting.
  const isNewCompletion =
    invite.status !== "completed" && invite.status !== "attached";

  // Auto-attach: only when not already linked (a manual attach, or a
  // re-submit, must not be clobbered).
  let patientId = invite.patient_id;
  let autoMatched = false;
  if (!patientId) {
    try {
      const match = await findUniquePatient(
        orgId,
        invite.recipient_email,
        invite.recipient_phone_e164,
      );
      if (match) {
        patientId = match;
        autoMatched = true;
      }
    } catch (matchErr) {
      // Best-effort — a lookup failure must not lose the fitting.
      logger.warn(
        { err: matchErr, inviteId },
        "fitter-invite: auto-match lookup failed",
      );
    }
  }

  const update: FitterInvitesUpdate = {
    // Don't downgrade an already-attached fitting on a re-submit —
    // resolve allows reopening an attached invite, and rewriting it to
    // "completed" would orphan patient_id/attached_at and pull it back
    // into the holding worklist. Keep terminal states sticky.
    status: invite.status === "attached" ? "attached" : "completed",
    completed_at: nowIso,
    // Preserve the true first-open timestamp; only backfill it when
    // resolve was skipped (still in 'sent').
    ...(invite.opened_at ? {} : { opened_at: nowIso }),
    // Zod's record/passthrough shapes widen to `unknown`-valued objects
    // that don't structurally satisfy the generated `Json` type even
    // though they are valid JSON at runtime. Cast at the storage edge.
    measurements: input.measurements as FitterInvitesRow["measurements"],
    questionnaire_answers:
      input.answers as FitterInvitesRow["questionnaire_answers"],
    // Null for a fitting that named no mask. The worklist reads that as
    // "completed, nothing recommended — a clinician decides", which is
    // the truth; inventing a mask to fill the column would be worse.
    recommended_mask_id: input.primary?.maskId ?? null,
    recommended_mask_name: input.primary?.name ?? null,
    recommended_mask_type: input.primary?.type ?? null,
    updated_at: nowIso,
  };
  // The ranked list the patient actually saw. The ASSESS path is
  // authoritative for its own fitting — it carries the full ranked truth,
  // including a genuinely empty list when tiers 1-2 excluded everything —
  // so it always writes, letting a contraindicated re-fitting CLEAR the
  // previous run's stale list (a staff worklist showing last week's
  // magnetic mask against this week's "everything excluded" session is a
  // wrong clinical record). The PAGE's transmission still skips an empty
  // list: it sends `ranked: []` whenever it has no topPick, and letting
  // that blank the assess path's list within one fitting is exactly the
  // two-writer race this guard exists for.
  if (input.ranked.length > 0 || input.source === "fitter.assess.complete") {
    update.recommendations =
      input.ranked as unknown as FitterInvitesRow["recommendations"];
  }
  if (input.fitSessionId) update.fit_session_id = input.fitSessionId;
  if (patientId && !invite.patient_id) {
    update.patient_id = patientId;
    update.auto_matched = autoMatched;
  }

  // The billable transition is claimed ATOMICALLY: `isNewCompletion`
  // above is derived from a stale read, so two concurrent completions
  // (the assess path and the page's own transmission, a double-tap, two
  // tabs, a replayed request) would BOTH see sent/opened and both meter a
  // fitting. The conditional write below matches only while the row is
  // still un-completed — exactly one caller wins it; the loser falls
  // through to a data-only update so its (newer) measurements are still
  // recorded, unbilled.
  let billableTransition = false;
  if (isNewCompletion) {
    const { data: claimed, error: claimErr } = await supabase
      .from("fitter_invites")
      .update(update)
      .eq("id", invite.id)
      .not("status", "in", "(completed,attached)")
      .select("id");
    if (claimErr) {
      logger.warn({ err: claimErr, inviteId }, "fitter-invite: write failed");
      return { kind: "unrecorded" };
    }
    billableTransition = (claimed ?? []).length > 0;
  }
  if (!billableTransition) {
    // Re-submit (or race loser): refresh the fitting DATA only. Status,
    // completed_at and opened_at were settled by the first completion —
    // rewriting status here from the stale read could regress a
    // concurrent "attached" back to "completed".
    //
    // CHART LINKAGE IS OFF-LIMITS HERE TOO. `patient_id`/`auto_matched`
    // are in `update` because the row carried no chart at THIS caller's
    // read — a view a staff attach in the meantime has already
    // invalidated. Writing them back would repoint the fitting from the
    // chart a human deliberately chose to the auto-matched one, and set
    // `auto_matched` true underneath an `attached_at` that says a person
    // did it: a fitting filed on the wrong patient, labelled as though
    // nobody had touched it.
    //
    // Nothing is lost by staying out of it. Whoever won the claim ran the
    // same lookup against the same contact details, so the linkage this
    // caller would write is the linkage already there; and if that lookup
    // failed, the row stays unattached and lands in the holding area,
    // which exists precisely to put it in front of a human.
    const {
      status: _status,
      completed_at: _completedAt,
      opened_at: _openedAt,
      patient_id: _patientId,
      auto_matched: _autoMatched,
      ...dataOnly
    } = update;
    const { error: updErr } = await supabase
      .from("fitter_invites")
      .update(dataOnly)
      .eq("id", invite.id);
    // Best-effort: a transient write failure must not 500 the patient.
    if (updErr) {
      logger.warn({ err: updErr, inviteId }, "fitter-invite: write failed");
      return { kind: "unrecorded" };
    }
  }

  // Meter the completed fitting for per-fitting billing (migration 0419).
  // Fire-and-forget + fail-soft (recordTenantUsage never throws); only on
  // a genuinely new completion so a re-submit — or the second of the two
  // writers — can't inflate usage.
  if (billableTransition) {
    void recordTenantUsage({
      orgId,
      metricKey: "fitterFittingsPerMonth",
      quantity: 1,
      source: input.source,
    });
    // Also report it to Stripe as a Billing Meter event so per-fitting
    // overage on the Virtual Mask Fitter plan is invoiced (migration
    // 0420). Fire-and-forget + fail-soft; no-ops unless platform Stripe
    // billing is configured and the tenant has a Stripe customer.
    void reportFitterFittingMeterEvent(orgId);
  }

  return {
    kind: "recorded",
    matched: Boolean(patientId),
    billable: billableTransition,
  };
}
