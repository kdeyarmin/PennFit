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
//   The original Drizzle path opened a transaction and locked the
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
import { logger } from "../logger";

export type PlaceOrderResult =
  | {
      status: "ok";
      patientId: string;
      episodeId: string;
      fulfillmentIds: string[];
    }
  | { status: "already_confirmed"; patientId: string; episodeId: string }
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
  await supabase
    .schema("resupply")
    .from("shop_customers")
    .update({
      communication_preferences: nextPrefs as unknown as Json,
      updated_at: nowIso,
    })
    .eq("customer_id", cust.customer_id);
}
