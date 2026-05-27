// GET /conversations — paginated conversation queue.
//
// Joins patients to surface firstName + lastName so the queue can
// render a human-readable label without a second round-trip per
// row. Sort key: `lastMessageAt DESC NULLS LAST, createdAt DESC` so
// conversations with fresh activity surface first; brand-new
// conversations (no messages yet) fall back to createdAt order.
//
// Like the patient list, no audit row per page-flip — the
// /conversations/:id detail view is the one that writes the audit
// row, since that is where message bodies cross the wire.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const listQuery = z
  .object({
    status: z
      .enum(["open", "awaiting_patient", "awaiting_admin", "closed"])
      .optional(),
    // `in_app` added post-0033: in-account customer-service threads
    // appear in the same inbox as SMS/email/voice and CSRs filter the
    // same way.
    channel: z.enum(["sms", "voice", "email", "in_app"]).optional(),
    patientId: z.string().uuid().optional(),
    /**
     * Inbox view — orthogonal to status. Predefined buckets:
     *   - mine       → assigned to caller, status active
     *   - unassigned → no assignee, status active
     *   - escalated  → escalated_at IS NOT NULL
     *   - breaching  → SLA breach within next 30 minutes (or already)
     */
    view: z.enum(["mine", "unassigned", "escalated", "breaching"]).optional(),
    /** Filter to a specific assignee. Mutually exclusive with view=mine. */
    assignedTo: z.string().min(1).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    /**
     * When true, include conversations whose `snoozed_until` is in
     * the future. Default false — snoozed conversations are
     * suppressed from default views so they don't clutter the
     * queue. The "snooze" PATCH endpoint exists today but had no
     * effect on the list before this filter shipped; setting
     * snoozed_until now makes the conversation disappear from the
     * default queue (it re-emerges automatically when the timestamp
     * expires — no worker needed).
     */
    includeSnoozed: z
      .enum(["0", "1", "false", "true"])
      .transform((value) => value === "1" || value === "true")
      .optional()
      .default(false),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const router: IRouter = Router();

router.get("/conversations", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_query",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const {
    status,
    channel,
    patientId,
    view,
    assignedTo,
    priority,
    includeSnoozed,
    limit,
    offset,
  } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();

  // Sort: escalated first (NULLS LAST so non-SLA threads don't push
  // to the top), then SLA ascending, then last-message recency.
  let query = supabase
    .schema("resupply")
    .from("conversations")
    .select(
      "id, patient_id, customer_id, episode_id, channel, status, last_message_at, created_at, assigned_admin_user_id, assigned_at, priority, sla_due_at, escalated_at, escalation_reason, snoozed_until",
      { count: "exact" },
    )
    .order("escalated_at", { ascending: false, nullsFirst: false })
    .order("sla_due_at", { ascending: true, nullsFirst: false })
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (channel) query = query.eq("channel", channel);
  if (patientId) query = query.eq("patient_id", patientId);
  if (priority) query = query.eq("priority", priority);
  if (view === "mine") {
    if (req.adminUserId) {
      query = query
        .eq("assigned_admin_user_id", req.adminUserId)
        .in("status", ["open", "awaiting_admin", "awaiting_patient"]);
    }
  } else if (view === "unassigned") {
    query = query
      .is("assigned_admin_user_id", null)
      .in("status", ["open", "awaiting_admin", "awaiting_patient"]);
  } else if (view === "escalated") {
    query = query.not("escalated_at", "is", null);
  } else if (view === "breaching") {
    // SLA breach within 30 min OR already breached.
    const breachCutoff = new Date(Date.now() + 30 * 60_000).toISOString();
    query = query
      .not("sla_due_at", "is", null)
      .lte("sla_due_at", breachCutoff)
      .in("status", ["open", "awaiting_admin"]);
  } else if (assignedTo) {
    query = query.eq("assigned_admin_user_id", assignedTo);
  }

  // Auto-expire snoozes by filtering at query time rather than
  // running a worker. A conversation with snoozed_until set is
  // included iff (a) the caller opted in via ?includeSnoozed=1,
  // or (b) the timestamp has passed. Conversations with
  // snoozed_until=NULL are always included. Mirrors the OR pattern
  // csr-compliance-alerts uses for the same purpose.
  if (!includeSnoozed) {
    const nowIso = new Date().toISOString();
    query = query.or(`snoozed_until.is.null,snoozed_until.lte.${nowIso}`);
  }

  const { data: rows, count, error } = await query;
  if (error) throw error;

  // Bulk-fetch the joined identity rows. The original SQL query
  // LEFT JOINed patients + shop_customers; PostgREST has no JOIN, so
  // we collect the IDs from this page's rows and fetch in one extra
  // round-trip per side.
  const patientIds = Array.from(
    new Set(
      (rows ?? [])
        .map((r) => r.patient_id)
        .filter((v): v is string => v !== null),
    ),
  );
  const customerIds = Array.from(
    new Set(
      (rows ?? [])
        .map((r) => r.customer_id)
        .filter((v): v is string => v !== null),
    ),
  );

  const [patientsRes, customersRes] = await Promise.all([
    patientIds.length > 0
      ? supabase
          .schema("resupply")
          .from("patients")
          .select("id, legal_first_name, legal_last_name")
          .in("id", patientIds)
      : Promise.resolve({ data: [], error: null } as const),
    customerIds.length > 0
      ? supabase
          .schema("resupply")
          .from("shop_customers")
          .select("customer_id, display_name, email_lower")
          .in("customer_id", customerIds)
      : Promise.resolve({ data: [], error: null } as const),
  ]);
  if (patientsRes.error) throw patientsRes.error;
  if (customersRes.error) throw customersRes.error;
  const patientsById = new Map(
    (patientsRes.data ?? []).map((p) => [p.id, p] as const),
  );
  const customersById = new Map(
    (customersRes.data ?? []).map((c) => [c.customer_id, c] as const),
  );

  res.status(200).json({
    items: (rows ?? []).map((r) => {
      const pt = r.patient_id ? patientsById.get(r.patient_id) : undefined;
      const cu = r.customer_id ? customersById.get(r.customer_id) : undefined;
      return {
        id: r.id,
        patientId: r.patient_id,
        patientFirstName: pt?.legal_first_name ?? "",
        patientLastName: pt?.legal_last_name ?? "",
        episodeId: r.episode_id,
        customerId: r.customer_id,
        customerDisplayName: cu?.display_name ?? null,
        customerEmail: cu?.email_lower ?? null,
        channel: r.channel,
        status: r.status,
        lastMessageAt: r.last_message_at,
        createdAt: r.created_at,
        assignedAdminUserId: r.assigned_admin_user_id ?? null,
        assignedAt: r.assigned_at,
        priority: r.priority ?? "normal",
        slaDueAt: r.sla_due_at,
        escalatedAt: r.escalated_at,
        escalationReason: r.escalation_reason ?? null,
        snoozedUntil: r.snoozed_until ?? null,
      };
    }),
    total: count ?? 0,
    limit,
    offset,
  });
});

export default router;
