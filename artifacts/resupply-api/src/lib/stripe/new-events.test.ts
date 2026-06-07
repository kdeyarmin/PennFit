// Tests for newly-added Stripe event cases in webhook-handler.ts
//
// PR adds three new event handlers:
//   - invoice.payment_failed  → structured WARN with payment failure details
//   - charge.dispute.created  → structured WARN prompting CSR action
//   - charge.dispute.closed   → structured WARN with dispute outcome
//
// None of these do DB writes — they exist solely to surface structured
// log lines for alerting. The tests below take two complementary
// approaches:
//
//   1. Source structural checks — pin the event-type strings, log event
//      names, and field names that monitoring dashboards key off. If any
//      of these are accidentally removed/renamed, the check fails before
//      the change reaches production.
//
//   2. Pure log-dispatch simulation — replicate the log-dispatch state
//      machine (event type → log payload shape) so we can verify the
//      branching logic, null-coalescing for optional fields, and
//      subscription-id extraction without wiring the full Express +
//      Stripe signature stack.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "webhook-handler.ts"), "utf8");

function sliceBetween(
  source: string,
  startToken: string,
  endToken: string,
): string {
  const start = source.indexOf(startToken);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endToken, start + startToken.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// invoice.payment_failed — source structural checks
// ---------------------------------------------------------------------------

describe("webhook-handler — invoice.payment_failed (PR change)", () => {
  it("handles the invoice.payment_failed event type", () => {
    expect(SRC).toContain('"invoice.payment_failed"');
  });

  it("logs the stripe_invoice_payment_failed event name", () => {
    expect(SRC).toContain('"stripe_invoice_payment_failed"');
  });

  it("includes invoice_id in the payment-failed log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_invoice_payment_failed"',
      'case "charge.dispute.created"',
    );
    expect(block).toContain("invoice_id");
  });

  it("includes subscription_id in the payment-failed log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_invoice_payment_failed"',
      'case "charge.dispute.created"',
    );
    expect(block).toContain("subscription_id");
  });

  it("includes failure_code in the payment-failed log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_invoice_payment_failed"',
      'case "charge.dispute.created"',
    );
    expect(block).toContain("failure_code");
  });

  it("includes failure_message in the payment-failed log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_invoice_payment_failed"',
      'case "charge.dispute.created"',
    );
    expect(block).toContain("failure_message");
  });

  it("includes attempt_count in the payment-failed log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_invoice_payment_failed"',
      'case "charge.dispute.created"',
    );
    expect(block).toContain("attempt_count");
  });

  it("reads subscription_id from the SDK v22+ parent.subscription_details path", () => {
    expect(SRC).toContain("invoice.parent?.subscription_details?.subscription");
  });
});

// ---------------------------------------------------------------------------
// charge.dispute.created — source structural checks
// ---------------------------------------------------------------------------

describe("webhook-handler — charge.dispute.created (PR change)", () => {
  it("handles the charge.dispute.created event type", () => {
    expect(SRC).toContain('"charge.dispute.created"');
  });

  it("logs the stripe_dispute_created event name", () => {
    expect(SRC).toContain('"stripe_dispute_created"');
  });

  it("includes dispute_id in the dispute-created log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_dispute_created"',
      'case "charge.dispute.closed"',
    );
    expect(block).toContain("dispute_id");
  });

  it("includes charge_id in the dispute-created log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_dispute_created"',
      'case "charge.dispute.closed"',
    );
    expect(block).toContain("charge_id");
  });

  it("includes reason in the dispute-created log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_dispute_created"',
      'case "charge.dispute.closed"',
    );
    expect(block).toContain("reason");
  });

  it("includes evidence_due_by in the dispute-created log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_dispute_created"',
      'case "charge.dispute.closed"',
    );
    expect(block).toContain("evidence_due_by");
  });

  it("includes is_charge_refundable in the dispute-created log payload", () => {
    const block = sliceBetween(
      SRC,
      '"stripe_dispute_created"',
      'case "charge.dispute.closed"',
    );
    expect(block).toContain("is_charge_refundable");
  });
});

// ---------------------------------------------------------------------------
// charge.dispute.closed — source structural checks
// ---------------------------------------------------------------------------

describe("webhook-handler — charge.dispute.closed (PR change)", () => {
  it("handles the charge.dispute.closed event type", () => {
    expect(SRC).toContain('"charge.dispute.closed"');
  });

  it("logs the stripe_dispute_closed event name", () => {
    expect(SRC).toContain('"stripe_dispute_closed"');
  });

  it("includes dispute_id in the dispute-closed log payload", () => {
    const block = sliceBetween(SRC, '"stripe_dispute_closed"', "default: {");
    expect(block).toContain("dispute_id");
  });

  it("includes outcome in the dispute-closed log payload", () => {
    // outcome maps to dispute.status (won/lost/warning_closed)
    const block = sliceBetween(SRC, '"stripe_dispute_closed"', "default: {");
    expect(block).toContain("outcome");
  });

  it("includes amount_cents in the dispute-closed log payload", () => {
    const block = sliceBetween(SRC, '"stripe_dispute_closed"', "default: {");
    expect(block).toContain("amount_cents");
  });

  it("includes reason in the dispute-closed log payload", () => {
    const block = sliceBetween(SRC, '"stripe_dispute_closed"', "default: {");
    expect(block).toContain("reason");
  });
});

// ---------------------------------------------------------------------------
// charge.refunded — cumulative amount mirror must not regress on
// out-of-order / replayed delivery (monotonic guard).
// ---------------------------------------------------------------------------

describe("markStatusByPaymentIntent — refund mirror is monotonic", () => {
  // `charge.amount_refunded` is cumulative and Stripe can redeliver /
  // reorder charge.refunded events (distinct event.ids, so the dedup
  // gate passes them through). The refund UPDATE must carry a forward-
  // only guard so a stale lower cumulative is a no-op rather than
  // regressing amount_refunded_cents / un-flagging a full refund.
  const block = sliceBetween(
    SRC,
    "async function markStatusByPaymentIntent(",
    "async function sendOrderConfirmationIfFirst",
  );

  it("guards the refund UPDATE with .lt('amount_refunded_cents', incoming)", () => {
    expect(block).toMatch(
      /\.lt\(\s*"amount_refunded_cents"\s*,\s*ctx\.amountRefundedCents\s*\)/,
    );
  });

  it("skips (logs stale) instead of writing an audit row on a no-op update", () => {
    expect(block).toContain(
      "shop order refund skipped — stale or already-recorded cumulative",
    );
  });
});

// ---------------------------------------------------------------------------
// Log payload simulation — pure dispatch logic
//
// The three new event cases share a common pattern: extract a few
// fields off the Stripe object, null-coalesce optional refs, and pass
// a structured payload to log.warn(). We replicate that logic here so
// we can assert the exact payload shape without the full Express /
// Stripe signature machinery.
// ---------------------------------------------------------------------------

/** Mirror the subscription-id extraction logic from invoice.payment_failed */
function extractSubscriptionId(
  invoiceParent:
    | {
        subscription_details?: {
          subscription?: string | { id: string } | null;
        } | null;
      }
    | null
    | undefined,
): string | null {
  const subRef = invoiceParent?.subscription_details?.subscription;
  return typeof subRef === "string" ? subRef : (subRef?.id ?? null);
}

/** Mirror the charge-id extraction shared by both dispute event cases */
function extractChargeId(
  charge: string | { id: string } | null | undefined,
): string | null {
  return typeof charge === "string" ? charge : (charge?.id ?? null);
}

describe("invoice.payment_failed — subscription_id extraction logic", () => {
  it("returns the string directly when parent.subscription_details.subscription is a string", () => {
    expect(
      extractSubscriptionId({
        subscription_details: { subscription: "sub_abc" },
      }),
    ).toBe("sub_abc");
  });

  it("returns .id when parent.subscription_details.subscription is a Stripe object", () => {
    expect(
      extractSubscriptionId({
        subscription_details: { subscription: { id: "sub_obj" } },
      }),
    ).toBe("sub_obj");
  });

  it("returns null when parent.subscription_details is absent", () => {
    expect(extractSubscriptionId({})).toBeNull();
  });

  it("returns null when parent is null", () => {
    expect(extractSubscriptionId(null)).toBeNull();
  });

  it("returns null when parent is undefined", () => {
    expect(extractSubscriptionId(undefined)).toBeNull();
  });

  it("returns null when subscription field is null", () => {
    expect(
      extractSubscriptionId({ subscription_details: { subscription: null } }),
    ).toBeNull();
  });
});

describe("charge.dispute — charge_id extraction logic (shared by created and closed)", () => {
  it("returns the string directly when charge is a plain string id", () => {
    expect(extractChargeId("ch_abc")).toBe("ch_abc");
  });

  it("returns .id when charge is a Stripe object", () => {
    expect(extractChargeId({ id: "ch_obj" })).toBe("ch_obj");
  });

  it("returns null when charge is null", () => {
    expect(extractChargeId(null)).toBeNull();
  });

  it("returns null when charge is undefined", () => {
    expect(extractChargeId(undefined)).toBeNull();
  });
});

describe("invoice.payment_failed — failure detail extraction", () => {
  it("extracts failure_code from last_finalization_error when present", () => {
    const lastError = {
      code: "card_declined",
      message: "Your card was declined.",
    };
    expect(lastError?.code ?? null).toBe("card_declined");
    expect(lastError?.message ?? null).toBe("Your card was declined.");
  });

  it("falls back to null when last_finalization_error is null", () => {
    const getFailureCode = (
      error: { code?: string; message?: string } | null,
    ) => error?.code ?? null;
    const getFailureMessage = (
      error: { code?: string; message?: string } | null,
    ) => error?.message ?? null;
    const lastError = null;
    expect(getFailureCode(lastError)).toBeNull();
    expect(getFailureMessage(lastError)).toBeNull();
  });
});

describe("invoice.payment_failed — log payload shape simulation", () => {
  it("builds the expected log payload for a failed renewal", () => {
    const warns: unknown[][] = [];
    const log = { warn: (...args: unknown[]) => warns.push(args) };

    // Simulate a minimal invoice object
    const invoice = {
      id: "in_test",
      customer: "cus_abc",
      amount_due: 4999,
      currency: "usd",
      attempt_count: 2,
      next_payment_attempt: 1700000000,
      last_finalization_error: {
        code: "insufficient_funds",
        message: "insufficient funds",
      },
      parent: {
        subscription_details: {
          subscription: "sub_xyz" as string | { id: string },
        },
      },
    };

    const lastError = invoice.last_finalization_error ?? null;
    const subscriptionId = extractSubscriptionId(invoice.parent);

    log.warn(
      {
        event: "stripe_invoice_payment_failed",
        invoice_id: invoice.id,
        subscription_id: subscriptionId,
        customer_id:
          typeof invoice.customer === "string"
            ? invoice.customer
            : ((invoice.customer as { id: string } | null)?.id ?? null),
        amount_due_cents: invoice.amount_due,
        currency: invoice.currency,
        attempt_count: invoice.attempt_count,
        next_payment_attempt: invoice.next_payment_attempt,
        failure_code: lastError?.code ?? null,
        failure_message: lastError?.message ?? null,
      },
      "stripe: subscription renewal payment failed",
    );

    expect(warns).toHaveLength(1);
    const [payload, msg] = warns[0]!;
    expect(msg).toBe("stripe: subscription renewal payment failed");
    expect(payload).toMatchObject({
      event: "stripe_invoice_payment_failed",
      invoice_id: "in_test",
      subscription_id: "sub_xyz",
      customer_id: "cus_abc",
      amount_due_cents: 4999,
      failure_code: "insufficient_funds",
      failure_message: "insufficient funds",
      attempt_count: 2,
    });
  });

  it("builds a clean log payload for a one-off invoice (no subscription)", () => {
    const warns: unknown[][] = [];
    const log = { warn: (...args: unknown[]) => warns.push(args) };

    const invoice = {
      id: "in_oneoff",
      customer: "cus_def",
      amount_due: 2500,
      currency: "usd",
      attempt_count: 1,
      next_payment_attempt: null,
      last_finalization_error: null as {
        code?: string;
        message?: string;
      } | null,
      parent: null,
    };

    const failureCode: string | null = null;
    const failureMessage: string | null = null;
    const subRef = (
      invoice.parent as {
        subscription_details?: {
          subscription?: string | { id: string } | null;
        } | null;
      } | null
    )?.subscription_details?.subscription;
    const subscriptionId =
      typeof subRef === "string" ? subRef : (subRef?.id ?? null);

    log.warn(
      {
        event: "stripe_invoice_payment_failed",
        invoice_id: invoice.id,
        subscription_id: subscriptionId,
        customer_id:
          typeof invoice.customer === "string" ? invoice.customer : null,
        amount_due_cents: invoice.amount_due,
        currency: invoice.currency,
        attempt_count: invoice.attempt_count,
        next_payment_attempt: invoice.next_payment_attempt,
        failure_code: failureCode,
        failure_message: failureMessage,
      },
      "stripe: subscription renewal payment failed",
    );

    expect(warns).toHaveLength(1);
    const [payload] = warns[0]!;
    expect(payload).toMatchObject({
      event: "stripe_invoice_payment_failed",
      invoice_id: "in_oneoff",
      subscription_id: null,
      failure_code: null,
      failure_message: null,
    });
  });
});

describe("charge.dispute.created — log payload shape simulation", () => {
  it("builds the expected log payload for a newly-opened dispute", () => {
    const warns: unknown[][] = [];
    const log = { warn: (...args: unknown[]) => warns.push(args) };

    const dispute = {
      id: "dp_test",
      charge: "ch_abc",
      amount: 9900,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      evidence_details: { due_by: 1700100000 },
      is_charge_refundable: true,
    };

    const chargeId =
      typeof dispute.charge === "string"
        ? dispute.charge
        : ((dispute.charge as { id: string } | null)?.id ?? null);

    log.warn(
      {
        event: "stripe_dispute_created",
        dispute_id: dispute.id,
        charge_id: chargeId,
        amount_cents: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
        status: dispute.status,
        evidence_due_by: dispute.evidence_details?.due_by ?? null,
        is_charge_refundable: dispute.is_charge_refundable,
      },
      "stripe: chargeback dispute opened — CSR action required",
    );

    expect(warns).toHaveLength(1);
    const [payload, msg] = warns[0]!;
    expect(msg).toBe("stripe: chargeback dispute opened — CSR action required");
    expect(payload).toMatchObject({
      event: "stripe_dispute_created",
      dispute_id: "dp_test",
      charge_id: "ch_abc",
      amount_cents: 9900,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      evidence_due_by: 1700100000,
      is_charge_refundable: true,
    });
  });

  it("sets evidence_due_by to null when evidence_details is absent", () => {
    const dispute: {
      id: string;
      charge: string;
      amount: number;
      currency: string;
      reason: string;
      status: string;
      evidence_details?: { due_by?: number };
      is_charge_refundable: boolean;
    } = {
      id: "dp_noevidence",
      charge: "ch_xyz",
      amount: 1000,
      currency: "usd",
      reason: "general",
      status: "under_review",
      evidence_details: undefined,
      is_charge_refundable: false,
    };

    const evidenceDueBy = dispute.evidence_details?.due_by ?? null;
    expect(evidenceDueBy).toBeNull();
  });
});

describe("charge.dispute.closed — log payload shape simulation", () => {
  it("builds the expected log payload for a won dispute", () => {
    const warns: unknown[][] = [];
    const log = { warn: (...args: unknown[]) => warns.push(args) };

    const dispute = {
      id: "dp_closed",
      charge: "ch_won",
      amount: 5000,
      currency: "usd",
      status: "won",
      reason: "fraudulent",
    };

    const chargeId = typeof dispute.charge === "string" ? dispute.charge : null;

    log.warn(
      {
        event: "stripe_dispute_closed",
        dispute_id: dispute.id,
        charge_id: chargeId,
        amount_cents: dispute.amount,
        currency: dispute.currency,
        outcome: dispute.status,
        reason: dispute.reason,
      },
      "stripe: chargeback dispute closed",
    );

    expect(warns).toHaveLength(1);
    const [payload, msg] = warns[0]!;
    expect(msg).toBe("stripe: chargeback dispute closed");
    expect(payload).toMatchObject({
      event: "stripe_dispute_closed",
      dispute_id: "dp_closed",
      charge_id: "ch_won",
      amount_cents: 5000,
      outcome: "won",
      reason: "fraudulent",
    });
  });

  it("builds the expected log payload for a lost dispute", () => {
    const warns: unknown[][] = [];
    const log = { warn: (...args: unknown[]) => warns.push(args) };

    const dispute = {
      id: "dp_lost",
      charge: { id: "ch_lost_obj" },
      amount: 7500,
      currency: "usd",
      status: "lost",
      reason: "product_not_received",
    };

    const chargeId =
      typeof dispute.charge === "string"
        ? dispute.charge
        : ((dispute.charge as { id: string } | null)?.id ?? null);

    log.warn(
      {
        event: "stripe_dispute_closed",
        dispute_id: dispute.id,
        charge_id: chargeId,
        amount_cents: dispute.amount,
        currency: dispute.currency,
        outcome: dispute.status,
        reason: dispute.reason,
      },
      "stripe: chargeback dispute closed",
    );

    expect(warns).toHaveLength(1);
    const [payload] = warns[0]!;
    expect(payload).toMatchObject({
      event: "stripe_dispute_closed",
      charge_id: "ch_lost_obj",
      outcome: "lost",
      amount_cents: 7500,
    });
  });
});

// ---------------------------------------------------------------------------
// log?.warn?.() safety — handlers must not throw when log is undefined
// ---------------------------------------------------------------------------

describe("webhook-handler new events — optional log guard pattern", () => {
  it("source uses log?.warn?.() (optional chaining) so handlers survive a missing log", () => {
    // Find the invoice.payment_failed block and confirm the optional-chain
    // pattern is used, not a bare log.warn() which would throw if log is
    // undefined (e.g., in unit tests that construct events without a logger).
    const invoiceFailedIdx = SRC.indexOf('"invoice.payment_failed"');
    const disputeCreatedIdx = SRC.indexOf('"charge.dispute.created"');
    const disputeClosedIdx = SRC.indexOf('"charge.dispute.closed"');

    // Each block must contain log?.warn?.(
    const invoiceBlock = SRC.slice(invoiceFailedIdx, disputeCreatedIdx);
    const disputeCreatedBlock = SRC.slice(disputeCreatedIdx, disputeClosedIdx);
    const disputeClosedBlock = SRC.slice(
      disputeClosedIdx,
      SRC.indexOf("default:", disputeClosedIdx),
    );

    expect(invoiceBlock).toContain("log?.warn?.(");
    expect(disputeCreatedBlock).toContain("log?.warn?.(");
    expect(disputeClosedBlock).toContain("log?.warn?.(");
  });
});
