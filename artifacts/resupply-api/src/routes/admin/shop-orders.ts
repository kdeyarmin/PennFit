// /admin/shop/orders/* — admin tools for shop-order fulfillment.
//
// Scope of this module:
//   * POST /admin/shop/orders/:orderId/tracking
//       Enter carrier + tracking number; stamps shipped_at=now().
//   * POST /admin/shop/orders/:orderId/delivered
//       Mark a previously-shipped parcel as delivered.
//   * PATCH /admin/shop/orders/:orderId/shipping-address
//       Admin-side address correction (e.g. customer phoned in a typo).
//       Allowed pre-AND-post-shipment because support occasionally
//       fixes the address-of-record after the fact for return labels.
//   * POST /admin/shop/orders/:orderId/refund
//       Issue a Stripe refund (full or partial). The actual status
//       flip to 'refunded' lands via the charge.refunded webhook —
//       this endpoint just kicks off the refund and returns the
//       Stripe Refund object id so the operator gets immediate
//       feedback.
//
// What this module does NOT own:
//   * Customer-facing edits — those live in /shop/me/orders/* and
//     enforce a stricter "shipped_at IS NULL" guard. Admins are
//     trusted to know when a post-ship address tweak is appropriate.
//   * Tracking projection / carrier URL templates — that lives in
//     the customer-facing endpoint. Admins enter the raw fields here.
//
// Authorization:
//   requireAdmin (RESUPPLY_ADMIN_EMAILS allowlist). Each handler
//   re-validates the per-route preconditions (order exists, payment
//   state appropriate) before mutating.
//
// Error contract (consistent across all four endpoints):
//   400 invalid_body / invalid_order_id    — input validation
//   404 order_not_found                    — id matched no row
//   409 order_not_paid                     — status != 'paid'
//   409 order_not_shipped                  — delivered without shipped_at
//   409 order_already_refunded             — refund attempt on refunded
//   409 order_no_payment_intent            — refund attempt with no PI
//   503 stripe_not_configured              — env missing in preview
//   502 stripe_refund_failed               — Stripe error proxied

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type Database,
  type Json,
  type SavedShippingAddress,
} from "@workspace/resupply-db";

type ShopOrderUpdate = Database["resupply"]["Tables"]["shop_orders"]["Update"];

import { logAudit } from "@workspace/resupply-audit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";
import { withMetrics } from "../../lib/observability";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { sendShippingNotificationEmail } from "../../lib/order-emails/send-shipping-notification-email";
import { sendPushToCustomer } from "../../lib/web-push";
import { resolveSmsRecipientForShopOrder } from "../../lib/shop-orders-sms-resolver";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

const router: IRouter = Router();

// Per-admin rate limit on the refund endpoint (B-07). Each call moves
// real money out via Stripe; a compromised admin account abusing the
// endpoint must be capped without affecting other staff. 10/hour
// per-admin covers legitimate dispute / partial-refund workflows
// while bounding blast radius. Keyed by adminUserId (populated by
// requireAdmin, which runs first).
const adminOrderRefundLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "admin_shop_order_refund",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

// ID validation: shop_orders.id is a text column whose values are
// `gen_random_uuid()::text`. Accept the canonical UUID format so a
// stray path param can't be smuggled into the WHERE clause as a
// substring match. (PostgREST parameterises so this is belt-and-
// suspenders defence.)
const ORDER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateOrderId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return ORDER_ID_RE.test(raw) ? raw : null;
}

// Trim + length-cap the tracking inputs. Carrier is a free-form name
// the customer-facing track-link projection maps to a known URL
// template; we only validate that it isn't empty / suspiciously long.
const trackingBodySchema = z.object({
  carrier: z
    .string()
    .trim()
    .min(1, "carrier required")
    .max(50, "carrier too long"),
  number: z
    .string()
    .trim()
    .min(1, "tracking number required")
    .max(100, "tracking number too long"),
});

// Address shape mirrors SavedShippingAddress in shop-customers so the
// existing customer Zod validator + UI form can be reused as-is. We
// re-declare here (rather than importing from a shared shop module)
// because the shape is small and the duplication keeps the admin
// route self-contained — a future address-fields change would touch
// both validators in one PR anyway.
const addressBodySchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z
    .union([z.string().trim().max(200), z.null(), z.undefined()])
    .transform((v) => (v === undefined || v === "" ? null : v)),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(2).max(2),
  postalCode: z.string().trim().min(3).max(20),
  country: z.literal("US"),
});

// Refund body — both fields optional. Omitted amountCents = full
// refund; omitted reason = no reason recorded on the Stripe Refund.
const refundBodySchema = z.object({
  amountCents: z
    .number()
    .int()
    .min(1, "refund amount must be positive")
    .max(1_000_000_000, "refund amount unreasonably large")
    .optional(),
  reason: z
    .enum(["duplicate", "fraudulent", "requested_by_customer"])
    .optional(),
});

interface OrderRow {
  id: string;
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
  status: string;
  amountTotalCents: number | null;
  currency: string | null;
  customerId: string | null;
  createdAt: string;
  paidAt: string | null;
  shippingAddress: SavedShippingAddress | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  shippingEmailSentAt: string | null;
  customerEmail: string | null;
}

const ORDER_COLUMNS =
  "id, stripe_session_id, stripe_payment_intent_id, status, amount_total_cents, currency, customer_id, created_at, paid_at, shipping_address_json, tracking_carrier, tracking_number, shipped_at, delivered_at, shipping_email_sent_at, customer_email";

function rowToOrderRow(row: {
  id: string;
  stripe_session_id: string;
  stripe_payment_intent_id: string | null;
  status: string;
  amount_total_cents: number | null;
  currency: string | null;
  customer_id: string | null;
  created_at: string;
  paid_at: string | null;
  shipping_address_json: Json | null;
  tracking_carrier: string | null;
  tracking_number: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  shipping_email_sent_at: string | null;
  customer_email: string | null;
}): OrderRow {
  return {
    id: row.id,
    stripeSessionId: row.stripe_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    status: row.status,
    amountTotalCents: row.amount_total_cents,
    currency: row.currency,
    customerId: row.customer_id,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    shippingAddress:
      (row.shipping_address_json as SavedShippingAddress | null) ?? null,
    trackingCarrier: row.tracking_carrier,
    trackingNumber: row.tracking_number,
    shippedAt: row.shipped_at,
    deliveredAt: row.delivered_at,
    shippingEmailSentAt: row.shipping_email_sent_at,
    customerEmail: row.customer_email,
  };
}

async function loadOrder(orderId: string): Promise<OrderRow | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToOrderRow(data) : null;
}

/**
 * Send the "your order shipped" email at most once per
 * (carrier, trackingNumber) combination. Called after the tracking
 * UPDATE in the POST /admin/shop/orders/:id/tracking handler.
 *
 * Idempotency model (concurrent-safe):
 *   1. The route's tracking UPDATE both stamps the new tracking AND
 *      conditionally CLEARS `shipping_email_sent_at` in the same
 *      atomic statement, ONLY if carrier or number actually changed
 *      vs the prior row values.
 *   2. This helper then performs an ATOMIC CLAIM on the (possibly
 *      cleared) timestamp:
 *        UPDATE … SET shipping_email_sent_at = now()
 *        WHERE id = $1 AND shipping_email_sent_at IS NULL RETURNING …
 *      Only one worker can win the row even if two admins click
 *      "save tracking" within milliseconds.
 *   3. On send failure we RELEASE the claim
 *      (shipping_email_sent_at = NULL) so the next admin save (or a
 *      manual retry) can re-attempt.
 *
 * Recipient resolution:
 *   * Linked `shop_customers.email_lower` (joined on `customer_id`)
 *     wins. For guest checkouts (customer_id NULL) we fall back to
 *     `shop_orders.customer_email` captured at paid-time (migration
 *     0017). If neither is present, skip silently.
 *
 * Errors NEVER throw — the admin route already 200'd the UPDATE; we
 * must not fail the response because SendGrid is misconfigured.
 */
async function sendShippingNotificationIfNew(args: {
  orderId: string;
  log:
    | {
        info?: (...args: unknown[]) => void;
        warn?: (...args: unknown[]) => void;
      }
    | undefined;
}): Promise<
  { skipped: true; reason: string } | { skipped: false; delivered: boolean }
> {
  const { orderId, log } = args;
  const supabase = getSupabaseServiceRoleClient();

  // Atomic claim — wins iff shipping_email_sent_at is currently NULL.
  // The route's prior UPDATE has either left the timestamp non-null
  // (re-entry of identical tracking → claim fails → skip) or NULL
  // (first send OR genuine re-ship → claim succeeds → send).
  const claimIso = new Date().toISOString();
  const { data: claimedRow, error: claimErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .update({
      shipping_email_sent_at: claimIso,
      updated_at: claimIso,
    })
    .eq("id", orderId)
    .is("shipping_email_sent_at", null)
    .select(
      "id, stripe_session_id, customer_id, shipping_address_json, tracking_carrier, tracking_number, customer_email",
    )
    .limit(1)
    .maybeSingle();
  if (claimErr) throw claimErr;

  if (!claimedRow) {
    log?.info?.(
      { orderId },
      "shipping notification email skipped — already sent or row missing",
    );
    return { skipped: true, reason: "already_sent_or_missing" };
  }

  // From here on, ANY failure path MUST release the claim by writing
  // shipping_email_sent_at = NULL so a future admin re-save can retry.
  // Idempotent: safe to call multiple times. The outer try/catch below
  // guarantees release on ANY thrown error in the post-claim block —
  // including transient DB errors during the customer lookup — so a
  // transient failure can never permanently lock out the email.
  const releaseClaim = async (): Promise<void> => {
    const { error: releaseErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({
        shipping_email_sent_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimedRow.id);
    if (releaseErr) {
      log?.warn?.(
        {
          orderId: claimedRow.id,
          err: releaseErr,
        },
        "shipping notification email claim release failed",
      );
    }
  };

  try {
    if (!claimedRow.tracking_carrier || !claimedRow.tracking_number) {
      // Defence in depth — schema enforces non-empty, but the email
      // body would render nonsense without these.
      await releaseClaim();
      return { skipped: true, reason: "tracking_missing" };
    }

    // Recipient resolution: linked customer → persisted customer_email
    // (captured from Stripe at paid-time) → skip. We never log the
    // recipient string. Also pull caregiver columns so we can fan
    // out a separate caregiver-addressed copy after the primary
    // send succeeds.
    let toEmail: string | null = null;
    let patientFirstName: string | null = null;
    let activeCaregiver: { name: string; email: string } | null = null;
    if (claimedRow.customer_id) {
      const { data: cust, error: custErr } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select(
          "email_lower, display_name, caregiver_name, caregiver_email, caregiver_consent_at, caregiver_revoked_at",
        )
        .eq("customer_id", claimedRow.customer_id)
        .limit(1)
        .maybeSingle();
      if (custErr) throw custErr;
      if (cust?.email_lower) toEmail = cust.email_lower;
      patientFirstName =
        (cust?.display_name ?? "").split(" ")[0]?.trim() || null;
      if (
        cust?.caregiver_email &&
        cust?.caregiver_name &&
        cust?.caregiver_consent_at &&
        !cust?.caregiver_revoked_at
      ) {
        activeCaregiver = {
          name: cust.caregiver_name,
          email: cust.caregiver_email,
        };
      }
    }
    if (!toEmail && claimedRow.customer_email) {
      toEmail = claimedRow.customer_email;
    }
    if (!toEmail) {
      await releaseClaim();
      log?.info?.(
        { orderId: claimedRow.id },
        "shipping notification email skipped — no recipient on file",
      );
      return { skipped: true, reason: "no_email_on_file" };
    }

    const result = await sendShippingNotificationEmail({
      toEmail,
      stripeSessionId: claimedRow.stripe_session_id,
      carrier: claimedRow.tracking_carrier,
      trackingNumber: claimedRow.tracking_number,
      shippingAddress:
        (claimedRow.shipping_address_json as SavedShippingAddress | null) ??
        null,
    });

    if (!result.configured) {
      await releaseClaim();
      log?.info?.(
        { orderId: claimedRow.id },
        "shipping notification email skipped — sendgrid not configured",
      );
      return { skipped: true, reason: "not_configured" };
    }
    if (!result.delivered) {
      await releaseClaim();
      log?.warn?.(
        { orderId: claimedRow.id, error: result.error },
        "shipping notification email send failed (non-fatal, claim released)",
      );
      return { skipped: false, delivered: false };
    }

    log?.info?.(
      { orderId: claimedRow.id, messageId: result.messageId ?? null },
      "shipping notification email delivered",
    );

    // Best-effort push fan-out. Same news, separate channel — runs
    // after the email so a push misconfig can never block delivery
    // of the canonical notification. Logged with structural counts
    // only; the helper itself never logs the payload or endpoint URL.
    if (claimedRow.customer_id) {
      try {
        const counts = await sendPushToCustomer(claimedRow.customer_id, {
          title: "Your PennPaps order shipped",
          body: `${claimedRow.tracking_carrier} · ${claimedRow.tracking_number}`,
          url: `/account/orders`,
          tag: `shop_order_shipped:${claimedRow.id}`,
        });
        if (counts.delivered + counts.expired + counts.transient > 0) {
          log?.info?.(
            { orderId: claimedRow.id, ...counts },
            "shipping notification push fan-out complete",
          );
        }
      } catch (err) {
        // Push failures must not retro-actively change the email
        // outcome. Log and move on.
        log?.warn?.(
          {
            orderId: claimedRow.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "shipping notification push send threw (non-fatal)",
        );
      }
    }

    // SMS leg — fires when the customer's email matches a DME-
    // registered patients row whose phone_e164 is on file AND the
    // shop_customer comm-prefs opted IN to transactional SMS. Runs
    // after the email + push so an SMS misconfig can never roll
    // back the canonical email delivery.
    try {
      const smsRecipient = await resolveSmsRecipientForShopOrder({
        customerId: claimedRow.customer_id,
        customerEmailFromOrder: claimedRow.customer_email ?? null,
      });
      if (smsRecipient) {
        const smsClient = createTwilioSmsClient();
        const greeting = smsRecipient.patientFirstName
          ? `Hi ${smsRecipient.patientFirstName}`
          : "PennPaps";
        await smsClient.sendSms({
          to: smsRecipient.phoneE164,
          body: `${greeting}: your CPAP supplies just shipped (${claimedRow.tracking_carrier} ${claimedRow.tracking_number}). Reply STOP to opt out.`,
        });
        log?.info?.(
          { orderId: claimedRow.id, channel: "sms" },
          "shipping notification sms send complete",
        );
      }
    } catch (smsErr) {
      if (!(smsErr instanceof TwilioConfigError)) {
        log?.warn?.(
          {
            orderId: claimedRow.id,
            err: smsErr instanceof Error ? smsErr.message : String(smsErr),
          },
          "shipping notification sms send threw (non-fatal)",
        );
      }
    }

    // Caregiver-addressed copy. Separate email (not BCC) with copy
    // that correctly addresses the caregiver as the caregiver. Runs
    // after the primary send + push so a caregiver-side failure
    // cannot retro-actively roll back the patient's email outcome.
    if (activeCaregiver) {
      try {
        const { sendCaregiverNotificationEmail } = await import(
          "../../lib/order-emails/send-caregiver-notification-email"
        );
        await sendCaregiverNotificationEmail({
          toEmail: activeCaregiver.email,
          caregiverName: activeCaregiver.name,
          patientFirstName,
          kind: "shipped",
          carrier: claimedRow.tracking_carrier,
          trackingNumber: claimedRow.tracking_number,
        });
      } catch (err) {
        log?.warn?.(
          {
            orderId: claimedRow.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "shipping notification caregiver send threw (non-fatal)",
        );
      }
    }

    return { skipped: false, delivered: true };
  } catch (err) {
    // Catch-all: ANY uncaught error after the claim acquisition
    // (transient DB read failure, unexpected throw inside the email
    // helper, etc.) must release the claim so the next admin re-save
    // can retry — otherwise a single transient failure would
    // permanently suppress the shipping notification.
    await releaseClaim();
    log?.warn?.(
      {
        orderId: claimedRow.id,
        err: err instanceof Error ? err.message : String(err),
      },
      "shipping notification email post-claim threw (non-fatal, claim released)",
    );
    return { skipped: false, delivered: false };
  }
}

function projectOrder(row: OrderRow) {
  return {
    id: row.id,
    sessionId: row.stripeSessionId,
    paymentIntentId: row.stripePaymentIntentId,
    status: row.status,
    amountTotalCents: row.amountTotalCents,
    currency: row.currency,
    customerId: row.customerId,
    // PostgREST returns timestamptz as ISO string already.
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    shippingAddress: row.shippingAddress,
    trackingCarrier: row.trackingCarrier,
    trackingNumber: row.trackingNumber,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
  };
}

// ---------------------------------------------------------------------
// POST /admin/shop/orders/:orderId/tracking
// ---------------------------------------------------------------------
// Sets carrier + number and stamps shipped_at=now() in a single UPDATE.
// We deliberately allow OVERWRITE — re-entering tracking after a
// re-ship is a real workflow (lost parcel, replacement label) and
// blocking it would force admins to use SQL. shipped_at gets re-stamped
// on overwrite, which is the desired semantics ("when did the customer's
// CURRENT parcel ship").
router.post(
  "/admin/shop/orders/:orderId/tracking",
  // Set carrier + tracking number on a shipped order. Operational —
  // `returns.manage` (admin / supervisor / csr / fulfillment / agent).
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const parsed = trackingBodySchema.safeParse(req.body);
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
    const { carrier, number } = parsed.data;

    const existing = await loadOrder(orderId);
    if (!existing) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (existing.status !== "paid") {
      // Tracking on an unpaid (or refunded) order makes no sense and
      // would mislead the customer-facing track link. Surface a clean
      // 409 so the admin UI can render an explainer.
      res.status(409).json({
        error: "order_not_paid",
        currentStatus: existing.status,
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    // Atomicity note: the original Drizzle path used a
    //   `CASE WHEN tracking_carrier IS DISTINCT FROM $new
    //         OR tracking_number IS DISTINCT FROM $new
    //         THEN NULL ELSE shipping_email_sent_at END`
    // expression in the same UPDATE that stamped the new tracking, so
    // shipping_email_sent_at was conditionally cleared in one
    // statement. PostgREST has no SQL CASE — we decide JS-side using
    // the prior row values from `existing` and either include or omit
    // the column from the update. Two admins racing identical re-
    // saves both see existing == new → omit shipping_email_sent_at →
    // no clear → no email re-send.
    const trackingChanged =
      existing.trackingCarrier !== carrier ||
      existing.trackingNumber !== number;
    const nowIso = new Date().toISOString();
    const updatePayload: ShopOrderUpdate = {
      tracking_carrier: carrier,
      tracking_number: number,
      shipped_at: nowIso,
      updated_at: nowIso,
    };
    if (trackingChanged) {
      updatePayload.shipping_email_sent_at = null;
    }
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update(updatePayload)
      .eq("id", orderId)
      .eq("status", "paid")
      .select(ORDER_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      // Race: order was deleted or its status changed between the
      // pre-check and this UPDATE (e.g. a concurrent refund webhook).
      res.status(409).json({ error: "order_not_paid" });
      return;
    }

    req.log?.info?.(
      {
        orderId,
        carrier,
        adminEmail: req.adminEmail,
      },
      "admin/shop/orders: tracking entered",
    );

    // Best-effort shipping notification email. The admin's UPDATE has
    // already succeeded; SendGrid being unconfigured or returning a
    // 5xx must NOT 500 the route — operators would then re-click and
    // we'd land in an inconsistent state where shipped_at is stamped
    // but the email logic re-evaluates against the same row again.
    try {
      await sendShippingNotificationIfNew({
        orderId,
        log: req.log,
      });
    } catch (emailErr) {
      req.log?.warn?.(
        {
          orderId,
          err: emailErr instanceof Error ? emailErr.message : String(emailErr),
        },
        "admin/shop/orders: shipping notification failed (non-fatal)",
      );
    }

    res.json({ order: projectOrder(rowToOrderRow(row)) });
  },
);

// ---------------------------------------------------------------------
// POST /admin/shop/orders/:orderId/delivered
// ---------------------------------------------------------------------
// Stamps delivered_at=now(). Idempotent: re-firing on an already-
// delivered order is a no-op (we keep the original delivered_at so the
// customer-facing "delivered on" date doesn't drift on accidental
// double-clicks).
router.post(
  "/admin/shop/orders/:orderId/delivered",
  // Mark delivered — same operational tier as tracking entry.
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const existing = await loadOrder(orderId);
    if (!existing) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (!existing.shippedAt) {
      res.status(409).json({ error: "order_not_shipped" });
      return;
    }
    if (existing.deliveredAt) {
      // Idempotent — don't bump the timestamp.
      res.json({ order: projectOrder(existing) });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({
        delivered_at: nowIso,
        updated_at: nowIso,
      })
      // Guard idempotency at DB level: if two admins race, the second
      // UPDATE matches 0 rows (delivered_at already set) and we
      // re-read the committed row below instead of double-stamping.
      .eq("id", orderId)
      .is("delivered_at", null)
      .select(ORDER_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      // Either deleted or already delivered by a concurrent request.
      // Re-load to distinguish and return the current state.
      const current = await loadOrder(orderId);
      if (!current) {
        res.status(404).json({ error: "order_not_found" });
        return;
      }
      // Idempotent: already delivered — return current state.
      res.json({ order: projectOrder(current) });
      return;
    }
    req.log?.info?.(
      { orderId, adminEmail: req.adminEmail },
      "admin/shop/orders: marked delivered",
    );
    res.json({ order: projectOrder(rowToOrderRow(row)) });
  },
);

// ---------------------------------------------------------------------
// PATCH /admin/shop/orders/:orderId/shipping-address
// ---------------------------------------------------------------------
// Admin override of the shipping address snapshot. Allowed both pre-
// and post-shipment because:
//   * Pre-shipment: support resolves a typo for the customer.
//   * Post-shipment: address-of-record correction for returns / RMAs.
// The customer-facing edit endpoint enforces shipped_at IS NULL; only
// admins are trusted to edit after the fact (and the audit log
// records who did it via req.adminEmail in the structured log).
router.patch(
  "/admin/shop/orders/:orderId/shipping-address",
  // Address override before ship — operational; reuses returns.manage
  // matrix so the same CSRs who handle returns can fix bad addresses.
  requirePermission("returns.manage"),
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const parsed = addressBodySchema.safeParse(req.body);
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
    const address: SavedShippingAddress = {
      line1: parsed.data.line1,
      line2: parsed.data.line2 ?? null,
      city: parsed.data.city,
      state: parsed.data.state.toUpperCase(),
      postalCode: parsed.data.postalCode,
      country: "US",
    };

    const existing = await loadOrder(orderId);
    if (!existing) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({
        // SavedShippingAddress isn't a Json index-signature shape; cast
        // at the boundary.
        shipping_address_json: address as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
      .select(ORDER_COLUMNS)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    req.log?.info?.(
      {
        orderId,
        adminEmail: req.adminEmail,
        afterShip: existing.shippedAt !== null,
      },
      "admin/shop/orders: shipping address overwritten by admin",
    );
    res.json({ order: projectOrder(rowToOrderRow(row)) });
  },
);

// ---------------------------------------------------------------------
// POST /admin/shop/orders/:orderId/refund
// ---------------------------------------------------------------------
// Kicks off a Stripe refund against the captured payment_intent. We
// DO NOT flip status='refunded' here — that's the webhook
// (charge.refunded) handler's job, which keeps the local mirror
// eventually consistent with Stripe's view of the world. Returning
// the Stripe Refund object id gives the admin UI immediate confirmation
// that the API call succeeded; the status flip (and visible badge)
// follows on the next webhook redelivery (typically <2s).
router.post(
  "/admin/shop/orders/:orderId/refund",
  // Money-out path — tighter gate. `returns.approve` is held by
  // admin / supervisor only, removing csr / fulfillment / agent from
  // direct refund issuance (they can request via the returns RMA
  // lifecycle which goes through the same approve scope). This
  // matches the documented refund-issuance posture in the route
  // file's header comment ("Refund issuance is a supervisor action").
  requirePermission("returns.approve"),
  adminOrderRefundLimiter,
  async (req, res) => {
    const orderId = validateOrderId(req.params.orderId);
    if (!orderId) {
      res.status(400).json({ error: "invalid_order_id" });
      return;
    }
    const parsed = refundBodySchema.safeParse(req.body);
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
    const { amountCents, reason } = parsed.data;

    const existing = await loadOrder(orderId);
    if (!existing) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    if (existing.status === "refunded") {
      res.status(409).json({ error: "order_already_refunded" });
      return;
    }
    if (existing.status !== "paid") {
      res.status(409).json({
        error: "order_not_paid",
        currentStatus: existing.status,
      });
      return;
    }
    if (!existing.stripePaymentIntentId) {
      // No PI captured means the webhook never ran — nothing to refund.
      res.status(409).json({ error: "order_no_payment_intent" });
      return;
    }
    if (
      typeof amountCents === "number" &&
      typeof existing.amountTotalCents === "number" &&
      amountCents > existing.amountTotalCents
    ) {
      res.status(409).json({
        error: "refund_exceeds_amount",
        amountTotalCents: existing.amountTotalCents,
      });
      return;
    }

    const config = readStripeConfigOrNull();
    if (!config) {
      // Preview / dev: refund infrastructure is unreachable. Surface
      // a clean 503 so the admin UI can render an explainer rather
      // than the generic error toast.
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }
    const stripe = getStripeClient(config);

    // Idempotency key scoped to order + amount so:
    //   * double-clicks on the same partial refund return the same
    //     Stripe Refund object without creating a duplicate charge.
    //   * Two different partial refund amounts for the same order
    //     each create a separate Stripe Refund (intentional).
    const idempotencyKey = `refund-${orderId}-${amountCents ?? "full"}`;

    // Capture the narrowed string into a const so the arrow-fn
    // callback below keeps the TS control-flow narrowing the
    // earlier `if (!existing.stripePaymentIntentId)` guard
    // established.
    const paymentIntentId = existing.stripePaymentIntentId;
    let refund;
    try {
      refund = await withMetrics(
        {
          name: "stripe.refunds.create",
          attrs: { surface: "admin_shop_order" },
        },
        () =>
          stripe.refunds.create(
            {
              payment_intent: paymentIntentId,
              ...(typeof amountCents === "number" ? { amount: amountCents } : {}),
              ...(reason ? { reason } : {}),
              metadata: {
                // Records WHO issued the refund directly on the Stripe
                // Refund object; survives even if our local audit log
                // is later purged or queried out of band.
                admin_email: req.adminEmail ?? "unknown",
                shop_order_id: orderId,
              },
            },
            // Per-order + per-amount idempotency key: if two admins click
            // "Refund" before the charge.refunded webhook flips status, Stripe
            // deduplicates and returns the same Refund object rather than
            // issuing a second refund.  Amount is included so different partial
            // refund amounts on the same order each create a separate Stripe
            // Refund (intentional).
            { idempotencyKey },
          ),
      );
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        {
          orderId,
          err: err instanceof Error ? err.message : String(err),
        },
        "admin/shop/orders: stripe refund failed",
      );
      res
        .status(status >= 400 && status < 600 ? status : 502)
        .json({ error: "stripe_refund_failed" });
      return;
    }

    req.log?.info?.(
      {
        orderId,
        refundId: refund.id,
        amountCents: refund.amount,
        adminEmail: req.adminEmail,
      },
      "admin/shop/orders: refund issued",
    );

    void logAudit({
      action: "shop_order.refund.issued",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "shop_orders",
      targetId: orderId,
      metadata: {
        order_id: orderId,
        refund_id: refund.id,
        refund_amount_cents: refund.amount,
        refund_status: refund.status,
        is_partial: typeof amountCents === "number",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      req.log?.warn?.({ err }, "shop_order.refund.issued audit write failed");
    });

    res.json({
      refund: {
        id: refund.id,
        amountCents: refund.amount,
        status: refund.status,
      },
      // Note: `order.status` here is still the pre-refund value.
      // The webhook will flip it to 'refunded' moments later.
      order: projectOrder(existing),
    });
  },
);

export default router;
