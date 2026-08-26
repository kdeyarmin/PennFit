// Shared post-purchase review-request dispatcher.
//
// Extracted from routes/admin/shop/review-requests send-due so the admin
// "Send due" button AND the hourly review-request cron run the IDENTICAL
// atomic-claim + comm-prefs + send loop (same split the cart-abandonment
// dispatcher uses). One source of truth for the suppression rules.
//
// Eligibility: status='paid', paid_at <= now()-14d, review_request_sent_at
// IS NULL, customer_id set; plus the customer's emailReviewRequests pref true
// and not in a DND window. Idempotent: the atomic NULL-guarded stamp means a
// concurrent run (cron + button, or two cron ticks) matches zero rows on the
// loser. Per-tenant gated by storefront.reviews_collection (resolved ONCE per
// org here, so a tenant with reviews off is swept but does no work).
//
// PHI posture: never logs email/PHI — counts + order ids only.

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  getOrgScopedClient,
  type CommunicationPreferences,
  type Database,
} from "@workspace/resupply-db";

import { isInDndWindow } from "../comm-prefs";
import { isFeatureEnabled } from "../feature-flags";
import { sendReviewRequestEmail } from "../messaging/review-request-email";
import { resolveTenantBaseUrl } from "../tenant-branding";

const REVIEW_REQUEST_AGE_DAYS = 14;
const SCAN_LIMIT = 100;

export interface ReviewRequestDispatchStats {
  scanned: number;
  sent: number;
  skippedNoConfig: number;
  skippedFailed: number;
  skippedOptOut: number;
}

type DispatchLogger = {
  warn?: (obj: unknown, msg?: string) => void;
};

const ZERO: ReviewRequestDispatchStats = {
  scanned: 0,
  sent: 0,
  skippedNoConfig: 0,
  skippedFailed: 0,
  skippedOptOut: 0,
};

/**
 * Run one review-request dispatch for a single tenant. No-op (zeros) when
 * the tenant has reviews collection turned off.
 */
export async function runReviewRequestDispatch(opts: {
  orgId: string;
  log?: DispatchLogger;
}): Promise<ReviewRequestDispatchStats> {
  const { orgId, log } = opts;

  // Per-tenant feature gate — resolve once, skip the whole tenant if off.
  if (!(await isFeatureEnabled("storefront.reviews_collection", orgId))) {
    return { ...ZERO };
  }

  const supabase = getOrgScopedClient(orgId);
  const cutoffIso = new Date(
    Date.now() - REVIEW_REQUEST_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  type ShopOrderRow = Database["resupply"]["Tables"]["shop_orders"]["Row"];

  // Step 1 — eligible candidate ids (bounded).
  const { data: candidates, error: candidatesErr } = await supabase
    .from("shop_orders")
    .select("id, customer_id")
    .eq("status", "paid")
    .lte("paid_at", cutoffIso)
    .is("review_request_sent_at", null)
    .not("customer_id", "is", null)
    .order("paid_at", { ascending: true })
    .limit(SCAN_LIMIT);
  if (candidatesErr) throw candidatesErr;

  const candidateIds = ((candidates ?? []) as ShopOrderRow[]).map((r) => r.id);
  if (candidateIds.length === 0) return { ...ZERO };

  // Step 2 — atomic claim (NULL-guarded stamp → idempotent under concurrency).
  const nowIso = new Date().toISOString();
  const { data: claimedRows, error: claimErr } = await supabase
    .from("shop_orders")
    .update({ review_request_sent_at: nowIso })
    .in("id", candidateIds)
    .is("review_request_sent_at", null)
    .select("id, customer_id");
  if (claimErr) throw claimErr;

  const claimed = ((claimedRows ?? []) as ShopOrderRow[]).filter(
    (r): r is ShopOrderRow & { customer_id: string } => r.customer_id !== null,
  );
  if (claimed.length === 0) return { ...ZERO };

  // Batch-fetch comm prefs for every claimed user.
  const userIds = Array.from(new Set(claimed.map((r) => r.customer_id)));
  const { data: customerRows, error: customersErr } = await supabase
    .from("shop_customers")
    .select("customer_id, email_lower, communication_preferences")
    .in("customer_id", userIds);
  if (customersErr) throw customersErr;
  type ShopCustomerRow =
    Database["resupply"]["Tables"]["shop_customers"]["Row"];
  const customerMap = new Map(
    ((customerRows ?? []) as ShopCustomerRow[]).map((r) => [
      r.customer_id,
      {
        email: r.email_lower,
        prefs: {
          ...DEFAULT_COMMUNICATION_PREFERENCES,
          ...((r.communication_preferences as CommunicationPreferences | null) ??
            {}),
        },
      },
    ]),
  );

  // First product per claimed order, for the deep link. One batch query.
  const claimedOrderIds = claimed.map((c) => c.id);
  const { data: itemRows, error: itemsErr } = await supabase
    .from("shop_order_items")
    .select("order_id, product_id")
    .in("order_id", claimedOrderIds);
  if (itemsErr) throw itemsErr;
  type ShopOrderItemRow =
    Database["resupply"]["Tables"]["shop_order_items"]["Row"];
  const firstProductByOrder = new Map<string, string>();
  for (const it of (itemRows ?? []) as ShopOrderItemRow[]) {
    if (!firstProductByOrder.has(it.order_id)) {
      firstProductByOrder.set(it.order_id, it.product_id);
    }
  }

  const stats: ReviewRequestDispatchStats = { ...ZERO };

  const baseUrl = (
    (await resolveTenantBaseUrl(orgId)) ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    "https://cmbreathe.com"
  ).replace(/\/$/, "");

  const unclaim = async (id: string): Promise<void> => {
    const { error: unclaimErr } = await supabase
      .from("shop_orders")
      .update({ review_request_sent_at: null })
      .eq("id", id);
    if (unclaimErr) {
      log?.warn?.(
        { err: unclaimErr, orderId: id },
        "review-request unclaim failed",
      );
    }
  };

  for (const row of claimed) {
    const cust = customerMap.get(row.customer_id);
    const prefs = cust?.prefs ?? { ...DEFAULT_COMMUNICATION_PREFERENCES };
    const email = cust?.email ?? null;

    if (!prefs.emailReviewRequests || isInDndWindow(prefs)) {
      await unclaim(row.id);
      stats.skippedOptOut += 1;
      continue;
    }
    if (!email) {
      await unclaim(row.id);
      stats.skippedFailed += 1;
      continue;
    }
    const productId = firstProductByOrder.get(row.id);
    if (!productId) {
      await unclaim(row.id);
      stats.skippedFailed += 1;
      continue;
    }

    // Cash-pay product pages are gone; send patients to contact so they
    // can leave feedback with a human rather than a 404/redirect loop.
    const productUrl = `${baseUrl}/contact?utm_source=email&utm_medium=transactional&utm_campaign=review_request`;
    const result = await sendReviewRequestEmail({
      to: email,
      productName: "your last order",
      productUrl,
      orgId,
    });

    if (result.sent) {
      stats.sent += 1;
    } else if (result.reason === "email_not_configured") {
      await unclaim(row.id);
      stats.skippedNoConfig += 1;
    } else {
      await unclaim(row.id);
      stats.skippedFailed += 1;
      log?.warn?.(
        { orderId: row.id, reason: result.reason },
        "review-request send failed",
      );
    }
  }

  stats.scanned = claimed.length;
  return stats;
}
