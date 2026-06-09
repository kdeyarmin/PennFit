// Patient-portal payment methods + autopay (patient-controlled).
//
//   GET    /api/me/payment-methods                 — saved card + autopay status
//   POST   /api/me/payment-methods/setup-session   — Stripe setup (add a card)
//   PATCH  /api/me/payment-methods/autopay         — toggle autopay on/off
//   DELETE /api/me/payment-methods                 — remove the saved card
//
// Auth: the storefront `attachSignedIn` middleware (mounted in
// routes/storefront/index.ts) sets req.shopCustomerId from the pf_session
// cookie. We map customer → patient via the shop_customers.email_lower ↔
// patients.email join (same guard as me-claims / me-payments: refuse when
// the email is ambiguous so one patient never sees / authorizes against
// another's balance).
//
// Saving a card NEVER charges anything and NEVER enables autopay on its
// own — autopay is the separate, default-OFF switch the patient flips
// here. Actual charging is the worker's job, gated by the seeded-OFF
// billing.patient_autopay flag + an env cron.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  createAutopaySetupSession,
  getActiveAutopayAuthorization,
  revokeAutopayAuthorization,
  setAutopayEnabled,
  toAutopayStatusView,
} from "../../lib/billing/patient-autopay";
import { logger } from "../../lib/logger";
import { readStripeConfigOrNull } from "../../lib/stripe/config";
import { getOrCreateStripeCustomer } from "../../lib/stripe/customer";
import { rateLimit } from "../../middlewares/rate-limit";

const router: IRouter = Router();

const setupBody = z
  .object({
    enableAutopay: z.boolean().default(false),
    successPath: z.string().startsWith("/").max(200).optional(),
    cancelPath: z.string().startsWith("/").max(200).optional(),
  })
  .strict();

const autopayBody = z.object({ enabled: z.boolean() }).strict();

function customerKeyFn(req: import("express").Request): string {
  return (
    (req as unknown as { shopCustomerId?: string }).shopCustomerId ??
    req.ip ??
    "unknown"
  );
}

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
  // Refuse to bind when more than one patient row matches the email —
  // saving / charging a card against the wrong patient is a PHI + money
  // leak. .ilike is case-INsensitive so legacy mixed-case rows resolve.
  const escapedEmail = customer.email_lower.replace(
    /[\\%_]/g,
    (c: string) => `\\${c}`,
  );
  const { data: patients } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(2);
  if (!patients || patients.length !== 1) return null;
  return { patientId: patients[0]!.id, customerEmail: customer.email_lower };
}

/**
 * Resolve a trusted absolute base origin for Stripe redirect URLs. We
 * MUST NOT trust the request Origin/Referer directly — that would let an
 * attacker pick the post-setup redirect. Validate against the same
 * allowlist CORS uses (mirrors me-payments.ts).
 */
function resolveTrustedBaseOrigin(
  req: import("express").Request,
): string | null {
  const allowedOrigins = new Set<string>();
  for (const o of (process.env.RESUPPLY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      allowedOrigins.add(new URL(o).origin);
    } catch {
      /* skip malformed allowlist entries */
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
      /* preflight catches a bad SHOP_PUBLIC_BASE_URL */
    }
  }
  const originRaw = req.get("origin") ?? req.get("referer") ?? "";
  try {
    const parsed = new URL(originRaw);
    if (allowedOrigins.has(parsed.origin)) return parsed.origin;
  } catch {
    /* fall through to the allowlist fallback */
  }
  if (shopBase) {
    try {
      return new URL(shopBase).origin;
    } catch {
      /* leave null */
    }
  }
  return null;
}

router.get(
  "/me/payment-methods",
  rateLimit({
    windowMs: 5 * 60_000,
    max: 60,
    name: "me_autopay_status",
    keyFn: customerKeyFn,
  }),
  async (req, res) => {
    const customerId = req.shopCustomerId ?? null;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const link = await resolvePatientForCustomer(customerId);
    if (!link) {
      // No linked patient → nothing to manage; report an empty state rather
      // than a hard error so the portal section renders cleanly.
      res.json(toAutopayStatusView(null));
      return;
    }
    const row = await getActiveAutopayAuthorization(link.patientId);
    res.json(toAutopayStatusView(row));
  },
);

router.post(
  "/me/payment-methods/setup-session",
  // Each call mints a Stripe Checkout session — cap the per-customer rate
  // so a wedged client can't hammer the Stripe API on our dime.
  rateLimit({
    windowMs: 5 * 60_000,
    max: 8,
    name: "me_autopay_setup",
    keyFn: customerKeyFn,
  }),
  async (req, res) => {
    const customerId = req.shopCustomerId ?? null;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const parsed = setupBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }
    const link = await resolvePatientForCustomer(customerId);
    if (!link) {
      res.status(404).json({ error: "no_linked_patient" });
      return;
    }
    const baseOrigin = resolveTrustedBaseOrigin(req);
    if (!baseOrigin) {
      res.status(400).json({ error: "invalid_origin" });
      return;
    }
    const successUrl = `${baseOrigin}${parsed.data.successPath ?? "/account/billing?card_added=1"}`;
    const cancelUrl = `${baseOrigin}${parsed.data.cancelPath ?? "/account/billing?card_cancelled=1"}`;

    // Ensure the patient's shop customer has a Stripe Customer so the
    // saved card attaches to a stable, reusable customer.
    let stripeCustomerId: string;
    try {
      const mapping = await getOrCreateStripeCustomer(config, {
        customerId,
        email: req.shopCustomerEmail ?? link.customerEmail,
        displayName: req.shopCustomerDisplayName ?? null,
      });
      stripeCustomerId = mapping.stripeCustomerId;
    } catch (err) {
      logger.warn({ err }, "me-payment-methods: stripe customer ensure failed");
      res.status(502).json({ error: "stripe_error" });
      return;
    }

    const result = await createAutopaySetupSession({
      patientId: link.patientId,
      shopCustomerId: customerId,
      stripeCustomerId,
      successUrl,
      cancelUrl,
      enableAutopay: parsed.data.enableAutopay,
      initiatorEmail: req.shopCustomerEmail ?? link.customerEmail,
    });
    if ("error" in result) {
      res
        .status(result.error === "stripe_not_configured" ? 503 : 502)
        .json(result);
      return;
    }
    logger.info(
      {
        event: "patient_autopay.setup_session_created",
        patientId: link.patientId,
      },
      "patient_autopay: setup session created",
    );
    res.status(201).json({ url: result.url });
  },
);

router.patch(
  "/me/payment-methods/autopay",
  rateLimit({
    windowMs: 5 * 60_000,
    max: 30,
    name: "me_autopay_toggle",
    keyFn: customerKeyFn,
  }),
  async (req, res) => {
    const customerId = req.shopCustomerId ?? null;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const parsed = autopayBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const link = await resolvePatientForCustomer(customerId);
    if (!link) {
      res.status(404).json({ error: "no_linked_patient" });
      return;
    }
    const result = await setAutopayEnabled(
      link.patientId,
      parsed.data.enabled,
      `customer:${link.customerEmail}`,
    );
    if ("error" in result) {
      res.status(409).json(result);
      return;
    }
    logger.info(
      {
        event: "patient_autopay.toggled",
        patientId: link.patientId,
        enabled: result.autopayEnabled,
      },
      "patient_autopay: toggle updated",
    );
    res.json({ ok: true, autopayEnabled: result.autopayEnabled });
  },
);

router.delete(
  "/me/payment-methods",
  rateLimit({
    windowMs: 5 * 60_000,
    max: 30,
    name: "me_autopay_remove",
    keyFn: customerKeyFn,
  }),
  async (req, res) => {
    const customerId = req.shopCustomerId ?? null;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const link = await resolvePatientForCustomer(customerId);
    if (!link) {
      res.status(404).json({ error: "no_linked_patient" });
      return;
    }
    const result = await revokeAutopayAuthorization(
      link.patientId,
      `customer:${link.customerEmail}`,
    );
    if ("error" in result) {
      res.status(409).json(result);
      return;
    }
    logger.info(
      { event: "patient_autopay.card_removed", patientId: link.patientId },
      "patient_autopay: card removed",
    );
    res.json({ ok: true });
  },
);

export default router;
