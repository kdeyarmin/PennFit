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
//   * Email is denormalized at write time from Clerk so the dispatcher
//     can scan in a single query without N+1 lookups. A Clerk blip is
//     non-fatal — we keep the previously-stored email rather than
//     null it out.
//
// Privacy: cart contents are public catalog data (Stripe price/product
// IDs, names, qty). NO PHI lands here. Email is the only PII and it's
// denormalized from a Clerk lookup the user already authorized by
// signing in.

import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { clerkClient } from "@clerk/express";
import { z } from "zod";

import { getDbPool, shopAbandonedCarts } from "@workspace/resupply-db";
import type {
  InsertShopAbandonedCartRow,
  ShopAbandonedCartItem,
} from "@workspace/resupply-db";

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

/**
 * Best-effort Clerk email lookup. Returns lowercase email or null.
 * Never throws — a Clerk Backend API blip should NOT fail the snapshot
 * write (the cart is public catalog data; missing email just means
 * the dispatcher will skip this row until the next PUT succeeds).
 */
async function fetchClerkEmail(
  clerkUserId: string,
  log?: { warn?: (...a: unknown[]) => void },
): Promise<string | null> {
  try {
    const user = await clerkClient.users.getUser(clerkUserId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ??
      user.emailAddresses[0];
    const raw = primary?.emailAddress ?? null;
    return raw ? raw.toLowerCase() : null;
  } catch (err) {
    log?.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      "shop/me/cart-snapshot: clerk user lookup failed; keeping prior email",
    );
    return null;
  }
}

router.put("/shop/me/cart-snapshot", requireSignedIn, async (req, res) => {
  const clerkUserId = req.userClerkId;
  if (!clerkUserId) {
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

  const db = drizzle(getDbPool());

  // Empty PUT → treat as explicit clear. Cheaper than asking the
  // frontend to remember to call DELETE separately when the user
  // removed the last item.
  if (items.length === 0) {
    await db
      .update(shopAbandonedCarts)
      .set({
        items: [],
        subtotalCents: 0,
        currency,
        clearedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopAbandonedCarts.clerkUserId, clerkUserId));
    res.json({ ok: true, items: [], subtotalCents: 0 });
    return;
  }

  // Look up the existing row's items to decide whether the change is
  // material enough to reset the suppression flags. A pure subtotal
  // re-tick (e.g. price metadata refresh) doesn't reset; a quantity
  // or composition change does.
  const existingRows = await db
    .select({ items: shopAbandonedCarts.items, email: shopAbandonedCarts.email })
    .from(shopAbandonedCarts)
    .where(eq(shopAbandonedCarts.clerkUserId, clerkUserId))
    .limit(1);
  const existing = existingRows[0];
  const materiallyChanged =
    !existing || itemsSignature(existing.items) !== itemsSignature(items);

  // Refresh the denormalized email on every PUT — but never overwrite
  // a known email with null on a Clerk blip.
  const freshEmail = await fetchClerkEmail(clerkUserId, req.log);
  const email = freshEmail ?? existing?.email ?? null;

  const now = new Date();
  const insertRow: InsertShopAbandonedCartRow = {
    clerkUserId,
    email,
    items,
    subtotalCents,
    currency,
    updatedAt: now,
    // Only stamp recovered/cleared/reminded resets when the cart
    // actually changed. Otherwise leave existing values alone.
    ...(materiallyChanged
      ? {
          remindedAt: null,
          recoveredAt: null,
          clearedAt: null,
        }
      : {}),
  };

  await db
    .insert(shopAbandonedCarts)
    .values(insertRow)
    .onConflictDoUpdate({
      target: shopAbandonedCarts.clerkUserId,
      set: {
        email: sql`excluded.email`,
        items: sql`excluded.items`,
        subtotalCents: sql`excluded.subtotal_cents`,
        currency: sql`excluded.currency`,
        updatedAt: sql`excluded.updated_at`,
        ...(materiallyChanged
          ? {
              remindedAt: sql`NULL`,
              recoveredAt: sql`NULL`,
              clearedAt: sql`NULL`,
            }
          : {}),
      },
    });

  res.json({ ok: true, items, subtotalCents });
});

router.delete("/shop/me/cart-snapshot", requireSignedIn, async (req, res) => {
  const clerkUserId = req.userClerkId;
  if (!clerkUserId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const db = drizzle(getDbPool());
  // Idempotent: 200 even if no row exists. Setting items=[] +
  // cleared_at=now suppresses the dispatcher; leaves the row in
  // place so an immediate re-fill can decide whether to re-trigger
  // (handled by PUT's materially-changed path).
  await db
    .update(shopAbandonedCarts)
    .set({
      items: [],
      subtotalCents: 0,
      clearedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(shopAbandonedCarts.clerkUserId, clerkUserId));
  res.json({ ok: true });
});

router.get("/shop/me/cart-snapshot", requireSignedIn, async (req, res) => {
  const clerkUserId = req.userClerkId;
  if (!clerkUserId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      items: shopAbandonedCarts.items,
      subtotalCents: shopAbandonedCarts.subtotalCents,
      currency: shopAbandonedCarts.currency,
      updatedAt: shopAbandonedCarts.updatedAt,
    })
    .from(shopAbandonedCarts)
    .where(eq(shopAbandonedCarts.clerkUserId, clerkUserId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    res.json({ items: [], subtotalCents: 0, currency: "usd", updatedAt: null });
    return;
  }
  res.json({
    items: row.items,
    subtotalCents: row.subtotalCents,
    currency: row.currency,
    updatedAt: row.updatedAt.toISOString(),
  });
});

export default router;
