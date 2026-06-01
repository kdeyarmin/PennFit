// /admin/shop/customers/:customerId/timeline — cross-channel customer
// timeline (Phase 4, CSR #12). "Everything this person contacted us
// about" — conversations, orders, returns, follow-ups, and reviews for
// one shop customer, merged on timestamp, newest first.
//
// The patient side already has /admin/patients/:id/timeline; this is the
// shop-customer equivalent feeding Customer360. All sources read in
// parallel; the merge is a pure, tested helper. conversations.manage-
// gated (the Customer360 scope). Metadata only — ids + status + kind +
// timestamps; no message bodies, no PHI in the payload.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export type CustomerEventKind =
  | "conversation"
  | "order"
  | "return"
  | "followup"
  | "review";

export interface CustomerEvent {
  kind: CustomerEventKind;
  refId: string;
  at: string;
  /** Short status / descriptor per kind (e.g. order status, review rating). */
  label: string;
}

export interface CustomerTimelineSources {
  conversations: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  returns: Array<Record<string, unknown>>;
  followups: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Pure: flatten every source into a single { kind, refId, at, label }
 * list and sort newest-first. Rows without an id or timestamp are
 * skipped. No I/O — unit-tested directly.
 */
export function buildCustomerTimeline(
  sources: CustomerTimelineSources,
): CustomerEvent[] {
  const events: CustomerEvent[] = [];
  const push = (
    kind: CustomerEventKind,
    rows: Array<Record<string, unknown>>,
    label: (r: Record<string, unknown>) => string,
    at: (r: Record<string, unknown>) => unknown = (r) => r.created_at,
  ): void => {
    for (const r of rows) {
      const refId = str(r.id);
      const ts = str(at(r));
      if (refId === "" || ts === "") continue;
      events.push({ kind, refId, at: ts, label: label(r) });
    }
  };

  push("conversation", sources.conversations, (r) =>
    `${str(r.channel) || "thread"} · ${str(r.status)}`.trim(),
  );
  push("order", sources.orders, (r) => str(r.status) || "order");
  push("return", sources.returns, (r) => str(r.status) || "return");
  push(
    "followup",
    sources.followups,
    (r) => (r.completed_at ? "completed" : "open"),
    (r) => r.due_at ?? r.created_at,
  );
  push(
    "review",
    sources.reviews,
    (r) => `${str(r.rating)}★ · ${str(r.status)}`,
  );

  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return events;
}

router.get(
  "/admin/shop/customers/:customerId/timeline",
  adminReadRateLimiter,
  requirePermission("conversations.manage"),
  async (req, res) => {
    const customerId = String(req.params.customerId ?? "").trim();
    if (customerId === "" || customerId.length > 128) {
      res.status(400).json({ error: "invalid_customer_id" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const sb = (table: string, cols: string) =>
      supabase
        .schema("resupply")
        .from(table)
        .select(cols)
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(100);

    const [conv, orders, returns, followups, reviews] = await Promise.all([
      sb("conversations", "id, channel, status, created_at"),
      sb("shop_orders", "id, status, created_at"),
      sb("shop_returns", "id, status, created_at"),
      sb("shop_customer_followups", "id, due_at, completed_at, created_at"),
      sb("shop_reviews", "id, rating, status, created_at"),
    ]);
    for (const r of [conv, orders, returns, followups, reviews]) {
      if (r.error) {
        res
          .status(500)
          .json({ error: "query_failed", message: r.error.message });
        return;
      }
    }

    // Errors were already short-circuited above; the rows are the success
    // shape. The response `.data` union still includes the error variant,
    // so double-cast through `unknown` (matches analytics.ts).
    const rows = (r: { data: unknown }): Array<Record<string, unknown>> =>
      (r.data ?? []) as unknown as Array<Record<string, unknown>>;
    const events = buildCustomerTimeline({
      conversations: rows(conv),
      orders: rows(orders),
      returns: rows(returns),
      followups: rows(followups),
      reviews: rows(reviews),
    });

    res.json({ events, count: events.length });
  },
);

export default router;
