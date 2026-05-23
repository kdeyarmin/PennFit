// /admin/today — unified CSR work queue ("My Today").
//
// Returns the top N actionable items across the queues a CSR
// touches every day, in a single round-trip, so the home page after
// admin sign-in is a worklist instead of an empty operations
// dashboard. Items per queue are bounded so the response stays small;
// follow-the-link drills into each queue for the full list.
//
// Sources (each capped at PER_QUEUE_LIMIT):
//   * conversationsAwaitingReply — conversations.status='awaiting_admin'
//     ordered by oldest unanswered first (last_message_at ASC).
//   * overdueFollowups — patient_followups + shop_customer_followups
//     where due_at < now AND completed_at IS NULL.
//   * pendingReturns — shop_returns in lifecycle states that block on
//     admin action (requested|approved|shipped_back|received).
//   * complianceAlerts — csr_compliance_alerts.status='new' or
//     'acknowledged' ordered by severity desc, created_at asc.
//   * rxRenewalsDue — prescriptions.valid_until in the next 30 days
//     where status='active' and renewal_requested_at IS NULL.
//   * documentsToReview — patient_documents.reviewed_at IS NULL
//     ordered by oldest first.
//
// Why a separate endpoint from /admin/inbox-counts:
//   inbox-counts returns scalar counts for nav badges; today returns
//   the actual top items for a worklist UI. Different cardinality,
//   different read pattern (today is rarely cached because the user
//   wants live state when they open the page).
//
// PHI / log posture: response carries patient/customer IDs and
// minimal display text (conversation channel, return reason, alert
// type). No bodies, no patient names, no phone numbers, no payer
// info — the CSR clicks through for those.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/** Bound the response so the worklist renders fast and uses bounded
 *  memory. CSRs who clear the top 5 of any queue can refresh for
 *  the next 5 (or click through to the full queue). */
const PER_QUEUE_LIMIT = 5;

interface ConversationRow {
  id: string;
  channel: string;
  last_message_at: string | null;
  patient_id: string | null;
  customer_id: string | null;
  assigned_admin_user_id: string | null;
}

interface FollowupRow {
  id: string;
  due_at: string;
  body: string;
  patient_id: string | null;
  customer_id: string | null;
  source: "patient" | "shop_customer";
}

interface ReturnRow {
  id: string;
  status: string;
  reason: string;
  customer_id: string;
  created_at: string;
}

interface ComplianceAlertRow {
  id: string;
  alert_type: "low_usage" | "no_response" | "send_failure" | "manual";
  severity: "info" | "warning" | "critical";
  summary: string;
  patient_id: string;
  status: "open" | "snoozed" | "resolved";
  snoozed_until: string | null;
  created_at: string;
}

interface RxRenewalRow {
  id: string;
  patient_id: string;
  item_sku: string;
  hcpcs_code: string | null;
  valid_until: string;
}

interface DocumentRow {
  id: string;
  document_type: string;
  patient_id: string;
  filename: string;
  created_at: string;
}

interface InboundFaxRow {
  id: string;
  twilio_fax_sid: string;
  from_e164: string | null;
  num_pages: number | null;
  received_at: string;
}

router.get("/admin/today", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + 30);
  const horizonDate = horizon.toISOString().slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);

  // Fan out all queue reads in parallel. Each is independently bounded
  // and index-backed; total wall clock ≈ slowest of the six.
  const [
    convRes,
    patientFollowupRes,
    shopFollowupRes,
    returnsRes,
    alertsRes,
    rxRes,
    docsRes,
    faxesRes,
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("conversations")
      .select(
        "id, channel, last_message_at, patient_id, customer_id, assigned_admin_user_id",
      )
      .eq("status", "awaiting_admin")
      .order("last_message_at", { ascending: true, nullsFirst: false })
      .limit(PER_QUEUE_LIMIT),
    supabase
      .schema("resupply")
      .from("patient_followups")
      .select("id, due_at, body, patient_id")
      .is("completed_at", null)
      .lt("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(PER_QUEUE_LIMIT),
    supabase
      .schema("resupply")
      .from("shop_customer_followups")
      .select("id, due_at, body, customer_id")
      .is("completed_at", null)
      .lt("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(PER_QUEUE_LIMIT),
    supabase
      .schema("resupply")
      .from("shop_returns")
      .select("id, status, reason, customer_id, created_at")
      .in("status", ["requested", "approved", "shipped_back", "received"])
      .order("created_at", { ascending: true })
      .limit(PER_QUEUE_LIMIT),
    // Pull a wider window than PER_QUEUE_LIMIT, then JS-side sort
    // by severity ranking + created_at. .order("severity", desc) on
    // the text column does alphabetical sort, which would push
    // `critical` to the BOTTOM of `warning|info|critical` — the
    // exact opposite of what we want. The slice below trims back
    // to PER_QUEUE_LIMIT after a deterministic priority sort.
    //
    // Snoozed-but-expired alerts must surface here too. A CSR can
    // snooze a `critical` alert for 24h to chase a callback; if the
    // patient never replies, the alert needs to come BACK on the
    // CSR worklist the next morning. Without the OR-clause the
    // alert stayed in `snoozed` status forever and silently dropped
    // off every dashboard.
    supabase
      .schema("resupply")
      .from("csr_compliance_alerts")
      .select(
        "id, alert_type, severity, summary, patient_id, status, snoozed_until, created_at",
      )
      .or(`status.eq.open,and(status.eq.snoozed,snoozed_until.lte.${nowIso})`)
      .order("created_at", { ascending: true })
      .limit(PER_QUEUE_LIMIT * 3),
    supabase
      .schema("resupply")
      .from("prescriptions")
      .select("id, patient_id, item_sku, hcpcs_code, valid_until")
      .eq("status", "active")
      .is("renewal_requested_at", null)
      .not("valid_until", "is", null)
      .gte("valid_until", todayDate)
      .lte("valid_until", horizonDate)
      .order("valid_until", { ascending: true })
      .limit(PER_QUEUE_LIMIT),
    supabase
      .schema("resupply")
      .from("patient_documents")
      .select("id, document_type, patient_id, filename, created_at")
      .is("reviewed_at", null)
      .order("created_at", { ascending: true })
      .limit(PER_QUEUE_LIMIT),
    supabase
      .schema("resupply")
      .from("inbound_faxes")
      .select("id, twilio_fax_sid, from_e164, num_pages, received_at")
      .eq("status", "new")
      .order("received_at", { ascending: true })
      .limit(PER_QUEUE_LIMIT),
  ]);

  // Surface any read error to the client as 503 — partial worklists
  // are misleading, and the SPA already has the inbox-counts
  // counters as a fallback signal.
  for (const r of [
    convRes,
    patientFollowupRes,
    shopFollowupRes,
    returnsRes,
    alertsRes,
    rxRes,
    docsRes,
    faxesRes,
  ]) {
    if (r.error) {
      logger.error(
        { err: r.error.message },
        "admin.today: queue read failed",
      );
      res.status(503).json({ error: "queue_read_failed" });
      return;
    }
  }

  // Merge the two follow-up queries into one stream sorted by due_at.
  const patientFollowups: FollowupRow[] = (patientFollowupRes.data ?? []).map(
    (r) => ({
      id: r.id,
      due_at: r.due_at,
      body: r.body,
      patient_id: r.patient_id,
      customer_id: null,
      source: "patient" as const,
    }),
  );
  const shopFollowups: FollowupRow[] = (shopFollowupRes.data ?? []).map(
    (r) => ({
      id: r.id,
      due_at: r.due_at,
      body: r.body,
      patient_id: null,
      customer_id: r.customer_id,
      source: "shop_customer" as const,
    }),
  );
  const overdueFollowups = [...patientFollowups, ...shopFollowups]
    .sort((a, b) => (a.due_at < b.due_at ? -1 : 1))
    .slice(0, PER_QUEUE_LIMIT);

  // Severity sort: critical first, then warning, then info. Matches
  // csr-compliance-alerts.ts. The DB query pulled more than
  // PER_QUEUE_LIMIT rows precisely so this re-sort can trim back to
  // the cap with critical alerts at the top.
  const SEVERITY_ORDER: Record<string, number> = {
    critical: 1,
    warning: 2,
    info: 3,
  };
  const sortedAlerts = ((alertsRes.data ?? []) as ComplianceAlertRow[])
    .slice()
    .sort((a, b) => {
      const sa = SEVERITY_ORDER[a.severity] ?? 99;
      const sb = SEVERITY_ORDER[b.severity] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.created_at < b.created_at ? -1 : 1;
    })
    .slice(0, PER_QUEUE_LIMIT);

  res.json({
    serverTime: nowIso,
    conversationsAwaitingReply: (convRes.data ?? []) as ConversationRow[],
    overdueFollowups,
    pendingReturns: (returnsRes.data ?? []) as ReturnRow[],
    complianceAlerts: sortedAlerts,
    rxRenewalsDue: (rxRes.data ?? []) as RxRenewalRow[],
    documentsToReview: (docsRes.data ?? []) as DocumentRow[],
    inboundFaxes: (faxesRes.data ?? []) as InboundFaxRow[],
  });
});

export default router;
