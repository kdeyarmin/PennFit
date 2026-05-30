// /admin/patients/:id/timeline — unified chronological feed across
// episodes, fulfillments, conversations, address changes, grievances,
// coaching plans, recall notifications, and onboarding checkpoints.
//
// All sources read in parallel, merged on timestamp, capped at the
// most-recent 200 events. Pure read-only aggregator — no writes,
// no joins on the DB side. PostgREST returns each source's rows
// as flat lists; we project each into a uniform Event shape and
// sort.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patientIdParam = z.object({ id: z.string().uuid() });

interface TimelineEvent {
  /** Event source — drives the SPA icon + color. */
  kind:
    | "episode_created"
    | "episode_status"
    | "fulfillment_shipped"
    | "fulfillment_delivered"
    | "conversation_opened"
    | "address_changed"
    | "grievance_received"
    | "coaching_plan_opened"
    | "recall_notified"
    | "onboarding_day";
  /** Display title. */
  title: string;
  /** Single-line context. */
  detail: string;
  /** Source-row id, useful for deep-links. */
  refId: string;
  /** ISO timestamp the event occurred. */
  at: string;
}

router.get(
  "/admin/patients/:id/timeline",
  // Read-only aggregator over the patient's clinical history. Every
  // current admin role holds `patients.read` (see rbac.ts), so this
  // tightening preserves access for all of admin/supervisor/csr/
  // fitter/fulfillment/compliance_officer/agent but documents the
  // scope contract so a future role with narrower permissions can't
  // accidentally land in this route unguarded.
  requirePermission("patients.read"),
  async (req, res) => {
    const params = patientIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = params.data.id;
    const supabase = getSupabaseServiceRoleClient();
    const events: TimelineEvent[] = [];

    const queries = await Promise.all([
      supabase
        .schema("resupply")
        .from("episodes")
        .select("id, status, created_at")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .schema("resupply")
        .from("fulfillments")
        .select("id, item_sku, status, shipped_at, delivered_at, created_at")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .schema("resupply")
        .from("conversations")
        .select("id, channel, status, created_at")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .schema("resupply")
        .from("patient_address_history")
        .select("id, reason, created_at")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .schema("resupply")
        .from("patient_grievances")
        .select("id, kind, severity, summary, received_at")
        .eq("patient_id", patientId)
        .order("received_at", { ascending: false })
        .limit(50),
      supabase
        .schema("resupply")
        .from("patient_coaching_plans")
        .select("id, status, target_compliance_pct, opened_at")
        .eq("patient_id", patientId)
        .order("opened_at", { ascending: false })
        .limit(20),
      supabase
        .schema("resupply")
        .from("recall_notifications")
        .select("id, status, channel, notified_at, created_at")
        .eq("patient_id", patientId)
        .order("created_at", { ascending: false })
        .limit(30),
    ]);
    for (const q of queries) {
      if (q.error) throw q.error;
    }
    const [
      episodes,
      fulfillments,
      conversations,
      addressHistory,
      grievances,
      plans,
      recalls,
    ] = queries.map((q) => q.data ?? []);

    for (const e of episodes as Array<{
      id: string;
      status: string;
      created_at: string;
    }>) {
      events.push({
        kind: "episode_created",
        title: `Episode ${e.status}`,
        detail: `Resupply cycle in ${e.status} state`,
        refId: e.id,
        at: e.created_at,
      });
    }
    for (const f of fulfillments as Array<{
      id: string;
      item_sku: string;
      status: string;
      shipped_at: string | null;
      delivered_at: string | null;
      created_at: string;
    }>) {
      if (f.shipped_at) {
        events.push({
          kind: "fulfillment_shipped",
          title: `${f.item_sku} shipped`,
          detail: `Fulfillment status: ${f.status}`,
          refId: f.id,
          at: f.shipped_at,
        });
      }
      if (f.delivered_at) {
        events.push({
          kind: "fulfillment_delivered",
          title: `${f.item_sku} delivered`,
          detail: `Carrier confirmation received`,
          refId: f.id,
          at: f.delivered_at,
        });
      }
    }
    for (const c of conversations as Array<{
      id: string;
      channel: string;
      status: string;
      created_at: string;
    }>) {
      events.push({
        kind: "conversation_opened",
        title: `Conversation (${c.channel})`,
        detail: `Status: ${c.status}`,
        refId: c.id,
        at: c.created_at,
      });
    }
    for (const a of addressHistory as Array<{
      id: string;
      reason: string | null;
      created_at: string;
    }>) {
      events.push({
        kind: "address_changed",
        title: "Shipping address updated",
        detail: a.reason ?? "no reason recorded",
        refId: a.id,
        at: a.created_at,
      });
    }
    for (const g of grievances as Array<{
      id: string;
      kind: string;
      severity: string;
      summary: string;
      received_at: string;
    }>) {
      events.push({
        kind: "grievance_received",
        title: `${g.kind.replace(/_/g, " ")} (${g.severity})`,
        detail: g.summary,
        refId: g.id,
        at: g.received_at,
      });
    }
    for (const p of plans as Array<{
      id: string;
      status: string;
      target_compliance_pct: number;
      opened_at: string;
    }>) {
      events.push({
        kind: "coaching_plan_opened",
        title: "Adherence coaching plan",
        detail: `Status: ${p.status}, target ${p.target_compliance_pct}%`,
        refId: p.id,
        at: p.opened_at,
      });
    }
    for (const r of recalls as Array<{
      id: string;
      status: string;
      channel: string | null;
      notified_at: string | null;
      created_at: string;
    }>) {
      events.push({
        kind: "recall_notified",
        title: "Recall notification",
        detail: `${r.status}${r.channel ? ` via ${r.channel}` : ""}`,
        refId: r.id,
        at: r.notified_at ?? r.created_at,
      });
    }

    events.sort((a, b) => (a.at < b.at ? 1 : -1));
    res.json({ events: events.slice(0, 200) });
  },
);

export default router;
