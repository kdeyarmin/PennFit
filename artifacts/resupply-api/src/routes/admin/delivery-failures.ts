// /admin/delivery-failures — webhook delivery error triage queue.
//
// Surfaces recent message-send failures across all three channels
// (SMS, email, voice) plus delivery-failure-shaped audit events. Ops
// uses this to spot phone numbers that are bouncing, email addresses
// that are landing in spam, etc. Sorted newest first.
//
// Two source streams unioned in the response:
//   1. messages.delivery_status IN ('failed','undelivered','bounced',
//      'dropped') — per-message terminal failures from the SMS / email
//      status webhooks.
//   2. audit_log rows where action LIKE '%.delivery.%' OR action LIKE
//      '%.failed' — system-level errors (e.g. webhook signature
//      verification failures, bulk-send aborts).
//
// PHI: message bodies are NOT surfaced on this view — operators
// triaging deliverability don't need the content; they need WHERE it
// failed and the error code. Patient name + ID are surfaced (already
// permitted in the rest of the admin console).

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const FAILURE_STATUSES = [
  "failed",
  "undelivered",
  "bounced",
  "dropped",
  "rejected",
  "spam_report",
] as const;

const DEFAULT_DAYS_BACK = 14;
const MAX_ROWS = 200;

// Webhook-delivery error triage queue. `reports.read` matches the
// CSV exports + analytics — admin / supervisor / csr /
// compliance_officer / agent. Fitter + fulfillment have no
// delivery-failure workflow.
router.get("/admin/delivery-failures", requirePermission("reports.read"), async (req, res) => {
  const sinceDays = Math.min(
    Math.max(1, Number(req.query.sinceDays ?? DEFAULT_DAYS_BACK)),
    90,
  );
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  const supabase = getSupabaseServiceRoleClient();

  // Per-message failures. The original Drizzle path joined to
  // conversations + patients in one shot; PostgREST has no JOIN, so
  // we fetch messages first then bulk-fetch the parent conversations
  // and (via the conversation's patient_id) the patients in a second
  // round-trip. Latency cost is bounded by MAX_ROWS.
  const { data: messageRows, error: msgErr } = await supabase
    .schema("resupply")
    .from("messages")
    .select(
      "id, conversation_id, direction, sender_role, delivery_status, delivery_error, sent_at, created_at",
    )
    .in("delivery_status", [
      "failed",
      "undelivered",
      "bounced",
      "dropped",
      "rejected",
      "spam_report",
    ])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  if (msgErr) throw msgErr;

  const conversationIds = Array.from(
    new Set((messageRows ?? []).map((r) => r.conversation_id)),
  );
  const conversationsById = new Map<
    string,
    { id: string; channel: string; patient_id: string | null }
  >();
  if (conversationIds.length > 0) {
    const { data: convs, error: convErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("id, channel, patient_id")
      .in("id", conversationIds);
    if (convErr) throw convErr;
    for (const c of convs ?? []) {
      conversationsById.set(c.id, {
        id: c.id,
        channel: c.channel,
        patient_id: c.patient_id,
      });
    }
  }
  const patientIds = Array.from(
    new Set(
      Array.from(conversationsById.values())
        .map((c) => c.patient_id)
        .filter((v): v is string => v !== null),
    ),
  );
  const patientsById = new Map<
    string,
    { legal_first_name: string; legal_last_name: string }
  >();
  if (patientIds.length > 0) {
    const { data: pts, error: ptErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, legal_last_name")
      .in("id", patientIds);
    if (ptErr) throw ptErr;
    for (const p of pts ?? []) {
      patientsById.set(p.id, {
        legal_first_name: p.legal_first_name,
        legal_last_name: p.legal_last_name,
      });
    }
  }

  // System-level failure events from the audit log. PostgREST `.or()`
  // supports `like` patterns; the LIKE wildcards (%) need to use
  // PostgREST's `*` syntax instead.
  const { data: auditRowsData, error: auditErr } = await supabase
    .schema("resupply")
    .from("audit_log")
    .select("id, occurred_at, action, target_table, target_id, operator_email, metadata")
    .gte("occurred_at", since)
    .or(
      "action.like.*.delivery.*,action.like.*.failed,action.like.*.bounced,action.like.*.error",
    )
    .order("occurred_at", { ascending: false })
    .limit(MAX_ROWS);
  if (auditErr) throw auditErr;

  const messageEvents = (messageRows ?? []).map((r) => {
    const conv = conversationsById.get(r.conversation_id);
    const pt = conv?.patient_id ? patientsById.get(conv.patient_id) : undefined;
    const fullName = pt
      ? [pt.legal_first_name, pt.legal_last_name].filter(Boolean).join(" ").trim()
      : "";
    return {
      kind: "message" as const,
      id: r.id,
      occurredAt: r.created_at,
      channel: conv?.channel ?? null,
      direction: r.direction,
      senderRole: r.sender_role,
      deliveryStatus: r.delivery_status,
      deliveryError: r.delivery_error,
      conversationId: r.conversation_id,
      patientId: conv?.patient_id ?? null,
      patientName: fullName || null,
    };
  });

  const auditEvents = (auditRowsData ?? []).map((r) => ({
    kind: "audit" as const,
    id: r.id,
    occurredAt: r.occurred_at,
    action: r.action,
    targetTable: r.target_table,
    targetId: r.target_id,
    actorEmail: r.operator_email,
    metadata: r.metadata ?? null,
  }));

  res.json({
    sinceDays,
    counts: {
      messageFailures: messageEvents.length,
      auditFailures: auditEvents.length,
    },
    failureStatuses: FAILURE_STATUSES,
    messageEvents,
    auditEvents,
  });
});

export default router;
