// /admin/shop/returns — admin-side moderation + processing of customer
// return / RMA requests.
//
// Endpoints (all requireAdmin-gated):
//   GET   /admin/shop/returns?status=&cursor=&limit=  — paginated queue.
//   GET   /admin/shop/returns/:id                     — single return detail.
//   POST  /admin/shop/returns/:id/approve             — issue label window
//                                                       (requested → approved).
//   POST  /admin/shop/returns/:id/reject              — close as rejected.
//   POST  /admin/shop/returns/:id/mark-shipped        — customer dropped at
//                                                       carrier (approved →
//                                                       shipped_back).
//   POST  /admin/shop/returns/:id/mark-received       — parcel landed at
//                                                       warehouse (shipped_back
//                                                       → received).
//   POST  /admin/shop/returns/:id/refund              — issue Stripe Refund;
//                                                       received → refunded.
//   POST  /admin/shop/returns/:id/replace             — record replacement
//                                                       order; received →
//                                                       replaced.
//   POST  /admin/shop/returns/:id/note                — append admin note.
//
// Lifecycle is a strict forward state machine — every transition
// asserts the from-state and 409s on mismatch. This makes
// double-clicks and admin race conditions safe instead of
// silently advancing the workflow twice.
//
// Stripe Refund execution is BEHIND a feature flag (STRIPE_SECRET_KEY
// presence). In preview / test environments without the key the
// /refund endpoint records the resolution metadata but does NOT call
// Stripe — the admin sees the row flip to `refunded` with a
// `stripeRefundId: null` so they know to issue the refund manually.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type Database,
  type ShopReturnStatus,
} from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";
import { withMetrics } from "../../lib/observability";
import { parseCompositeCursor, isUuidCursorId } from "../../lib/cursor";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { sendReturnStatusEmail } from "../../lib/shop-returns/send-return-status-email";
import { logger } from "../../lib/logger";

type ShopReturnRow = Database["resupply"]["Tables"]["shop_returns"]["Row"];

const router: IRouter = Router();

/**
 * z.string().url() accepts javascript:, data:, file:, vbscript: and
 * arbitrary custom protocols. returnLabelUrl renders on the patient-
 * facing "My returns" page; a compromised / low-trust admin who
 * could stage a javascript: URL here would land stored XSS on every
 * patient who clicks "Print return label" — same-origin, same
 * session cookie. Restrict to http(s).
 */
function httpUrl() {
  return z
    .string()
    .trim()
    .url()
    .refine(
      (u) => /^https?:\/\//i.test(u),
      "URL must use http or https protocol",
    );
}

// Per-admin rate limits on return-lifecycle mutations (B-07). Two
// buckets keyed by adminUserId:
//   * adminReturnFinancialLimiter — 10/hour. Refund + replace move
//     real money / inventory. Tighter cap to bound a compromised
//     account.
//   * adminReturnLifecycleLimiter — 60/hour. approve/reject/mark-
//     shipped/mark-received are state-machine transitions with no
//     direct money movement, but still deserve a per-actor cap so a
//     scripted abuser can't churn the queue.
const adminReturnFinancialLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "admin_shop_return_financial",
  keyFn: (req) => req.adminUserId ?? "unknown",
});
const adminReturnLifecycleLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: "admin_shop_return_lifecycle",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const STATUS_VALUES: ShopReturnStatus[] = [
  "requested",
  "approved",
  "rejected",
  "shipped_back",
  "received",
  "refunded",
  "replaced",
  "closed",
];
const STATUS_FILTER = new Set<string>([...STATUS_VALUES, "all", "open"]);

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

const RETURN_COLUMNS =
  "id, customer_id, order_id, stripe_session_id, status, reason, reason_note, resolution, refund_cents, stripe_refund_id, exchange_product_id, exchange_price_id, exchange_order_id, return_label_url, return_carrier, return_tracking_number, admin_note, admin_user_id, refund_failure_count, refund_last_failure_at, refund_last_failure_reason, created_at, updated_at, approved_at, rejected_at, shipped_back_at, received_at, resolved_at, closed_at";

/**
 * Stripe-error tracking on the /refund endpoint.
 *
 * The refund handler returns 502 + leaves the row at `received` so
 * an admin can retry, but without per-row tracking nothing surfaced
 * the fact that the SAME row had failed N times. Three columns
 * (migration 0159) record:
 *   - refund_failure_count        — increments on each Stripe error
 *   - refund_last_failure_at      — timestamp of last failure
 *   - refund_last_failure_reason  — sanitized short error tag
 *
 * `REFUND_FAILURE_ESCALATION_THRESHOLD` is the count at which the
 * handler emits a structured `WARN event=shop_return_refund_stuck`
 * line so ops can be paged. Set to 3 — single transient failures
 * are routine (Stripe occasionally 503s); two-in-a-row is bad luck;
 * three is "something is genuinely wrong with this row, stop
 * retrying and look at it."
 */
const REFUND_FAILURE_ESCALATION_THRESHOLD = 3;
const REFUND_LAST_FAILURE_REASON_MAX = 240;

function sanitizeStripeFailureReason(err: unknown): string {
  // Stripe SDK errors carry a `code` (machine-readable, e.g.
  // "card_declined", "charge_already_refunded") and a `message`.
  // The `code` is the queryable signal; we lead with it. The
  // message is appended for context but capped so a long body
  // can't bloat the row.
  const errObj =
    err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const code = typeof errObj?.code === "string" ? errObj.code : null;
  const message = err instanceof Error ? err.message : String(err);
  const composed = code ? `${code}: ${message}` : message;
  return composed.length > REFUND_LAST_FAILURE_REASON_MAX
    ? composed.slice(0, REFUND_LAST_FAILURE_REASON_MAX - 1) + "…"
    : composed;
}

/**
 * Best-effort customer-email lookup. Prefer the linked
 * shop_customers.email_lower; fall back to shop_orders.customer_email
 * (captured at paid-time for guest checkouts). Returns null when
 * neither is available — caller should skip the email send rather
 * than fail the lifecycle transition.
 *
 * Errors THROW rather than degrading to null — a transient DB blip
 * that quietly turned into "no recipient" would silently drop the
 * notification AND hide the underlying failure. The caller is the
 * fire-and-forget IIFE in the route, so a thrown error lands in its
 * catch and is logged structurally without blocking the response.
 */
async function resolveCustomerEmailForReturn(
  customerId: string | null,
  orderId: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  if (customerId) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("email_lower")
      .eq("customer_id", customerId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.email_lower) return data.email_lower;
  }
  const { data: order, error: orderError } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("customer_email")
    .eq("id", orderId)
    .limit(1)
    .maybeSingle();
  if (orderError) throw orderError;
  return order?.customer_email ?? null;
}

router.get(
  "/admin/shop/returns",
  requirePermission("returns.read"),
  async (req, res) => {
  const status = String(req.query.status ?? "open");
  if (!STATUS_FILTER.has(status)) {
    res.status(400).json({ error: "invalid_status" });
    return;
  }
  const limit = Math.min(
    Math.max(1, Number(req.query.limit ?? PAGE_SIZE_DEFAULT)),
    PAGE_SIZE_MAX,
  );
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const supabase = getSupabaseServiceRoleClient();

  // Cursor format: "<ISO timestamp>__<id>" (composite — same pattern as
  // shop-reviews so paginating across rows that share createdAt is
  // stable). shop_returns.id is a UUID; reject anything else so a
  // hostile cursor can't smuggle PostgREST structural characters
  // (`,`, `(`, `)`) into the `.or()` expression below.
  //
  // Any non-null cursor that fails to match the expected shape (missing
  // delimiter, unparseable timestamp, non-UUID id) returns 400 rather
  // than silently falling back to the first page — that matches the
  // behavior of the other composite-cursor list endpoints and makes
  // tampered cursors fail loudly.
  const parsed = parseCompositeCursor(cursor ?? undefined);
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }
  if (parsed.id !== null && !isUuidCursorId(parsed.id)) {
    res.status(400).json({ error: "invalid_cursor" });
    return;
  }
  const cursorTs = parsed.date;
  const cursorId = parsed.id;

  let listQuery = supabase
    .schema("resupply")
    .from("shop_returns")
    .select(RETURN_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (status === "open") {
    listQuery = listQuery.in("status", [
      "requested",
      "approved",
      "shipped_back",
      "received",
    ]);
  } else if (status !== "all") {
    listQuery = listQuery.eq("status", status);
  }
  if (cursorTs && cursorId) {
    const cursorIso = cursorTs.toISOString();
    listQuery = listQuery.or(
      `created_at.lt.${cursorIso},and(created_at.eq.${cursorIso},id.lt.${cursorId})`,
    );
  }
  const { data: rows, error } = await listQuery;
  if (error) throw error;

  const all = rows ?? [];
  const hasMore = all.length > limit;
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? `${last.created_at}__${last.id}` : null;

  res.json({
    returns: page.map(serializeReturnRow),
    nextCursor,
  });
});

router.get(
  "/admin/shop/returns/:id",
  requirePermission("returns.read"),
  async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .select(RETURN_COLUMNS)
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    res.status(404).json({ error: "return_not_found" });
    return;
  }
  res.json({ return: serializeReturnRow(row) });
});

const approveBody = z
  .object({
    note: z.string().trim().max(2000).optional().nullable(),
    returnLabelUrl: httpUrl().optional().nullable(),
    returnCarrier: z.string().trim().max(40).optional().nullable(),
    returnTrackingNumber: z.string().trim().max(100).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/shop/returns/:id/approve",
  // RBAC Phase A: approve is a supervisor-and-up gate. CSRs can
  // VIEW the queue (returns.read) but cannot grant the refund or
  // exchange window. `requirePermission` chains requireAdmin
  // internally, so the previous behavior (401 if no session) is
  // preserved.
  requirePermission("returns.approve"),
  adminReturnLifecycleLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = approveBody.safeParse(req.body ?? {});
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
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "approved",
        approved_at: nowIso,
        updated_at: nowIso,
        admin_user_id: adminId,
        admin_note: appendNote(parsed.data.note, adminId, "Approved"),
        return_label_url: parsed.data.returnLabelUrl ?? null,
        return_carrier: parsed.data.returnCarrier ?? null,
        return_tracking_number: parsed.data.returnTrackingNumber ?? null,
      })
      .eq("id", id)
      .eq("status", "requested")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_requested_state" });
      return;
    }
    // Fire-and-forget customer email so the patient learns the return
    // is approved (with carrier/tracking/label) without having to log
    // into /account. The send NEVER blocks the response — a SendGrid
    // failure can't roll back a state transition that already
    // committed.
    void (async () => {
      const toEmail = await resolveCustomerEmailForReturn(
        updated.customer_id,
        updated.order_id,
      );
      if (!toEmail) {
        logger.info(
          { returnId: updated.id, kind: "approved" },
          "shop-return status email skipped — no recipient",
        );
        return;
      }
      const result = await sendReturnStatusEmail({
        kind: "approved",
        toEmail,
        returnId: updated.id,
        stripeSessionId: updated.stripe_session_id ?? "",
        returnCarrier: updated.return_carrier,
        returnTrackingNumber: updated.return_tracking_number,
        returnLabelUrl: updated.return_label_url,
      });
      if (!result.delivered) {
        // `errorCode` is the machine-readable token returned by
        // sendReturnStatusEmail (e.g. "sendgrid_api_error_500"); we
        // intentionally don't surface raw vendor text here. Logged
        // under a non-`err` key so the logger redaction layer
        // (which targets err.message/.stack) doesn't think this is
        // an unfiltered exception payload.
        logger.warn(
          {
            returnId: updated.id,
            kind: "approved",
            configured: result.configured,
            errorCode: result.error,
          },
          "shop-return approved email did not deliver",
        );
      }
    })().catch((err) => {
      // The fire-and-forget IIFE is supposed to swallow errors via
      // the sendReturnStatusEmail contract. If anything still escapes,
      // log the error NAME only — the message may contain DB row
      // text or partner payloads that we treat as world-readable
      // hostile.
      logger.warn(
        {
          returnId: updated.id,
          kind: "approved",
          errorName: err instanceof Error ? err.name : "non_error_thrown",
        },
        "shop-return approved email threw unexpectedly",
      );
    });
    res.json({ return: serializeReturnRow(updated) });
  },
);

const noteOnly = z
  .object({ note: z.string().trim().max(2000).optional().nullable() })
  .strict();

router.post(
  "/admin/shop/returns/:id/reject",
  requirePermission("returns.manage"),
  adminReturnLifecycleLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = noteOnly.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "rejected",
        rejected_at: nowIso,
        closed_at: nowIso,
        updated_at: nowIso,
        admin_user_id: adminId,
        admin_note: appendNote(parsed.data.note, adminId, "Rejected"),
      })
      .eq("id", id)
      .eq("status", "requested")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_requested_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

router.post(
  "/admin/shop/returns/:id/mark-shipped",
  requirePermission("returns.manage"),
  adminReturnLifecycleLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = noteOnly.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "shipped_back",
        shipped_back_at: nowIso,
        updated_at: nowIso,
        admin_user_id: adminId,
        admin_note: appendNote(parsed.data.note, adminId, "Marked shipped back"),
      })
      .eq("id", id)
      .eq("status", "approved")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_approved_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

router.post(
  "/admin/shop/returns/:id/mark-received",
  requirePermission("returns.manage"),
  adminReturnLifecycleLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = noteOnly.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    // Allow received from either shipped_back (normal flow) or
    // approved (admin received before flipping shipped_back —
    // happens when ops scans the inbound parcel without first
    // marking it dispatched).
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "received",
        received_at: nowIso,
        updated_at: nowIso,
        admin_user_id: adminId,
        admin_note: appendNote(parsed.data.note, adminId, "Marked received"),
      })
      .eq("id", id)
      .in("status", ["shipped_back", "approved"])
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_shipped_or_approved_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

const refundBody = z
  .object({
    amountCents: z.number().int().positive().optional(),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/shop/returns/:id/refund",
  // Money-out path — mirror the shop_orders refund gate so a CSR
  // can't issue a Stripe refund directly via the returns lifecycle
  // when they couldn't issue one against the order itself. The
  // /approve endpoint above already documents the supervisor-and-up
  // posture; refund is the same money-out decision and gets the
  // same `returns.approve` gate.
  requirePermission("returns.approve"),
  adminReturnFinancialLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = refundBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: ret, error: lookupErr } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .select(RETURN_COLUMNS)
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!ret) {
      res.status(404).json({ error: "return_not_found" });
      return;
    }
    if (ret.status !== "received") {
      res.status(409).json({ error: "not_in_received_state" });
      return;
    }

    // Look up the order to grab the payment intent ID for Stripe.
    const { data: orderRow, error: orderErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("stripe_payment_intent_id, amount_total_cents")
      .eq("id", ret.order_id)
      .limit(1)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!orderRow) {
      res.status(409).json({ error: "order_not_found" });
      return;
    }

    const refundCents =
      parsed.data.amountCents ?? orderRow.amount_total_cents ?? 0;
    if (!refundCents || refundCents <= 0) {
      res.status(400).json({ error: "missing_refund_amount" });
      return;
    }
    // Cap the refund at the order total, mirroring the shop_orders
    // refund gate (shop-orders.ts: "refund_exceeds_amount"). This
    // money-out path previously had no upper bound, so an explicit
    // oversized `amountCents` was sent straight to Stripe and only
    // bounced there (surfaced as a 502). A clean 409 keeps the refund
    // honest before we ever touch the payment processor.
    if (
      typeof orderRow.amount_total_cents === "number" &&
      refundCents > orderRow.amount_total_cents
    ) {
      res.status(409).json({
        error: "refund_exceeds_amount",
        amountTotalCents: orderRow.amount_total_cents,
      });
      return;
    }

    let stripeRefundId: string | null = null;
    const stripeConfig = readStripeConfigOrNull(process.env);
    const stripe = stripeConfig ? getStripeClient(stripeConfig) : null;
    if (stripe && orderRow.stripe_payment_intent_id) {
      try {
        // Per-return + per-amount idempotency key. Two admins clicking
        // "Refund" on the same return for the same amount collapse to a
        // single Stripe Refund object. Different partial-refund amounts
        // on the same return each create a separate Refund — that's
        // intentional (partial refunds may legitimately stack). Mirrors
        // the shop_orders refund pattern (sprint 5, e98a0bf).
        const idempotencyKey = `shop-return-refund-${ret.id}-${refundCents}`;
        // Capture the narrowed string into a const so the arrow-fn
        // callback below keeps the TS control-flow narrowing from the
        // outer `if (stripe && orderRow.stripe_payment_intent_id)`.
        const paymentIntentId = orderRow.stripe_payment_intent_id;
        const refund = await withMetrics(
          {
            name: "stripe.refunds.create",
            attrs: { surface: "admin_shop_return" },
          },
          () =>
            stripe.refunds.create(
              {
                payment_intent: paymentIntentId,
                amount: refundCents,
                reason: "requested_by_customer",
                metadata: {
                  shop_return_id: ret.id,
                  shop_order_id: ret.order_id,
                },
              },
              { idempotencyKey },
            ),
        );
        stripeRefundId = refund.id;
      } catch (err) {
        // Don't block the workflow on a Stripe-side error — log it and
        // let the admin retry. We keep status at `received` so the
        // operator can re-issue. Increment the per-row failure
        // counter (migration 0159) so the admin UI can show
        // "Refund failed N times" without a separate query, and so
        // a stuck row can be escalated past the human queue.
        const reason = sanitizeStripeFailureReason(err);
        const nowIso = new Date().toISOString();
        const nextCount = (ret.refund_failure_count ?? 0) + 1;
        const { error: stampErr } = await supabase
          .schema("resupply")
          .from("shop_returns")
          .update({
            refund_failure_count: nextCount,
            refund_last_failure_at: nowIso,
            refund_last_failure_reason: reason,
            updated_at: nowIso,
          })
          .eq("id", ret.id);
        if (stampErr) {
          // Best-effort — the lifecycle decision is unchanged
          // either way. Log so ops can spot a tracking-table
          // outage if it ever happens.
          req.log?.warn(
            { returnId: ret.id, code: stampErr.code },
            "shop-return refund: failure-counter update failed",
          );
        }
        if (nextCount >= REFUND_FAILURE_ESCALATION_THRESHOLD) {
          req.log?.warn(
            {
              event: "shop_return_refund_stuck",
              returnId: ret.id,
              orderId: ret.order_id,
              failureCount: nextCount,
              reasonCode: reason.split(":")[0]?.trim() ?? "unknown",
            },
            "shop-return refund has failed repeatedly — investigate",
          );
        }
        req.log?.warn(
          {
            returnId: ret.id,
            failureCount: nextCount,
            reasonCode: reason.split(":")[0]?.trim() ?? "unknown",
          },
          "stripe refund failed",
        );
        res.status(502).json({
          error: "stripe_refund_failed",
          // Surface the count so the admin UI can render
          // "Refund failed N times — escalate?" without
          // refetching the row.
          failureCount: nextCount,
          // Caller-facing message uses the sanitised reason
          // (the same value persisted on the row); the verbose
          // Stripe stack stays out of the response body so we
          // don't accidentally surface a payment-intent id or
          // similar identifier the customer shouldn't see when
          // a screenshot lands in a support ticket.
          message: reason,
        });
        return;
      }
    }

    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "refunded",
        resolution: "refund",
        resolved_at: nowIso,
        closed_at: nowIso,
        updated_at: nowIso,
        refund_cents: refundCents,
        stripe_refund_id: stripeRefundId,
        admin_user_id: adminId,
        admin_note: appendNote(
          parsed.data.note,
          adminId,
          stripeRefundId
            ? `Refunded ${formatCents(refundCents)} via Stripe (${stripeRefundId})`
            : `Refund of ${formatCents(refundCents)} recorded; issue manually in Stripe (no SDK key configured).`,
        ),
      })
      .eq("id", ret.id)
      .eq("status", "received")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;
    if (!updated) {
      res.status(409).json({ error: "not_in_received_state" });
      return;
    }
    // Fire-and-forget refund-issued email. Same posture as the
    // approve handler above — never blocks the response.
    void (async () => {
      const toEmail = await resolveCustomerEmailForReturn(
        updated.customer_id,
        updated.order_id,
      );
      if (!toEmail) {
        logger.info(
          { returnId: updated.id, kind: "refunded" },
          "shop-return status email skipped — no recipient",
        );
        return;
      }
      const result = await sendReturnStatusEmail({
        kind: "refunded",
        toEmail,
        returnId: updated.id,
        stripeSessionId: updated.stripe_session_id ?? "",
        refundCents: updated.refund_cents,
        // currency is not on the return row; pull it from the order
        // when we need precise rendering. shop_orders carries it; if
        // unavailable, the helper defaults to "usd" which matches v1.
        currency: null,
      });
      if (!result.delivered) {
        // See approve handler — `errorCode` (not `err`) so the
        // logger's err-targeted redaction doesn't think this is an
        // unfiltered exception payload, and the value is the
        // machine-readable token from sendReturnStatusEmail.
        logger.warn(
          {
            returnId: updated.id,
            kind: "refunded",
            configured: result.configured,
            errorCode: result.error,
          },
          "shop-return refunded email did not deliver",
        );
      }
    })().catch((err) => {
      // Error NAME only — see approve handler for the rationale.
      logger.warn(
        {
          returnId: updated.id,
          kind: "refunded",
          errorName: err instanceof Error ? err.name : "non_error_thrown",
        },
        "shop-return refunded email threw unexpectedly",
      );
    });
    res.json({ return: serializeReturnRow(updated) });
  },
);

const replaceBody = z
  .object({
    // Stripe product/price/order ids are short fixed-format strings
    // (`prod_<...>`, `price_<...>`, etc., 14-30 chars). Cap at 100 to
    // match the project-wide convention of bounding every Zod string
    // that lands in the DB.
    exchangeProductId: z.string().min(1).max(100),
    exchangePriceId: z.string().min(1).max(100),
    exchangeOrderId: z.string().min(1).max(100).optional().nullable(),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

router.post(
  "/admin/shop/returns/:id/replace",
  requirePermission("returns.manage"),
  adminReturnFinancialLimiter,
  async (req, res) => {
    const id = req.params.id;
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "missing_id" });
      return;
    }
    const parsed = replaceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adminId = req.adminUserId ?? null;
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("shop_returns")
      .update({
        status: "replaced",
        resolution: "exchange",
        resolved_at: nowIso,
        closed_at: nowIso,
        updated_at: nowIso,
        exchange_product_id: parsed.data.exchangeProductId,
        exchange_price_id: parsed.data.exchangePriceId,
        exchange_order_id: parsed.data.exchangeOrderId ?? null,
        admin_user_id: adminId,
        admin_note: appendNote(
          parsed.data.note,
          adminId,
          `Replacement issued (${parsed.data.exchangeProductId})`,
        ),
      })
      .eq("id", id)
      .eq("status", "received")
      .select(RETURN_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      res.status(409).json({ error: "not_in_received_state" });
      return;
    }
    res.json({ return: serializeReturnRow(updated) });
  },
);

router.post(
  "/admin/shop/returns/:id/note",
  requirePermission("returns.manage"),
  async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  const parsed = noteOnly.safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.note) {
    res.status(400).json({ error: "missing_note" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const adminId = req.adminUserId ?? null;
  const { data: ret, error: lookupErr } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .select(RETURN_COLUMNS)
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!ret) {
    res.status(404).json({ error: "return_not_found" });
    return;
  }
  const { data: updated, error: updateErr } = await supabase
    .schema("resupply")
    .from("shop_returns")
    .update({
      admin_note: appendNote(
        parsed.data.note,
        adminId,
        "Note added",
        ret.admin_note,
      ),
      admin_user_id: adminId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(RETURN_COLUMNS)
    .limit(1)
    .maybeSingle();
  if (updateErr) throw updateErr;
  if (!updated) {
    res.status(404).json({ error: "return_not_found" });
    return;
  }
  res.json({ return: serializeReturnRow(updated) });
});

function appendNote(
  newText: string | null | undefined,
  adminId: string | null,
  action: string,
  prior?: string | null,
): string {
  // Newest-first concatenation; capped at 8KB to bound the column.
  const stamp = new Date().toISOString();
  const head = `[${stamp}] ${adminId ?? "admin"} — ${action}${
    newText ? `: ${newText}` : ""
  }`;
  const combined = prior ? `${head}\n\n${prior}` : head;
  return combined.length > 8000 ? combined.slice(0, 8000) : combined;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function serializeReturnRow(r: ShopReturnRow) {
  return {
    id: r.id,
    customerId: r.customer_id,
    orderId: r.order_id,
    sessionId: r.stripe_session_id,
    status: r.status,
    reason: r.reason,
    reasonNote: r.reason_note,
    resolution: r.resolution,
    refundCents: r.refund_cents,
    stripeRefundId: r.stripe_refund_id,
    exchangeProductId: r.exchange_product_id,
    exchangePriceId: r.exchange_price_id,
    exchangeOrderId: r.exchange_order_id,
    returnLabelUrl: r.return_label_url,
    returnCarrier: r.return_carrier,
    returnTrackingNumber: r.return_tracking_number,
    adminNote: r.admin_note,
    adminUserId: r.admin_user_id,
    // PostgREST returns timestamptz as ISO string already.
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedAt: r.approved_at,
    rejectedAt: r.rejected_at,
    shippedBackAt: r.shipped_back_at,
    receivedAt: r.received_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
  };
}

export default router;
