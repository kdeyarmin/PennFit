// /shop/me/returns — customer-facing return / RMA initiation + read.
//
//   POST /shop/me/orders/:sessionId/returns  — start a return.
//   GET  /shop/me/returns                    — list this user's returns.
//   GET  /shop/me/returns/:id                — single-return detail.
//
// Eligibility rules (enforced at POST time):
//   * Caller must own the order (customer_id match).
//   * Order must be `paid`. Pending / expired / refunded orders can't
//     start a return — pending isn't yet a sale, expired never was,
//     refunded is already past the workflow.
//   * Days-since-paidAt must be ≤ COMFORT_GUARANTEE_DAYS (60). The 60
//     days starts at paidAt, NOT at deliveredAt — we don't always have
//     a delivered timestamp (admin enters it; carrier callback is
//     future work) and a too-clever rule would lock customers out
//     when admin forgets. Customers who legitimately need an extension
//     can email support; admins can override server-side.
//   * Phase A.3 — extended from 30 → 60 days to match the industry
//     benchmark (RespShop offers 60, The CPAP Shop offers 75). Patients
//     who try a mask risk-free are dramatically more likely to commit
//     to PennPaps for ongoing reordering.
//   * No other open return exists for the same order_id (the partial
//     index enforces this). Customers with multiple grievances about
//     the same shipment should describe both in one return note.
//
// Privacy: returns reference shop_orders (cash-pay only — no PHI).
// reasonNote is free-form so the API caps it at 1000 characters and
// strips control chars; HTML stripping is unnecessary because the
// admin UI renders as text only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  type ShopReturnReason,
  getOrgScopedClient,
} from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import {
  AUTO_APPROVE_PRIOR_RETURN_CAP,
  evaluateAutoApprovalRules,
  formatAutoApprovalNote,
} from "../../lib/shop-returns/auto-approval-rules";

const router: IRouter = Router();

const COMFORT_GUARANTEE_DAYS = 60;
const MAX_REASON_NOTE_LEN = 1000;

const REASON_VALUES: ShopReturnReason[] = [
  "fit",
  "defective",
  "wrong_item",
  "no_longer_needed",
  "other",
];

const initiateBody = z
  .object({
    reason: z.enum(REASON_VALUES as [ShopReturnReason, ...ShopReturnReason[]]),
    reasonNote: z
      .string()
      .trim()
      .max(MAX_REASON_NOTE_LEN)
      .optional()
      .nullable()
      .transform((v) => {
        if (v === null || v === undefined || v.length === 0) return null;
        // Strip control chars (defense against logged-in nuisance input).
        // eslint-disable-next-line no-control-regex
        return v.replace(/[\x00-\x1f\x7f]/g, " ").trim() || null;
      }),
    preferredResolution: z.enum(["refund", "exchange"]).optional().nullable(),
  })
  .strict();

router.post(
  "/shop/me/orders/:sessionId/returns",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }

    const sessionId = req.params.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }

    const parsed = initiateBody.safeParse(req.body);
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

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: order } = await supabase
      .from("shop_orders")
      .select(
        "id, customer_id, status, paid_at, amount_total_cents, amount_refunded_cents",
      )
      .eq("stripe_session_id", sessionId)
      .limit(1)
      .maybeSingle();

    if (!order || order.customer_id !== customerId) {
      // Generic 404 instead of leaking that the session belongs to a
      // different user — IDOR-style probing should not return 403.
      res.status(404).json({ error: "order_not_found" });
      return;
    }

    if (order.status !== "paid") {
      res.status(409).json({
        error: "order_not_eligible",
        message: `Returns are only available for paid orders (this one is ${order.status}).`,
      });
      return;
    }

    if (!order.paid_at) {
      // Defensive — every paid order has a paidAt, but if a webhook
      // race left it null we shouldn't panic.
      res.status(409).json({
        error: "order_paid_at_missing",
        message:
          "Order is missing a payment timestamp; please contact support.",
      });
      return;
    }

    const ageMs = Date.now() - new Date(order.paid_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays > COMFORT_GUARANTEE_DAYS) {
      res.status(409).json({
        error: "guarantee_window_passed",
        message: `Comfort guarantee is ${COMFORT_GUARANTEE_DAYS} days from payment. This order is ${Math.floor(
          ageDays,
        )} days old; please contact support if you need an exception.`,
        comfortGuaranteeDays: COMFORT_GUARANTEE_DAYS,
        orderAgeDays: Math.floor(ageDays),
      });
      return;
    }

    // Refuse a duplicate request while one is already in flight.
    // The partial index makes the existence check cheap.
    const { data: openRow } = await supabase
      .from("shop_returns")
      .select("id, status")
      .eq("order_id", order.id)
      .eq("customer_id", customerId)
      .in("status", ["requested", "approved", "shipped_back", "received"])
      .limit(1)
      .maybeSingle();
    if (openRow) {
      res.status(409).json({
        error: "open_return_exists",
        message: "You already have a return in progress for this order.",
        returnId: openRow.id,
      });
      return;
    }

    // A4 — auto-approval rule layer.
    //
    // Two narrow patterns auto-approve at insert time
    // (`defective` within 7d, `wrong_item` within 30d); everything
    // else lands in the manual `requested` queue exactly like before.
    // The rule decision is gated on the customer's recent return
    // history — anyone with `AUTO_APPROVE_PRIOR_RETURN_CAP` or more
    // approved returns in the last 90 days falls through to manual
    // review regardless of reason+age.
    const ninetyDaysAgoIso = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    // We only need to know whether the count meets the cap, so a
    // bounded fetch (limit = cap) is cheaper than COUNT(*). Approved
    // and every downstream status count toward the cap; "rejected"
    // and "requested" do NOT.
    const { data: priorRows, error: priorErr } = await supabase
      .from("shop_returns")
      .select("id")
      .eq("customer_id", customerId)
      .in("status", [
        "approved",
        "shipped_back",
        "received",
        "refunded",
        "replaced",
      ])
      .gte("updated_at", ninetyDaysAgoIso)
      .limit(AUTO_APPROVE_PRIOR_RETURN_CAP);
    if (priorErr) throw priorErr;
    // Subtract any cumulative refund already applied (partial
    // refunds via Stripe Dashboard) so the auto-approval rule
    // doesn't double-refund. amount_refunded_cents is bumped by the
    // charge.refunded webhook; for a $500 order with a prior $100
    // partial refund, the effective remaining value is $400 — and
    // an auto-approved full refund would actually issue a $400
    // refund (or whatever the partial-refund logic computes).
    const remainingValueCents = Math.max(
      0,
      (order.amount_total_cents ?? 0) - (order.amount_refunded_cents ?? 0),
    );
    const decision = evaluateAutoApprovalRules({
      reason: parsed.data.reason,
      ageDays,
      priorApprovedReturnsLast90d: priorRows?.length ?? 0,
      // High-value-order guard — never auto-approve on a $500+
      // transaction. Use the post-refund remaining amount so a
      // partial refund doesn't artificially inflate the comparison.
      orderValueCents: remainingValueCents,
    });

    const preferenceNote = parsed.data.preferredResolution
      ? `Customer preferred resolution at request time: ${parsed.data.preferredResolution}.`
      : null;
    const nowIso = new Date().toISOString();
    const autoApprovalNote =
      decision.autoApprove && decision.rule
        ? formatAutoApprovalNote({ rule: decision.rule, nowIso })
        : null;
    // Stack notes in chronological order: rule trace first, then the
    // preference. Either may be null. A single newline separates them.
    const adminNote =
      [autoApprovalNote, preferenceNote].filter(Boolean).join("\n") || null;

    const { data: row, error: insErr } = await supabase
      .from("shop_returns")
      .insert({
        customer_id: customerId,
        order_id: order.id,
        stripe_session_id: sessionId,
        reason: parsed.data.reason,
        reason_note: parsed.data.reasonNote ?? null,
        // When the rule fires, write the row directly into the
        // `approved` state with approved_at stamped. `admin_user_id`
        // stays null — no human signed off, the rule did, and the
        // admin_note carries the rule name for the audit trail.
        ...(decision.autoApprove
          ? { status: "approved" as const, approved_at: nowIso }
          : {}),
        // We persist the customer's preferred resolution as a soft
        // signal in the admin note. We don't write `resolution` yet —
        // that field encodes the FINAL decision, set at refund/exchange
        // time, and writing it eagerly would conflate "what they want"
        // with "what we did". This way the admin sees the preference
        // without it being load-bearing.
        admin_note: adminNote,
      })
      .select("id, status, created_at, approved_at")
      .single();
    if (insErr) throw insErr;

    res.status(201).json({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      // Expose approved_at so the SPA can render the "approved"
      // empty state copy when auto-approval fires.
      approvedAt: row.approved_at,
      // Also surface the rule name so the SPA / admin UI can
      // distinguish auto- vs human-approval if it wants to. Null
      // when manual.
      autoApprovedBy: decision.autoApprove ? decision.rule : null,
    });
  },
);

router.get("/shop/me/returns", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const { data: rows, error } = await supabase
    .from("shop_returns")
    .select(
      "id, order_id, stripe_session_id, status, reason, reason_note, resolution, refund_cents, return_label_url, return_carrier, return_tracking_number, created_at, updated_at, approved_at, rejected_at, received_at, resolved_at, closed_at",
    )
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  res.json({
    returns: (
      (rows ?? []) as Array<
        Database["resupply"]["Tables"]["shop_returns"]["Row"]
      >
    ).map((r) => ({
      id: r.id,
      orderId: r.order_id,
      sessionId: r.stripe_session_id,
      status: r.status,
      reason: r.reason,
      reasonNote: r.reason_note,
      resolution: r.resolution,
      refundCents: r.refund_cents,
      returnLabelUrl: r.return_label_url,
      returnCarrier: r.return_carrier,
      returnTrackingNumber: r.return_tracking_number,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      approvedAt: r.approved_at,
      rejectedAt: r.rejected_at,
      receivedAt: r.received_at,
      resolvedAt: r.resolved_at,
      closedAt: r.closed_at,
    })),
  });
});

export default router;
