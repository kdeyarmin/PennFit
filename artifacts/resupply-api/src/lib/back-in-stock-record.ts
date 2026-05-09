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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

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
    const supabase = getSupabaseServiceRoleClient();
    // The original Drizzle path used ON CONFLICT (product_id, email)
    // WHERE notified_at IS NULL DO NOTHING against a partial unique
    // index. PostgREST has no `DO NOTHING WHERE`, so we INSERT and
    // catch the 23505 unique-violation as the "duplicate" branch.
    const { data: inserted, error } = await supabase
      .schema("resupply")
      .from("shop_back_in_stock_notifications")
      .insert({
        product_id: input.productId,
        email: input.email,
        submitter_ip: input.submitterIp,
        user_agent: input.userAgent,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        // Partial unique on (product_id, email) WHERE notified_at IS
        // NULL fired — caller-visible "we have you on the list"
        // messaging is identical to the inserted branch.
        return { status: "duplicate" };
      }
      throw error;
    }
    return {
      status: inserted ? "inserted" : "duplicate",
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
 *
 * Concurrency posture: the original Drizzle path used a single SQL
 * `WITH … FOR UPDATE SKIP LOCKED` claim so two concurrent dispatches
 * (two admins saving stock at the same time) each took a disjoint
 * slice of the queue and never double-emailed. PostgREST has no
 * SKIP LOCKED, so we approximate with SELECT-then-UPDATE-with-null-
 * guard. Postgres serialises the UPDATEs; the loser sees zero rows
 * match and simply does no work — correctness preserved, parallel
 * throughput lost. Same posture as the abandoned-cart and review-
 * request dispatchers in artifacts/resupply-api/src/routes/admin/.
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
    const supabase = getSupabaseServiceRoleClient();
    const max = Math.max(1, Math.min(input.maxFanout ?? 200, 500));

    // Step 1 — pick the eligible candidate ids, oldest-first so a
    // backlog drains fairly.
    const { data: candidates, error: candidatesErr } = await supabase
      .schema("resupply")
      .from("shop_back_in_stock_notifications")
      .select("id, email")
      .eq("product_id", input.productId)
      .is("notified_at", null)
      .order("created_at", { ascending: true })
      .limit(max);
    if (candidatesErr) throw candidatesErr;
    const candidateIds = (candidates ?? []).map((c) => c.id);
    if (candidateIds.length === 0) return result;

    // Step 2 — atomic stamp. The .is("notified_at", null) guard
    // makes this idempotent under parallel calls. The tradeoff: if
    // the process crashes after claim but before SendGrid succeeds,
    // the row stays stamped with delivered=false and ops sees it via
    // delivery_error / delivered=false rather than a duplicate retry.
    // We deliberately prefer "missed once" over "re-emailed every
    // restock" — the patient can re-sign up on their next visit; the
    // inverse failure mode is spam.
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("shop_back_in_stock_notifications")
      .update({
        notified_at: nowIso,
        delivered: false,
        delivery_error: null,
      })
      .in("id", candidateIds)
      .is("notified_at", null)
      .select("id, email");
    if (claimErr) throw claimErr;

    const claimedRows = claimed ?? [];
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
      const { error: stampErr } = await supabase
        .schema("resupply")
        .from("shop_back_in_stock_notifications")
        .update({
          delivered: send.delivered,
          delivery_error: send.error ?? null,
        })
        .eq("id", row.id);
      if (stampErr) {
        logger.warn(
          {
            err: stampErr,
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
    const supabase = getSupabaseServiceRoleClient();
    const { count, error } = await supabase
      .schema("resupply")
      .from("shop_back_in_stock_notifications")
      .select("*", { count: "exact", head: true })
      .eq("product_id", productId)
      .is("notified_at", null);
    if (error) throw error;
    return count ?? 0;
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
