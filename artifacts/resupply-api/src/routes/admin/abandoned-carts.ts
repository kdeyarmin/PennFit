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
//   * email IS NOT NULL          — Clerk lookup must have succeeded
//   * updated_at <= now() - 24h  — give them a real chance to come
//                                   back on their own first
//
// Idempotency: a second invocation immediately after the first finds
// `reminded_at IS NOT NULL` for every row we just stamped, so it sends
// nothing. Safe to re-run.
//
// Concurrency: the dispatcher uses an *atomic claim* pattern — a
// single UPDATE ... RETURNING flips `reminded_at` from NULL to now()
// for every eligible row in one statement. Two parallel invocations
// can never both observe the same row as eligible, because Postgres
// serialises the row updates. If a SendGrid send subsequently fails
// for a claimed row we *unclaim* it (set `reminded_at` back to NULL)
// so the next run can retry it. This means the only way a row stays
// stamped is when delivery succeeded, matching the spec contract
// "on delivered=true set reminded_at = now()" while removing the
// double-send race window.
//
// We DO NOT auto-cron this in v1 — same pattern as the existing
// reminders dispatcher (artifacts/api-server/src/routes/reminders.ts).
// The admin clicks the button. A future Phase will wire pg-boss.

import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  getDbPool,
  shopAbandonedCarts,
  type ShopAbandonedCartItem,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";
import { sendCartAbandonmentEmail } from "../../lib/cart-abandonment/send-cart-abandonment-email";

const router: IRouter = Router();

const NUDGE_WAIT_MS = 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 200;

router.get("/admin/shop/abandoned-carts", requireAdmin, async (_req, res) => {
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: shopAbandonedCarts.id,
      clerkUserId: shopAbandonedCarts.clerkUserId,
      email: shopAbandonedCarts.email,
      items: shopAbandonedCarts.items,
      subtotalCents: shopAbandonedCarts.subtotalCents,
      currency: shopAbandonedCarts.currency,
      updatedAt: shopAbandonedCarts.updatedAt,
      remindedAt: shopAbandonedCarts.remindedAt,
      recoveredAt: shopAbandonedCarts.recoveredAt,
      clearedAt: shopAbandonedCarts.clearedAt,
      createdAt: shopAbandonedCarts.createdAt,
    })
    .from(shopAbandonedCarts)
    .orderBy(desc(shopAbandonedCarts.updatedAt))
    .limit(200);

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
    rows: rows.map((r) => ({
      id: r.id,
      clerkUserId: r.clerkUserId,
      emailRedacted: redactEmail(r.email),
      itemCount: Array.isArray(r.items)
        ? r.items.reduce((sum, it) => sum + (it.quantity || 0), 0)
        : 0,
      subtotalCents: r.subtotalCents,
      currency: r.currency,
      updatedAt: r.updatedAt.toISOString(),
      remindedAt: r.remindedAt?.toISOString() ?? null,
      recoveredAt: r.recoveredAt?.toISOString() ?? null,
      clearedAt: r.clearedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.post(
  "/admin/shop/abandoned-carts/send-due",
  requireAdmin,
  async (req, res) => {
    const db = drizzle(getDbPool());
    const cutoff = new Date(Date.now() - NUDGE_WAIT_MS);

    // ────────────────────────────────────────────────────────────────
    // Atomic claim. One UPDATE flips `reminded_at` from NULL to now()
    // for every eligible row in a single statement and RETURNs the
    // claimed rows. Two concurrent invocations cannot both observe a
    // row as eligible — Postgres serialises the row updates.
    //
    // Eligibility predicate is identical to the suppression policy in
    // the file header, kept inside the UPDATE WHERE so claims and
    // filtering happen in one step (no TOCTOU between SELECT and
    // UPDATE). The SCAN_LIMIT bound is enforced via a CTE (UPDATE has
    // no LIMIT clause in Postgres).
    //
    // If a SendGrid send subsequently fails for a claimed row we
    // unclaim it below (set `reminded_at` back to NULL) so the next
    // run can retry. The only way a row stays stamped is when the
    // email actually went out.
    // ────────────────────────────────────────────────────────────────
    const claimedRaw = await db.execute(sql`
      WITH eligible AS (
        SELECT id
        FROM ${shopAbandonedCarts}
        WHERE ${shopAbandonedCarts.updatedAt} <= ${cutoff}
          AND ${shopAbandonedCarts.remindedAt} IS NULL
          AND ${shopAbandonedCarts.recoveredAt} IS NULL
          AND ${shopAbandonedCarts.clearedAt} IS NULL
          AND ${shopAbandonedCarts.email} IS NOT NULL
          AND jsonb_array_length(${shopAbandonedCarts.items}) > 0
        ORDER BY ${shopAbandonedCarts.updatedAt} ASC
        LIMIT ${SCAN_LIMIT}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${shopAbandonedCarts}
      SET reminded_at = now()
      WHERE id IN (SELECT id FROM eligible)
      RETURNING id, email, items, subtotal_cents AS "subtotalCents", currency
    `);
    const claimed = (claimedRaw.rows ?? []) as Array<{
      id: string;
      email: string | null;
      items: ShopAbandonedCartItem[];
      subtotalCents: number;
      currency: string;
    }>;

    let sent = 0;
    let skippedNoConfig = 0;
    let skippedFailed = 0;
    let configuredFlag = true;

    for (const row of claimed) {
      // Defensive: belt-and-suspenders email check (the SQL filter
      // already guarded this, but null-checks are cheap and the
      // SendGrid SDK throws on missing `to`).
      if (!row.email) {
        // Unclaim — we should never have stamped a no-email row, but
        // if we did, undo so an out-of-band PUT that backfills the
        // email becomes eligible again.
        await db
          .update(shopAbandonedCarts)
          .set({ remindedAt: null })
          .where(eq(shopAbandonedCarts.id, row.id));
        skippedFailed += 1;
        continue;
      }

      let outcome;
      try {
        outcome = await sendCartAbandonmentEmail({
          toEmail: row.email,
          items: row.items,
          subtotalCents: row.subtotalCents,
          currency: row.currency,
        });
      } catch (err) {
        // Helper threw (most commonly EmailConfigError when SendGrid
        // env is missing). Treat as "no config" — unclaim so future
        // runs after env is fixed will retry, and abort the loop
        // because none of the remaining sends will succeed either.
        await db
          .update(shopAbandonedCarts)
          .set({ remindedAt: null })
          .where(eq(shopAbandonedCarts.id, row.id));
        configuredFlag = false;
        skippedNoConfig += 1;
        // Unclaim every still-pending row from this batch so the next
        // dispatcher run gets a clean slate. Without this, a missing
        // env var would silently consume all eligible rows for the
        // session.
        const remainingIds = claimed
          .slice(claimed.indexOf(row) + 1)
          .map((r) => r.id);
        if (remainingIds.length > 0) {
          await db
            .update(shopAbandonedCarts)
            .set({ remindedAt: null })
            .where(
              sql`${shopAbandonedCarts.id} IN (${sql.join(
                remainingIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            );
        }
        skippedNoConfig += remainingIds.length;
        req.log?.warn(
          { rowId: row.id, err: err instanceof Error ? err.message : String(err) },
          "cart-abandonment send threw — unclaiming batch",
        );
        break;
      }

      if (!outcome.configured) {
        await db
          .update(shopAbandonedCarts)
          .set({ remindedAt: null })
          .where(eq(shopAbandonedCarts.id, row.id));
        configuredFlag = false;
        skippedNoConfig += 1;
        continue;
      }
      if (!outcome.delivered) {
        await db
          .update(shopAbandonedCarts)
          .set({ remindedAt: null })
          .where(eq(shopAbandonedCarts.id, row.id));
        skippedFailed += 1;
        // Privacy: log the row id, not the email.
        req.log?.warn(
          { rowId: row.id, error: outcome.error },
          "cart-abandonment send failed",
        );
        continue;
      }

      // Send succeeded — claim sticks. We do NOT clear items, the
      // row stays so PUT can detect the next material change and
      // re-eligible.
      sent += 1;
    }

    res.json({
      scanned: claimed.length,
      sent,
      skippedNoConfig,
      skippedFailed,
      sendgridConfigured: configuredFlag,
    });
  },
);

export default router;
