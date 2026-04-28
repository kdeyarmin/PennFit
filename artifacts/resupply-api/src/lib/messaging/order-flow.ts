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

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  conversations,
  episodes,
  fulfillments,
  getDbPool,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

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
  const pool = getDbPool();
  const db = drizzle(pool);

  // Concurrency model.
  //
  // A single conversation can race itself: a patient who clicks the
  // email confirm link AND replies "YES" by SMS within a few seconds
  // produces two concurrent calls into this helper, both reading the
  // episode in `pending` state, both inserting fulfillment rows,
  // resulting in DUPLICATE shipments (one per concurrent confirm).
  // The same race exists for two browser tabs of the same email link.
  //
  // We serialize on the EPISODE row using `SELECT … FOR UPDATE`
  // inside a transaction. Postgres blocks any concurrent transaction
  // that tries to lock the same row until ours commits. The second
  // transaction then re-reads the now-`confirmed` status and falls
  // through the `already_confirmed` short-circuit — no duplicate
  // fulfillment.
  //
  // The lock covers the entire decision window (status read →
  // prescription read → status write → fulfillment insert), all of
  // which run as one atomic unit. If the transaction throws partway
  // through, Postgres rolls back both the status update and any
  // fulfillment insert, so we never end up with a confirmed episode
  // that has no shipping queue entry.
  return await db.transaction(async (tx) => {
    const convRows = await tx
      .select({
        id: conversations.id,
        patientId: conversations.patientId,
        episodeId: conversations.episodeId,
      })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .limit(1);
    const conv = convRows[0];
    if (!conv) return { status: "conversation_not_found" };

    // SELECT FOR UPDATE on the episode. drizzle-orm's `.for("update")`
    // emits the row-level lock clause; the lock is released on commit
    // or rollback. We intentionally lock by episode (not conversation)
    // because two concurrent conversations CAN exist for the same
    // episode (admin opened a second one) and we want both to
    // serialize against the same episode-confirmation window.
    const episodeRows = await tx
      .select({
        id: episodes.id,
        patientId: episodes.patientId,
        prescriptionId: episodes.prescriptionId,
        status: episodes.status,
      })
      .from(episodes)
      .where(eq(episodes.id, conv.episodeId))
      .limit(1)
      .for("update");
    const episode = episodeRows[0];
    if (!episode) return { status: "episode_not_found" };

    if (episode.status === "confirmed" || episode.status === "fulfilled") {
      return {
        status: "already_confirmed",
        patientId: conv.patientId,
        episodeId: conv.episodeId,
      };
    }

    // Defense in depth: if a prior confirm already inserted
    // fulfillment rows for this episode (e.g. a previous transaction
    // committed but then crashed before updating episode status, or
    // a manual admin action), refuse to insert duplicates. The
    // FOR UPDATE lock above prevents the common race; this check
    // catches the rare misordered-write case.
    const existingFulfillments = await tx
      .select({ id: fulfillments.id })
      .from(fulfillments)
      .where(eq(fulfillments.episodeId, episode.id))
      .limit(1);
    if (existingFulfillments[0]) {
      // Mark the episode `confirmed` to converge the state machine
      // before we return — otherwise a future scan would replay this
      // path forever.
      await tx
        .update(episodes)
        .set({ status: "confirmed", updatedAt: new Date() })
        .where(
          and(
            eq(episodes.id, episode.id),
            eq(episodes.patientId, episode.patientId),
          ),
        );
      return {
        status: "already_confirmed",
        patientId: episode.patientId,
        episodeId: episode.id,
      };
    }

    // Find the active prescription that backs this episode. We look
    // up by id (not by patient + sku) because the episode already
    // pinned a specific script at creation time.
    const rxRows = await tx
      .select({
        id: prescriptions.id,
        itemSku: prescriptions.itemSku,
      })
      .from(prescriptions)
      .where(eq(prescriptions.id, episode.prescriptionId))
      .limit(1);
    const rx = rxRows[0];
    if (!rx) return { status: "no_active_prescription" };

    // Mark the episode confirmed first, then create the queued
    // fulfillment row. Order matters: the worker sweep that picks up
    // `queued` fulfillments expects the parent episode to be in a
    // post-decision state.
    await tx
      .update(episodes)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(
        and(
          eq(episodes.id, episode.id),
          eq(episodes.patientId, episode.patientId),
        ),
      );

    const inserted = await tx
      .insert(fulfillments)
      .values({
        patientId: episode.patientId,
        episodeId: episode.id,
        itemSku: rx.itemSku,
        status: "queued",
      })
      .returning({ id: fulfillments.id });

    return {
      status: "ok",
      patientId: episode.patientId,
      episodeId: episode.id,
      fulfillmentIds: inserted.map((r) => r.id),
    };
  });
}

/**
 * Mark a patient as paused — used by both the SMS STOP keyword path
 * and the email "stop reminders" link click.
 *
 * Idempotent: paused → paused is a no-op.
 */
export async function pausePatient(patientId: string): Promise<void> {
  const pool = getDbPool();
  const db = drizzle(pool);
  await db
    .update(patients)
    .set({ status: "paused", updatedAt: new Date() })
    .where(eq(patients.id, patientId));
}
