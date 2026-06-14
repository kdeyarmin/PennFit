// Patient-portal payment portal.
//
//   POST /api/me/payments/intent — create a Stripe PaymentIntent for
//        the supplied per-claim allocations. Returns the client_secret
//        the frontend uses to confirm via Stripe Elements.
//   GET  /api/me/payments — list patient's payment history.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  createPaymentCheckoutSession,
  createPaymentIntent,
} from "../../lib/billing/patient-payment";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

const intentBody = z
  .object({
    allocations: z
      .array(
        z.object({
          claimId: z.string().uuid(),
          amountAppliedCents: z.number().int().min(1),
        }),
      )
      .min(1)
      .max(20),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const checkoutSessionBody = z
  .object({
    allocations: z
      .array(
        z.object({
          claimId: z.string().uuid(),
          amountAppliedCents: z.number().int().min(1),
        }),
      )
      .min(1)
      .max(20),
    /** Optional override; defaults computed from request Origin so
     *  the same code path works in preview deployments. */
    successPath: z.string().startsWith("/").max(200).optional(),
    cancelPath: z.string().startsWith("/").max(200).optional(),
  })
  .strict();

async function resolvePatientForCustomer(
  customerId: string,
): Promise<{ patientId: string; customerEmail: string } | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: customer } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, email_lower")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (!customer?.email_lower) return null;
  // Refuse to bind when more than one patient row matches the email.
  // /me/payments serves PaymentIntent creation + history; binding to
  // the wrong patient would charge or expose another patient's
  // balance to the shopper. .ilike is case-INsensitive so legacy
  // mixed-case patient.email rows still resolve. See me-billing.ts
  // for the planned fix.
  const escapedEmail = customer.email_lower.replace(
    /[\\%_]/g,
    (c: string) => `\\${c}`,
  );
  const { data: patients } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, email")
    .ilike("email", escapedEmail)
    .limit(2);
  if (!patients || patients.length !== 1) return null;
  return {
    patientId: patients[0]!.id,
    customerEmail: customer.email_lower,
  };
}

router.post("/me/payments/intent", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = intentBody.safeParse(req.body);
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
  const link = await resolvePatientForCustomer(customerId);
  if (!link) {
    res.status(404).json({ error: "no_linked_patient" });
    return;
  }
  const result = await createPaymentIntent({
    patientId: link.patientId,
    allocations: parsed.data.allocations,
    source: "portal",
    note: parsed.data.note,
    initiatorEmail: link.customerEmail,
  });
  if ("error" in result) {
    // 503 — Stripe not configured (service unavailable in this env).
    // 502 — Stripe accepted the call but rejected (upstream error).
    // 409 — caller error (no_allocations / claim_not_owned /
    //       claim_balance_mismatch).
    const status =
      result.error === "stripe_not_configured"
        ? 503
        : result.error === "stripe_rejected"
          ? 502
          : 409;
    res.status(status).json(result);
    return;
  }
  logger.info(
    {
      event: "patient_payment.intent_created",
      patientId: link.patientId,
      paymentId: result.paymentId,
      amountCents: result.amountCents,
    },
    "patient_payment: intent created",
  );
  res.status(201).json({
    paymentId: result.paymentId,
    clientSecret: result.paymentIntentClientSecret,
    amountCents: result.amountCents,
  });
});

router.post("/me/payments/checkout-session", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = checkoutSessionBody.safeParse(req.body);
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
  const link = await resolvePatientForCustomer(customerId);
  if (!link) {
    res.status(404).json({ error: "no_linked_patient" });
    return;
  }

  // Resolve absolute success/cancel URLs. Stripe needs absolute URLs;
  // the caller passes relative paths so the same code works across
  // preview deployments. We MUST NOT trust the request's Origin/
  // Referer header directly — that would let an attacker who can
  // get the patient to POST this endpoint with a controlled Origin
  // pick the post-payment redirect destination (Stripe checkout →
  // /account/billing on evil.com). Validate against the same
  // allowlist CORS uses (RESUPPLY_ALLOWED_ORIGINS / canonical
  // SHOP_PUBLIC_BASE_URL / RAILWAY_PUBLIC_DOMAIN).
  const allowedOrigins = new Set<string>();
  const explicit = (process.env.RESUPPLY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  // Normalize each entry through `new URL(...).origin` so a trailing
  // slash, explicit default port (`:443`), or different hostname
  // casing in RESUPPLY_ALLOWED_ORIGINS still matches the same
  // normalized origin we compare against below. Without this, a
  // legitimate preview origin in the env was silently bypassed and
  // the fallback to SHOP_PUBLIC_BASE_URL redirected preview
  // checkouts to the production billing page.
  for (const o of explicit) {
    try {
      allowedOrigins.add(new URL(o).origin);
    } catch {
      // Skip malformed allowlist entries rather than storing a raw
      // value that can never match a parsed origin.
    }
  }
  const railwayHost = (process.env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  if (railwayHost) {
    try {
      allowedOrigins.add(new URL(`https://${railwayHost}`).origin);
    } catch {
      /* unreachable for a bare host */
    }
  }
  const shopBase = (process.env.SHOP_PUBLIC_BASE_URL ?? "").trim();
  if (shopBase) {
    try {
      allowedOrigins.add(new URL(shopBase).origin);
    } catch {
      // Bad SHOP_PUBLIC_BASE_URL — preflight catches this; ignore here.
    }
  }
  const originRaw = req.get("origin") ?? req.get("referer") ?? "";
  let baseOrigin: string | null = null;
  try {
    const parsed = new URL(originRaw);
    if (allowedOrigins.has(parsed.origin)) {
      baseOrigin = parsed.origin;
    }
  } catch {
    /* fall through to allowlist fallback */
  }
  if (!baseOrigin && shopBase) {
    try {
      baseOrigin = new URL(shopBase).origin;
    } catch {
      // unreachable in production (preflight gates); leave null
    }
  }
  if (!baseOrigin) {
    res.status(400).json({
      error: "invalid_origin",
      message:
        "Could not resolve a trusted redirect base — Origin header was not in the allowlist and SHOP_PUBLIC_BASE_URL is not configured.",
    });
    return;
  }
  const successUrl = `${baseOrigin}${parsed.data.successPath ?? "/account/billing?paid=1"}`;
  const cancelUrl = `${baseOrigin}${parsed.data.cancelPath ?? "/account/billing?cancelled=1"}`;

  const result = await createPaymentCheckoutSession({
    patientId: link.patientId,
    allocations: parsed.data.allocations,
    successUrl,
    cancelUrl,
    // The customer's email, not the customer UUID — this is stamped into
    // Stripe metadata.initiator_email for the "who initiated this payment"
    // audit trail (matches the PaymentIntent path above).
    initiatorEmail: link.customerEmail,
  });
  if ("error" in result) {
    res
      .status(result.error === "stripe_not_configured" ? 503 : 409)
      .json(result);
    return;
  }
  logger.info(
    {
      event: "patient_payment.checkout_session_created",
      patientId: link.patientId,
      paymentId: result.paymentId,
      amountCents: result.amountCents,
    },
    "patient_payment: checkout session created",
  );
  res.status(201).json({
    paymentId: result.paymentId,
    url: result.url,
    amountCents: result.amountCents,
  });
});

router.get("/me/payments", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const link = await resolvePatientForCustomer(customerId);
  if (!link) {
    res.json({ payments: [] });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .select(
      "id, amount_cents, currency, status, applied_claims_json, note, failure_reason, succeeded_at, created_at",
    )
    .eq("patient_id", link.patientId)
    .order("created_at", { ascending: false })
    .limit(50);
  res.json({ payments: data ?? [] });
});

export default router;
