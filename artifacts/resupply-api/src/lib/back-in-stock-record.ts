// Best-effort DB helpers for the back-in-stock notify queue.
//
// recordBackInStockSignup — INSERTs a (product_id, email) row, or
// no-ops cleanly when the partial-unique index says this email is
// already pending for this product.
//
// dispatchBackInStockForProduct — fires SendGrid for every pending
// row on the given product, then stamps notified_at on each row
// regardless of delivery outcome (we don't want a transient SendGrid
// blip to re-fire on the next admin save).

import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  getDbPool,
  resupplySchema,
  shopBackInStockNotifications,
  type NewShopBackInStockNotification,
} from "@workspace/resupply-db";

import { logger } from "./logger";
import {
  sendBackInStockEmail,
  type BackInStockEmailPayload,
} from "./back-in-stock-email";

export interface RecordBackInStockSignupInput {
  productId: string;
  email: string;
  submitterIp: string | null;
  userAgent: string | null;
}

export interface RecordBackInStockSignupResult {
  /** "inserted" — fresh signup. "duplicate" — email already pending. */
  status: "inserted" | "duplicate" | "error";
  error?: string;
}

export async function recordBackInStockSignup(
  input: RecordBackInStockSignupInput,
): Promise<RecordBackInStockSignupResult> {
  try {
    const db = drizzle(getDbPool());
    const row: NewShopBackInStockNotification = {
      productId: input.productId,
      email: input.email,
      submitterIp: input.submitterIp,
      userAgent: input.userAgent,
    };
    // ON CONFLICT DO NOTHING against the partial unique index — if a
    // row already exists for (product_id, email) where notified_at
    // IS NULL we treat it as success (caller-visible "we have you on
    // the list" messaging is identical for both branches).
    const inserted = await db
      .insert(shopBackInStockNotifications)
      .values(row)
      .onConflictDoNothing({
        target: [
          shopBackInStockNotifications.productId,
          shopBackInStockNotifications.email,
        ],
        where: sql`${shopBackInStockNotifications.notifiedAt} IS NULL`,
      })
      .returning({ id: shopBackInStockNotifications.id });
    return {
      status: inserted.length > 0 ? "inserted" : "duplicate",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: msg, productId: input.productId },
      "back-in-stock-record: insert failed",
    );
    return { status: "error", error: msg };
  }
}

export interface DispatchBackInStockInput {
  productId: string;
  productName: string;
  productImageUrl?: string | null;
  productUrl: string;
  priceLabel?: string | null;
  /** Hard cap on how many emails to send per dispatch. Pending rows
   *  beyond this stay pending and will fire on a future stock save. */
  maxFanout?: number;
}

export interface DispatchBackInStockResult {
  pending: number;
  attempted: number;
  delivered: number;
  failed: number;
}

/**
 * Fire SendGrid for every pending signup on the product, then stamp
 * notified_at on each. Best-effort — never throws. Caller is expected
 * to run this fire-and-forget (`void dispatchBackInStockForProduct(...)`)
 * so an admin save returns immediately.
 */
export async function dispatchBackInStockForProduct(
  input: DispatchBackInStockInput,
): Promise<DispatchBackInStockResult> {
  const result: DispatchBackInStockResult = {
    pending: 0,
    attempted: 0,
    delivered: 0,
    failed: 0,
  };
  try {
    const db = drizzle(getDbPool());
    const max = Math.max(1, Math.min(input.maxFanout ?? 200, 500));
    // Atomic claim: stamp notified_at on up to `max` pending rows for
    // this product in a single UPDATE … RETURNING, using
    // FOR UPDATE SKIP LOCKED on the inner SELECT so two concurrent
    // dispatches (e.g. two admins saving stock at the same time)
    // each take a disjoint slice of the queue and never double-email.
    // The tradeoff: if the process crashes after claim but before
    // SendGrid succeeds, the row stays stamped with delivered=false
    // and ops sees it via delivery_error / delivered=false rather
    // than a duplicate retry. We deliberately prefer "missed once"
    // over "re-emailed every restock" — the patient can re-sign up
    // on their next visit; the inverse failure mode is spam.
    const claimed = (await db.execute(sql`
      UPDATE ${resupplySchema}.shop_back_in_stock_notifications
      SET notified_at = now(), delivered = false, delivery_error = NULL
      WHERE id IN (
        SELECT id FROM ${resupplySchema}.shop_back_in_stock_notifications
        WHERE product_id = ${input.productId} AND notified_at IS NULL
        ORDER BY created_at
        LIMIT ${max}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, email
    `)) as unknown as { rows: Array<{ id: string; email: string }> };
    const claimedRows = Array.isArray(claimed.rows) ? claimed.rows : [];
    result.pending = claimedRows.length;
    if (claimedRows.length === 0) return result;

    for (const row of claimedRows) {
      result.attempted += 1;
      const payload: BackInStockEmailPayload = {
        email: row.email,
        productId: input.productId,
        productName: input.productName,
        productImageUrl: input.productImageUrl ?? null,
        productUrl: input.productUrl,
        priceLabel: input.priceLabel ?? null,
      };
      const send = await sendBackInStockEmail(payload);
      try {
        await db
          .update(shopBackInStockNotifications)
          .set({
            delivered: send.delivered,
            deliveryError: send.error ?? null,
          })
          .where(eq(shopBackInStockNotifications.id, row.id));
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            id: row.id,
          },
          "back-in-stock-record: delivery flag stamp failed",
        );
      }
      if (send.delivered) result.delivered += 1;
      else result.failed += 1;
    }
    logger.info(
      {
        productId: input.productId,
        pending: result.pending,
        delivered: result.delivered,
        failed: result.failed,
      },
      "back-in-stock-record: dispatch complete",
    );
    return result;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        productId: input.productId,
      },
      "back-in-stock-record: dispatch failed",
    );
    return result;
  }
}

/** Counts of pending signups for a product. Used by the PDP to render
 *  social-proof copy ("12 others are waiting") if we ever want it. Not
 *  wired in v1 but keeps the DB-access layer in one place. */
export async function countPendingBackInStock(
  productId: string,
): Promise<number> {
  try {
    const db = drizzle(getDbPool());
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(shopBackInStockNotifications)
      .where(
        and(
          eq(shopBackInStockNotifications.productId, productId),
          isNull(shopBackInStockNotifications.notifiedAt),
        ),
      );
    return rows[0]?.count ?? 0;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        productId,
      },
      "back-in-stock-record: count failed",
    );
    return 0;
  }
}
