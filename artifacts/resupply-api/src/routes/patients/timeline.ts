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
//     surface; if the admin needs the actual text they click
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

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

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

router.get("/patients/:id/timeline", requireAdmin, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { id } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();

  // Confirm the patient exists (and grab the createdAt for the
  // patient_created marker).
  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, created_at")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Run the four child reads in parallel — none depend on each
  // other and the connection pool can handle them concurrently.
  // Note: the original SQL path JOINed messages → conversations
  // (to filter messages by patient) and episodes → prescriptions (for
  // itemSku display). PostgREST has no JOIN, so we fetch the parent
  // collections first and resolve the join via JS Maps below.
  const [prescriptionsRes, episodesRes, conversationsRes, fulfillmentsRes] =
    await Promise.all([
      supabase
        .schema("resupply")
        .from("prescriptions")
        .select("id, item_sku, cadence_days, created_at")
        .eq("patient_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .schema("resupply")
        .from("episodes")
        .select("id, prescription_id, status, due_at, created_at")
        .eq("patient_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .schema("resupply")
        .from("conversations")
        .select("id, episode_id, channel")
        .eq("patient_id", id),
      supabase
        .schema("resupply")
        .from("fulfillments")
        .select(
          "id, episode_id, item_sku, quantity, status, submitted_at, shipped_at, delivered_at, created_at",
        )
        .eq("patient_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
  if (prescriptionsRes.error) throw prescriptionsRes.error;
  if (episodesRes.error) throw episodesRes.error;
  if (conversationsRes.error) throw conversationsRes.error;
  if (fulfillmentsRes.error) throw fulfillmentsRes.error;

  const prescriptionRows = prescriptionsRes.data ?? [];
  const episodeRows = episodesRes.data ?? [];
  const conversationRows = conversationsRes.data ?? [];
  const fulfillmentRows = fulfillmentsRes.data ?? [];

  // Resolve the LEFT JOIN equivalents. Both maps are 1-to-1 so a flat
  // key→value Map is the simplest form.
  const itemSkuByRxId = new Map<string, string>();
  for (const p of prescriptionRows) itemSkuByRxId.set(p.id, p.item_sku);
  const conversationMeta = new Map<
    string,
    { episodeId: string | null; channel: string }
  >();
  for (const c of conversationRows) {
    conversationMeta.set(c.id, { episodeId: c.episode_id, channel: c.channel });
  }

  // Messages used to be JOINed to conversations and filtered by
  // conversations.patient_id. Now we fetch the patient's conversation
  // ids first (above) and use `.in()` here. If the patient has no
  // conversations there's nothing to fetch — skip the round-trip.
  const conversationIds = conversationRows.map((c) => c.id);
  const messageRows =
    conversationIds.length > 0
      ? await (async () => {
          const { data, error } = await supabase
            .schema("resupply")
            .from("messages")
            .select(
              "id, conversation_id, direction, sender_role, delivery_status, sent_at, created_at",
            )
            .in("conversation_id", conversationIds)
            .order("created_at", { ascending: false })
            .limit(500);
          if (error) throw error;
          return data ?? [];
        })()
      : [];

  const events: TimelineEvent[] = [];

  // patient_created — anchor of the timeline.
  events.push({
    kind: "patient_created",
    at: toIso(patient.created_at) ?? new Date(0).toISOString(),
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
      at: toIso(p.created_at) ?? new Date(0).toISOString(),
      title: `Prescription added: ${p.item_sku}`,
      detail: `Cadence ${p.cadence_days} days`,
      episodeId: null,
      conversationId: null,
      prescriptionId: p.id,
      fulfillmentId: null,
    });
  }

  for (const e of episodeRows) {
    const due = toIso(e.due_at);
    const itemSku = e.prescription_id
      ? itemSkuByRxId.get(e.prescription_id)
      : null;
    events.push({
      kind: "episode_created",
      at: toIso(e.created_at) ?? new Date(0).toISOString(),
      title: `Resupply episode opened${itemSku ? ` (${itemSku})` : ""}`,
      detail: `Status: ${e.status}${due ? ` · Due ${due.slice(0, 10)}` : ""}`,
      episodeId: e.id,
      conversationId: null,
      prescriptionId: e.prescription_id,
      fulfillmentId: null,
    });
  }

  for (const m of messageRows) {
    // Prefer the explicit sentAt over the row's createdAt — for
    // outbound messages they will match, for inbound messages
    // sentAt is the vendor-reported send-time (more accurate).
    const at =
      toIso(m.sent_at) ?? toIso(m.created_at) ?? new Date(0).toISOString();
    const meta = conversationMeta.get(m.conversation_id);
    const channel = meta?.channel ?? "";
    const dirVerb = m.direction === "inbound" ? "received" : "sent";
    const channelLabel =
      channel === "sms" ? "SMS" : channel === "email" ? "Email" : "Voice";
    events.push({
      kind: "message",
      at,
      title: `${channelLabel} message ${dirVerb}`,
      detail: `From ${m.sender_role}${m.delivery_status ? ` · ${m.delivery_status}` : ""}`,
      episodeId: meta?.episodeId ?? null,
      conversationId: m.conversation_id,
      prescriptionId: null,
      fulfillmentId: null,
    });
  }

  // Fulfillment milestones: emit one event per timestamp that exists
  // so the chart shows the lifecycle (queued → submitted → shipped →
  // delivered) instead of a single "fulfillment exists" row.
  for (const f of fulfillmentRows) {
    const item = `${f.item_sku} × ${f.quantity}`;
    events.push({
      kind: "fulfillment_queued",
      at: toIso(f.created_at) ?? new Date(0).toISOString(),
      title: `Fulfillment queued: ${item}`,
      detail: `Status: ${f.status}`,
      episodeId: f.episode_id,
      conversationId: null,
      prescriptionId: null,
      fulfillmentId: f.id,
    });
    if (f.submitted_at) {
      events.push({
        kind: "fulfillment_submitted",
        at: toIso(f.submitted_at)!,
        title: `Fulfillment submitted to Pacware: ${item}`,
        detail: null,
        episodeId: f.episode_id,
        conversationId: null,
        prescriptionId: null,
        fulfillmentId: f.id,
      });
    }
    if (f.shipped_at) {
      events.push({
        kind: "fulfillment_shipped",
        at: toIso(f.shipped_at)!,
        title: `Fulfillment shipped: ${item}`,
        detail: null,
        episodeId: f.episode_id,
        conversationId: null,
        prescriptionId: null,
        fulfillmentId: f.id,
      });
    }
    if (f.delivered_at) {
      events.push({
        kind: "fulfillment_delivered",
        at: toIso(f.delivered_at)!,
        title: `Fulfillment delivered: ${item}`,
        detail: null,
        episodeId: f.episode_id,
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
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { eventCount: events.length },
    });
  } catch (err) {
    logger.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "patients.timeline: audit write failed",
    );
  }

  res.status(200).json({ patientId: id, events });
});

export default router;
