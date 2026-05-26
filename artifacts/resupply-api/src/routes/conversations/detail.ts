// GET /conversations/:id — conversation detail with full message body.
//
// This is the only endpoint that surfaces full message bodies to
// the admin console.
//
// Writes one `conversation.view` audit row with the conversation id
// as target. The metadata records the conversation channel + status
// for context and the size of the message timeline (count, not
// content). PHI does not enter the audit metadata.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

router.get("/conversations/:id", requireAdmin, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { id } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();

  // Header + messages are independent reads (both keyed on the same
  // conversation id). Run them concurrently; on a 404 we waste one
  // bounded message scan, which is far cheaper than an extra
  // round-trip on every successful read.
  const [headerRes, messagesRes] = await Promise.all([
    supabase
      .schema("resupply")
      .from("conversations")
      .select(
        "id, patient_id, customer_id, episode_id, channel, status, last_message_at, created_at, assigned_admin_user_id, assigned_at, priority, sla_due_at, escalated_at, escalated_to, escalation_reason",
      )
      .eq("id", id)
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("messages")
      .select(
        "id, direction, sender_role, body, delivery_status, sent_at, delivered_at, created_at",
      )
      .eq("conversation_id", id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(500),
  ]);
  if (headerRes.error) throw headerRes.error;
  if (messagesRes.error) throw messagesRes.error;

  const header = headerRes.data;
  if (!header) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const messageRows = messagesRes.data ?? [];

  // Bulk-fetch the joined identity rows + message attachments in
  // parallel. The original SQL path LEFT JOINed patients +
  // shop_customers; PostgREST has no JOIN, so we do `.eq().maybeSingle()`
  // (or `.in()` for one-to-many) keyed on the relevant id.
  const messageIds = messageRows.map((m) => m.id);
  const [patientRes, customerRes, attachmentsRes] = await Promise.all([
    header.patient_id
      ? supabase
          .schema("resupply")
          .from("patients")
          .select("legal_first_name, legal_last_name")
          .eq("id", header.patient_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as const),
    header.customer_id
      ? supabase
          .schema("resupply")
          .from("shop_customers")
          .select("display_name, email_lower")
          .eq("customer_id", header.customer_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as const),
    messageIds.length > 0
      ? supabase
          .schema("resupply")
          .from("message_attachments")
          .select("id, message_id, filename, content_type, size_bytes, created_at")
          .in("message_id", messageIds)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
      : Promise.resolve({ data: [], error: null } as const),
  ]);
  if (patientRes.error) throw patientRes.error;
  if (customerRes.error) throw customerRes.error;
  if (attachmentsRes.error) throw attachmentsRes.error;

  const attachmentsByMessage = new Map<
    string,
    Array<{
      id: string;
      filename: string | null;
      contentType: string;
      sizeBytes: number;
      createdAt: string;
    }>
  >();
  for (const a of attachmentsRes.data ?? []) {
    const arr = attachmentsByMessage.get(a.message_id) ?? [];
    arr.push({
      id: a.id,
      filename: a.filename ?? null,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
      createdAt: a.created_at,
    });
    attachmentsByMessage.set(a.message_id, arr);
  }

  try {
    await logAudit({
      action: "conversation.view",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "conversations",
      targetId: id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: {
        source: "console",
        channel: header.channel,
        status: header.status,
        messageCount: messageRows.length,
      },
    });
  } catch (err) {
    logger.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "conversations.detail: audit write failed",
    );
  }

  res.status(200).json({
    id: header.id,
    patientId: header.patient_id,
    patientFirstName: patientRes.data?.legal_first_name ?? "",
    patientLastName: patientRes.data?.legal_last_name ?? "",
    episodeId: header.episode_id,
    customerId: header.customer_id,
    customerDisplayName: customerRes.data?.display_name ?? null,
    customerEmail: customerRes.data?.email_lower ?? null,
    channel: header.channel,
    status: header.status,
    lastMessageAt: header.last_message_at,
    createdAt: header.created_at,
    assignedAdminUserId: header.assigned_admin_user_id ?? null,
    assignedAt: header.assigned_at,
    priority: header.priority ?? "normal",
    slaDueAt: header.sla_due_at,
    escalatedAt: header.escalated_at,
    escalatedTo: header.escalated_to ?? null,
    escalationReason: header.escalation_reason ?? null,
    messages: messageRows.map((m) => ({
      id: m.id,
      direction: m.direction,
      senderRole: m.sender_role,
      body: m.body ?? "",
      deliveryStatus: m.delivery_status,
      sentAt: m.sent_at,
      deliveredAt: m.delivered_at,
      createdAt: m.created_at,
      attachments: attachmentsByMessage.get(m.id) ?? [],
    })),
  });
});

export default router;
