// /shop/me/cart-snapshot — server-side mirror of a SIGNED-IN
// shop visitor's localStorage cart, used by:
//
//   1. The 24h "you left items in your cart" SendGrid nudge
//      (see routes/admin/abandoned-carts.ts).
//   2. Cross-device cart rehydration (?resume=1 on /shop/cart).
//
// Endpoints:
//   PUT    /shop/me/cart-snapshot   — upsert the row
//   DELETE /shop/me/cart-snapshot   — explicit clear (sets cleared_at)
//   GET    /shop/me/cart-snapshot   — read for rehydration
//
// All require sign-in. Guests are intentionally not tracked: there's
// no stable identity to email and no cross-device case to solve.
//
// PUT semantics:
//   * If items array is empty, the call is treated as a DELETE.
//   * On material change to items (add/remove/quantity/mode), the
//     three suppression flags (reminded_at, recovered_at, cleared_at)
//     are reset to null. This intentionally lets a re-fill after a
//     long wait become re-eligible for ONE more nudge.
//   * Email is denormalized at write time from the auth provider so the dispatcher
//     can scan in a single query without N+1 lookups. A the auth provider blip is
//     non-fatal — we keep the previously-stored email rather than
//     null it out.
//
// Privacy: cart contents are public catalog data (Stripe price/product
// IDs, names, qty). NO PHI lands here. Email is the only PII and it's
// denormalized from a auth lookup the user already authorized by
// signing in.

import { Router, type IRouter } from "express";
import { readCustomerProfile } from "../../lib/customer-profile";
import { z } from "zod";

import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import type { ShopAbandonedCartItem } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const MAX_ITEMS = 50;

const itemSchema = z
  .object({
    priceId: z.string().min(1).max(120),
    productId: z.string().min(1).max(120),
    name: z.string().min(1).max(240),
    quantity: z.number().int().min(1).max(20),
    unitAmountCents: z.number().int().min(0).max(10_000_000),
    currency: z.string().min(3).max(8),
    mode: z.enum(["one_time", "subscription"]),
    recurringPriceId: z.string().min(1).max(120).nullable(),
    recurringIntervalLabel: z.string().min(1).max(40).nullable(),
    imageUrl: z.string().max(2048).nullable(),
    isBundle: z.boolean(),
  })
  .strict();

const putBody = z
  .object({
    items: z.array(itemSchema).max(MAX_ITEMS),
    subtotalCents: z.number().int().min(0).max(100_000_000),
    currency: z.string().min(3).max(8),
  })
  .strict();

/**
 * Stable signature of a cart's items used to decide "did the cart
 * change materially since the last PUT?" — controls whether we reset
 * the suppression flags. Order-independent (sort by priceId) so a
 * re-render that re-orders items doesn't count as a change.
 */
function itemsSignature(items: readonly ShopAbandonedCartItem[]): string {
  const norm = items
    .map((it) => ({
      p: it.priceId,
      q: it.quantity,
      m: it.mode,
      r: it.recurringPriceId ?? null,
    }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return JSON.stringify(norm);
}

router.put("/shop/me/cart-snapshot", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  const parsed = putBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const { items, subtotalCents, currency } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();

  // Empty PUT → treat as explicit clear. Cheaper than asking the
  // frontend to remember to call DELETE separately when the user
  // removed the last item.
  if (items.length === 0) {
    const { error } = await supabase
      .schema("resupply")
      .from("shop_abandoned_carts")
      .update({
        items: [] as unknown as Json,
        subtotal_cents: 0,
        currency,
        cleared_at: nowIso,
        updated_at: nowIso,
      })
      .eq("customer_id", customerId);
    if (error) throw error;
    res.json({ ok: true, items: [], subtotalCents: 0 });
    return;
  }

  // Look up the existing row's items to decide whether the change is
  // material enough to reset the suppression flags. A pure subtotal
  // re-tick (e.g. price metadata refresh) doesn't reset; a quantity
  // or composition change does.
  const { data: existing, error: existingError } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .select("items, email")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  const existingItems = (existing?.items ?? []) as unknown as ShopAbandonedCartItem[];
  const materiallyChanged =
    !existing || itemsSignature(existingItems) !== itemsSignature(items);

  // Refresh the denormalized email from the request (set by
  // requireSignedIn from auth.users). Never overwrite a known
  // email with null on a missing-profile case — keep the prior
  // value so the dispatcher can still find the row.
  const profile = await readCustomerProfile(req);
  const freshEmail = profile.email?.toLowerCase() ?? null;
  const email = freshEmail ?? existing?.email ?? null;

  // PostgREST `.upsert(..., { onConflict: 'customer_id' })` updates
  // every column we send, exactly the equivalent of the original
  // `EXCLUDED.<col>` ON CONFLICT clause. The materially-changed
  // suppression-flag reset is included in the same payload (only
  // when needed) so the upsert atomically transitions a re-fill
  // back into "eligible for nudge" state.
  const upsertRow: Record<string, unknown> = {
    customer_id: customerId,
    email,
    items: items as unknown as Json,
    subtotal_cents: subtotalCents,
    currency,
    updated_at: nowIso,
  };
  if (materiallyChanged) {
    upsertRow.reminded_at = null;
    upsertRow.recovered_at = null;
    upsertRow.cleared_at = null;
  }

  const { error: upsertErr } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .upsert(upsertRow, { onConflict: "customer_id" });
  if (upsertErr) throw upsertErr;

  res.json({ ok: true, items, subtotalCents });
});

router.delete("/shop/me/cart-snapshot", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  // Idempotent: 200 even if no row exists. Setting items=[] +
  // cleared_at=now suppresses the dispatcher; leaves the row in
  // place so an immediate re-fill can decide whether to re-trigger
  // (handled by PUT's materially-changed path).
  const { error } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .update({
      items: [] as unknown as Json,
      subtotal_cents: 0,
      cleared_at: nowIso,
      updated_at: nowIso,
    })
    .eq("customer_id", customerId);
  if (error) throw error;
  res.json({ ok: true });
});

router.get("/shop/me/cart-snapshot", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row } = await supabase
    .schema("resupply")
    .from("shop_abandoned_carts")
    .select("items, subtotal_cents, currency, updated_at")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (!row) {
    res.json({ items: [], subtotalCents: 0, currency: "usd", updatedAt: null });
    return;
  }
  res.json({
    items: row.items,
    subtotalCents: row.subtotal_cents,
    currency: row.currency,
    updatedAt: row.updated_at,
  });
});

export default router;
