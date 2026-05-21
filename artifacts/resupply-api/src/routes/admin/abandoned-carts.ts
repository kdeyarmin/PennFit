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
  DEFAULT_COMMUNICATION_PREFERENCES,
  getSupabaseServiceRoleClient,
  type CommunicationPreferences,
  type ShopAbandonedCartItem,
} from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin, requirePermission } from "../../middlewares/requireAdmin";
import { sendCartAbandonmentEmail } from "../../lib/cart-abandonment/send-cart-abandonment-email";
import { isInDndWindow } from "../../lib/comm-prefs";

const router: IRouter = Router();

const NUDGE_WAIT_MS = 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 200;

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

router.post(
  "/admin/shop/abandoned-carts/send-due",
  requirePermission("bulk_campaigns.send"),
  adminRateLimit({ name: "abandoned_carts.send_due", preset: "bulk" }),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const cutoffIso = new Date(Date.now() - NUDGE_WAIT_MS).toISOString();

    // Step 1 — collect eligible candidate ids. Suppression policy
    // mirrors the file-header rules. `jsonb_array_length(items) > 0`
    // → `.neq("items", "[]")` (default for shop_abandoned_carts.items
    // is a JSONB array, never null).
    const { data: candidates, error: candidatesErr } = await supabase
      .schema("resupply")
      .from("shop_abandoned_carts")
      .select("id")
      .lte("updated_at", cutoffIso)
      .is("reminded_at", null)
      .is("recovered_at", null)
      .is("cleared_at", null)
      .not("email", "is", null)
      .neq("items", "[]")
      .order("updated_at", { ascending: true })
      .limit(SCAN_LIMIT);
    if (candidatesErr) throw candidatesErr;

    const candidateIds = (candidates ?? []).map((r) => r.id);
    if (candidateIds.length === 0) {
      res.json({
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        skippedOptOut: 0,
        sendgridConfigured: true,
      });
      return;
    }

    // Step 2 — atomic stamp. The .is("reminded_at", null) guard
    // makes this idempotent under parallel calls.
    const nowIso = new Date().toISOString();
    const { data: claimedRows, error: claimErr } = await supabase
      .schema("resupply")
      .from("shop_abandoned_carts")
      .update({ reminded_at: nowIso })
      .in("id", candidateIds)
      .is("reminded_at", null)
      .select("id, customer_id, email, items, subtotal_cents, currency");
    if (claimErr) throw claimErr;

    const claimed = (claimedRows ?? []).map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      email: r.email,
      items: (r.items ?? []) as unknown as ShopAbandonedCartItem[],
      subtotalCents: r.subtotal_cents,
      currency: r.currency,
    }));

    // Pre-fetch comm prefs for every claimed user so we can suppress
    // sends for customers who turned off cart-abandonment nudges or
    // are inside a DND window. Single batch query — never N+1.
    const prefsByUser = new Map<
      string,
      ReturnType<typeof mergePrefs>
    >();
    if (claimed.length > 0) {
      const userIds = Array.from(new Set(claimed.map((r) => r.customerId)));
      const { data: customerRows, error: prefsErr } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select("customer_id, communication_preferences")
        .in("customer_id", userIds);
      if (prefsErr) throw prefsErr;
      for (const cr of customerRows ?? []) {
        prefsByUser.set(
          cr.customer_id,
          mergePrefs(
            (cr.communication_preferences as CommunicationPreferences | null) ??
              null,
          ),
        );
      }
    }

    let sent = 0;
    let skippedNoConfig = 0;
    let skippedFailed = 0;
    let skippedOptOut = 0;
    let configuredFlag = true;

    const unclaim = async (id: string): Promise<void> => {
      const { error: unclaimErr } = await supabase
        .schema("resupply")
        .from("shop_abandoned_carts")
        .update({ reminded_at: null })
        .eq("id", id);
      if (unclaimErr) {
        req.log?.warn(
          { err: unclaimErr, rowId: id },
          "cart-abandonment unclaim failed",
        );
      }
    };

    const unclaimMany = async (ids: string[]): Promise<void> => {
      if (ids.length === 0) return;
      const { error: unclaimErr } = await supabase
        .schema("resupply")
        .from("shop_abandoned_carts")
        .update({ reminded_at: null })
        .in("id", ids);
      if (unclaimErr) {
        req.log?.warn(
          { err: unclaimErr, idCount: ids.length },
          "cart-abandonment unclaim batch failed",
        );
      }
    };

    for (const row of claimed) {
      // Comm-prefs gate. If the user turned off abandoned-cart emails
      // or is currently in a DND window, unclaim and skip. Default
      // (no row in shop_customers) opts in.
      const prefs = prefsByUser.get(row.customerId) ?? mergePrefs(null);
      if (!prefs.emailAbandonedCart || isInDndWindow(prefs)) {
        await unclaim(row.id);
        skippedOptOut += 1;
        continue;
      }
      if (!row.email) {
        // Belt-and-suspenders: the SQL filter already guarded null
        // emails, but if a row sneaks through we unclaim and skip.
        await unclaim(row.id);
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
        await unclaim(row.id);
        configuredFlag = false;
        skippedNoConfig += 1;
        const remainingIds = claimed
          .slice(claimed.indexOf(row) + 1)
          .map((r) => r.id);
        await unclaimMany(remainingIds);
        skippedNoConfig += remainingIds.length;
        req.log?.warn(
          {
            rowId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "cart-abandonment send threw — unclaiming batch",
        );
        break;
      }

      if (!outcome.configured) {
        await unclaim(row.id);
        configuredFlag = false;
        skippedNoConfig += 1;
        continue;
      }
      if (!outcome.delivered) {
        await unclaim(row.id);
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
      skippedOptOut,
      sendgridConfigured: configuredFlag,
    });
  },
);

function mergePrefs(stored: CommunicationPreferences | null) {
  return stored
    ? { ...DEFAULT_COMMUNICATION_PREFERENCES, ...stored }
    : { ...DEFAULT_COMMUNICATION_PREFERENCES };
}

export default router;
