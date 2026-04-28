// GET /patients/:id/timeline — unified chronological event feed.
//
// Merges every operationally-interesting event for a single patient
// into one descending-by-time array so the dashboard's chart view can
// render "what happened, in order" without doing four parallel
// fetches and stitching them together client-side.
//
// What's included:
//   - patient_created           (one row, the customer-since marker)
//   - prescription_created      (per prescription)
//   - episode_created           (per episode; carries due/expires)
//   - message                   (per message; metadata only — body
//                                 stays in /conversations/:id which
//                                 carries its own per-read audit)
//   - fulfillment_*             (one row per fulfillment milestone
//                                 timestamp that's actually populated:
//                                 queued, submitted, shipped, delivered)
//
// What's NOT included on purpose:
//   - Decrypted message bodies. The timeline is a "scan the chart"
//     surface; if the operator needs the actual text they click
//     through to /conversations/:id, which is the single chokepoint
//     where message-body audits already happen. Keeping bodies out
//     of the timeline avoids accidentally surfacing PHI in a screen
//     that may be shown over a screenshare.
//   - Episode status transitions. The current schema doesn't keep a
//     history table for `episodes.status`; we only know the latest
//     status. We surface it on the `episode_created` event and lean
//     on conversations + fulfillments to imply the rest.
//
// Ordering: descending by `at`. Stable secondary key on `kind` so
// a created-then-message-at-same-instant sequence doesn't flicker
// between renders.

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  conversations,
  episodes,
  fulfillments,
  getDbPool,
  messages,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireOperator } from "../../middlewares/requireOperator";

const idParam = z.object({ id: z.string().uuid() });

interface TimelineEvent {
  kind:
    | "patient_created"
    | "prescription_created"
    | "episode_created"
    | "message"
    | "fulfillment_queued"
    | "fulfillment_submitted"
    | "fulfillment_shipped"
    | "fulfillment_delivered";
  at: string;
  title: string;
  detail: string | null;
  // Cross-references the dashboard uses to deep-link.
  episodeId: string | null;
  conversationId: string | null;
  prescriptionId: string | null;
  fulfillmentId: string | null;
}

const toIso = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

const router: IRouter = Router();

router.get("/patients/:id/timeline", requireOperator, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { id } = parsed.data;

  const db = drizzle(getDbPool());

  // Confirm the patient exists (and grab the createdAt for the
  // patient_created marker).
  const patientRows = await db
    .select({ id: patients.id, createdAt: patients.createdAt })
    .from(patients)
    .where(eq(patients.id, id))
    .limit(1);
  const patient = patientRows[0];
  if (!patient) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Run the four child reads in parallel — none depend on each
  // other and the connection pool can handle them concurrently.
  const [prescriptionRows, episodeRows, messageRows, fulfillmentRows] =
    await Promise.all([
      db
        .select({
          id: prescriptions.id,
          itemSku: prescriptions.itemSku,
          cadenceDays: prescriptions.cadenceDays,
          createdAt: prescriptions.createdAt,
        })
        .from(prescriptions)
        .where(eq(prescriptions.patientId, id))
        .orderBy(desc(prescriptions.createdAt)),
      db
        .select({
          id: episodes.id,
          prescriptionId: episodes.prescriptionId,
          itemSku: prescriptions.itemSku,
          status: episodes.status,
          dueAt: episodes.dueAt,
          createdAt: episodes.createdAt,
        })
        .from(episodes)
        .leftJoin(prescriptions, eq(prescriptions.id, episodes.prescriptionId))
        .where(eq(episodes.patientId, id))
        .orderBy(desc(episodes.createdAt)),
      // Messages join conversations to filter by patient. We only
      // need the metadata, not the encrypted body.
      db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          episodeId: conversations.episodeId,
          channel: conversations.channel,
          direction: messages.direction,
          senderRole: messages.senderRole,
          deliveryStatus: messages.deliveryStatus,
          sentAt: messages.sentAt,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(
          conversations,
          eq(conversations.id, messages.conversationId),
        )
        .where(eq(conversations.patientId, id))
        .orderBy(desc(messages.createdAt)),
      db
        .select({
          id: fulfillments.id,
          episodeId: fulfillments.episodeId,
          itemSku: fulfillments.itemSku,
          quantity: fulfillments.quantity,
          status: fulfillments.status,
          submittedAt: fulfillments.submittedAt,
          shippedAt: fulfillments.shippedAt,
          deliveredAt: fulfillments.deliveredAt,
          createdAt: fulfillments.createdAt,
        })
        .from(fulfillments)
        .where(eq(fulfillments.patientId, id))
        .orderBy(desc(fulfillments.createdAt)),
    ]);

  const events: TimelineEvent[] = [];

  // patient_created — anchor of the timeline.
  events.push({
    kind: "patient_created",
    at: toIso(patient.createdAt) ?? new Date(0).toISOString(),
    title: "Customer added",
    detail: null,
    episodeId: null,
    conversationId: null,
    prescriptionId: null,
    fulfillmentId: null,
  });

  for (const p of prescriptionRows) {
    events.push({
      kind: "prescription_created",
      at: toIso(p.createdAt) ?? new Date(0).toISOString(),
      title: `Prescription added: ${p.itemSku}`,
      detail: `Cadence ${p.cadenceDays} days`,
      episodeId: null,
      conversationId: null,
      prescriptionId: p.id,
      fulfillmentId: null,
    });
  }

  for (const e of episodeRows) {
    const due = toIso(e.dueAt);
    events.push({
      kind: "episode_created",
      at: toIso(e.createdAt) ?? new Date(0).toISOString(),
      title: `Resupply episode opened${e.itemSku ? ` (${e.itemSku})` : ""}`,
      detail: `Status: ${e.status}${due ? ` · Due ${due.slice(0, 10)}` : ""}`,
      episodeId: e.id,
      conversationId: null,
      prescriptionId: e.prescriptionId,
      fulfillmentId: null,
    });
  }

  for (const m of messageRows) {
    // Prefer the explicit sentAt over the row's createdAt — for
    // outbound messages they will match, for inbound messages
    // sentAt is the vendor-reported send-time (more accurate).
    const at = toIso(m.sentAt) ?? toIso(m.createdAt) ?? new Date(0).toISOString();
    const dirVerb = m.direction === "inbound" ? "received" : "sent";
    const channelLabel =
      m.channel === "sms" ? "SMS" : m.channel === "email" ? "Email" : "Voice";
    events.push({
      kind: "message",
      at,
      title: `${channelLabel} message ${dirVerb}`,
      detail: `From ${m.senderRole}${m.deliveryStatus ? ` · ${m.deliveryStatus}` : ""}`,
      episodeId: m.episodeId,
      conversationId: m.conversationId,
      prescriptionId: null,
      fulfillmentId: null,
    });
  }

  // Fulfillment milestones: emit one event per timestamp that exists
  // so the chart shows the lifecycle (queued → submitted → shipped →
  // delivered) instead of a single "fulfillment exists" row.
  for (const f of fulfillmentRows) {
    const item = `${f.itemSku} × ${f.quantity}`;
    events.push({
      kind: "fulfillment_queued",
      at: toIso(f.createdAt) ?? new Date(0).toISOString(),
      title: `Fulfillment queued: ${item}`,
      detail: `Status: ${f.status}`,
      episodeId: f.episodeId,
      conversationId: null,
      prescriptionId: null,
      fulfillmentId: f.id,
    });
    if (f.submittedAt) {
      events.push({
        kind: "fulfillment_submitted",
        at: toIso(f.submittedAt)!,
        title: `Fulfillment submitted to Pacware: ${item}`,
        detail: null,
        episodeId: f.episodeId,
        conversationId: null,
        prescriptionId: null,
        fulfillmentId: f.id,
      });
    }
    if (f.shippedAt) {
      events.push({
        kind: "fulfillment_shipped",
        at: toIso(f.shippedAt)!,
        title: `Fulfillment shipped: ${item}`,
        detail: null,
        episodeId: f.episodeId,
        conversationId: null,
        prescriptionId: null,
        fulfillmentId: f.id,
      });
    }
    if (f.deliveredAt) {
      events.push({
        kind: "fulfillment_delivered",
        at: toIso(f.deliveredAt)!,
        title: `Fulfillment delivered: ${item}`,
        detail: null,
        episodeId: f.episodeId,
        conversationId: null,
        prescriptionId: null,
        fulfillmentId: f.id,
      });
    }
  }

  // Descending by time, then by kind for stable ordering of
  // simultaneous events.
  events.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.kind < b.kind ? 1 : -1;
  });

  try {
    await logAudit({
      action: "patient.timeline.view",
      operatorEmail: req.operatorEmail ?? null,
      operatorClerkId: req.operatorClerkId ?? null,
      targetTable: "patients",
      targetId: id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { eventCount: events.length },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "patients.timeline: audit write failed",
    );
  }

  res.status(200).json({ patientId: id, events });
});

export default router;
