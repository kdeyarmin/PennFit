// /admin/shop/abandoned-carts/* — admin tooling for the cart-
// abandonment SendGrid nudge.
//
// Two endpoints, both requireAdmin-gated:
//
//   GET  /admin/shop/abandoned-carts            — list rows for the
//                                                   admin UI (status,
//                                                   item count, ts).
//   POST /admin/shop/abandoned-carts/send-due   — dispatcher: scan
//                                                   for rows older
//                                                   than 24h that
//                                                   pass suppression
//                                                   filters, send
//                                                   one email each,
//                                                   stamp reminded_at.
//
// Suppression policy (also enforced at the SQL layer for safety):
//   * items != []                — there's something to nudge about
//   * reminded_at IS NULL        — only one nudge per cart-event
//   * recovered_at IS NULL       — they already paid; never nudge
//   * cleared_at IS NULL         — they explicitly emptied; respect it
//   * email IS NOT NULL          — auth lookup must have succeeded
//   * updated_at <= now() - 24h  — give them a real chance to come
//                                   back on their own first
//
// Idempotency: a second invocation immediately after the first finds
// `reminded_at IS NOT NULL` for every row we just stamped, so it sends
// nothing. Safe to re-run.
//
// Concurrency posture: the original Drizzle path used a single SQL
// `WITH eligible … FOR UPDATE SKIP LOCKED` claim. PostgREST has no
// SKIP LOCKED, so we approximate with SELECT-then-UPDATE-with-null-
// guard. Two parallel invocations both fetch the same candidate ids
// and then both try to stamp `reminded_at`; Postgres serialises the
// UPDATEs, the second one matches zero rows, and does no work.
// Correctness preserved, parallelism lost — fine for a manual admin
// dispatcher.

import { Router, type IRouter } from "express";

import {
  getSupabaseServiceRoleClient,
  type ShopAbandonedCartItem,
} from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin, requirePermission } from "../../middlewares/requireAdmin";
import { runCartAbandonmentDispatch } from "../../lib/cart-abandonment/run-dispatch";

const router: IRouter = Router();

router.get("/admin/shop/abandoned-carts", requireAdmin, async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .select(
      "id, customer_id, email, items, subtotal_cents, currency, updated_at, reminded_at, recovered_at, cleared_at, created_at",
    )
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw error;

  // Email is partially redacted in the response — admins don't need
  // the full address to triage a row, and this keeps an extra step
  // between an exported admin log and a usable contact list.
  function redactEmail(e: string | null): string | null {
    if (!e) return null;
    const at = e.indexOf("@");
    if (at <= 0) return "***";
    const local = e.slice(0, at);
    const domain = e.slice(at + 1);
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
  }

  res.json({
    rows: (rows ?? []).map((r) => {
      const items = (r.items ?? []) as unknown as ShopAbandonedCartItem[];
      return {
        id: r.id,
        customerId: r.customer_id,
        emailRedacted: redactEmail(r.email),
        itemCount: Array.isArray(items)
          ? items.reduce((sum, it) => sum + (it.quantity || 0), 0)
          : 0,
        subtotalCents: r.subtotal_cents,
        currency: r.currency,
        updatedAt: r.updated_at,
        remindedAt: r.reminded_at,
        recoveredAt: r.recovered_at,
        clearedAt: r.cleared_at,
        createdAt: r.created_at,
      };
    }),
  });
});

// Manual dispatcher — thin wrapper around runCartAbandonmentDispatch.
// Same dispatcher runs hourly via the pg-boss cron registered in
// artifacts/resupply-api/src/worker/jobs/cart-abandonment-scan.ts, so
// this route is now mostly a backup for staff who want to trigger a
// sweep without waiting for the cron tick. The shared helper is the
// single source of truth for the suppression rules and stats shape.
router.post(
  "/admin/shop/abandoned-carts/send-due",
  requirePermission("bulk_campaigns.send"),
  adminRateLimit({ name: "abandoned_carts.send_due", preset: "bulk" }),
  async (req, res) => {
    const stats = await runCartAbandonmentDispatch({ log: req.log });
    res.json(stats);
  },
);

export default router;
