// /admin/billing/stripe-connect — tenant Stripe Connect (Express)
// onboarding (G5 slice C).
//
//   GET  /admin/billing/stripe-connect/status — is this tenant connected,
//        and has Stripe enabled charges (onboarding complete)?
//   POST /admin/billing/stripe-connect/start  — create the tenant's
//        Express connected account (once) and return a Stripe-hosted
//        onboarding account-link URL to redirect the owner to.
//
// The connected account id is stored immediately, but charges keep
// flowing through the PLATFORM account until Stripe's `account.updated`
// webhook flips `stripe_charges_enabled` (see lib/stripe/connect.ts +
// the webhook dispatcher) — so creating the account never mis-routes a
// charge to an account that can't yet accept it.
//
// Gate: `system.config.manage` (super_admin / owner) — connecting the
// payment processor is an owner-level action, same tier as System
// Configuration. Fail-closed on a missing tenant context.

import { Router, type IRouter } from "express";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  getStripeClient,
  readPublicBaseUrl,
  readStripeConfigOrNull,
  SHOP_UNAVAILABLE_BODY,
} from "../../lib/stripe/config";
import {
  clearConnectedAccountId,
  setChargesEnabledByAccount,
  setConnectedAccountId,
} from "../../lib/stripe/connect";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

interface OrgStripeRow {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
}

async function readOrgStripe(orgId: string): Promise<OrgStripeRow | null> {
  const { data, error } = await getOrgScopedClient(orgId)
    .raw()
    .schema("resupply")
    .from("organizations")
    .select("stripe_account_id, stripe_charges_enabled")
    .eq("id", orgId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as OrgStripeRow | null) ?? null;
}

router.get(
  "/admin/billing/stripe-connect/status",
  adminReadRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!readStripeConfigOrNull()) {
      res.status(503).json(SHOP_UNAVAILABLE_BODY);
      return;
    }
    const row = await readOrgStripe(orgId);
    res.json({
      connected: Boolean(row?.stripe_account_id),
      chargesEnabled: row?.stripe_charges_enabled === true,
      accountId: row?.stripe_account_id ?? null,
    });
  },
);

router.post(
  "/admin/billing/stripe-connect/start",
  adminWriteRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json(SHOP_UNAVAILABLE_BODY);
      return;
    }
    const publicBaseUrl = readPublicBaseUrl();
    if (!publicBaseUrl) {
      res.status(503).json({ error: "public_base_url_unset" });
      return;
    }
    const stripe = getStripeClient(config);

    try {
      const row = await readOrgStripe(orgId);
      let accountId = row?.stripe_account_id ?? null;
      if (!accountId) {
        // Express: Stripe hosts onboarding + the tenant's dashboard; the
        // platform retains a lighter integration (the product decision).
        const account = await stripe.accounts.create({
          type: "express",
          metadata: { org_id: orgId },
        });
        accountId = account.id;
        await setConnectedAccountId(orgId, accountId);
        await logAudit({
          action: "billing.stripe_connect.account_created",
          adminEmail: req.adminEmail ?? null,
          adminUserId: req.adminUserId ?? null,
          targetTable: "organizations",
          targetId: orgId,
          metadata: { accountId },
          ip: req.ip ?? null,
          userAgent: null,
        }).catch((err) => {
          logger.warn({ err }, "stripe-connect: account-created audit failed");
        });
      }

      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${publicBaseUrl}/admin/billing/config/organization?stripe_connect=refresh`,
        return_url: `${publicBaseUrl}/admin/billing/config/organization?stripe_connect=return`,
        type: "account_onboarding",
      });
      res.json({ url: link.url, accountId });
    } catch (err) {
      logger.warn(
        { ...stripeErrLogFields(err) },
        "stripe-connect: onboarding start failed",
      );
      res.status(502).json({ error: "stripe_connect_start_failed" });
    }
  },
);

// POST /admin/billing/stripe-connect/refresh — reconcile `charges_enabled`
// straight from Stripe (`accounts.retrieve`). The webhook (`account.updated`)
// is the primary path that flips the gate, but it only fires on a *change*;
// if the signing secret is unset, or an event was missed, a tenant can be
// stuck "connected, not enabled". This is the operator-pull recovery so the
// status never depends solely on webhook delivery.
router.post(
  "/admin/billing/stripe-connect/refresh",
  adminWriteRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json(SHOP_UNAVAILABLE_BODY);
      return;
    }
    const row = await readOrgStripe(orgId);
    if (!row?.stripe_account_id) {
      res.status(409).json({ error: "not_connected" });
      return;
    }
    const stripe = getStripeClient(config);
    try {
      const account = await stripe.accounts.retrieve(row.stripe_account_id);
      const chargesEnabled = account.charges_enabled === true;
      // Persist + invalidate the routing cache (fails soft internally).
      await setChargesEnabledByAccount(row.stripe_account_id, chargesEnabled);
      res.json({
        connected: true,
        chargesEnabled,
        accountId: row.stripe_account_id,
      });
    } catch (err) {
      logger.warn(
        { ...stripeErrLogFields(err) },
        "stripe-connect: status refresh failed",
      );
      res.status(502).json({ error: "stripe_connect_refresh_failed" });
    }
  },
);

// POST /admin/billing/stripe-connect/disconnect — detach the tenant from
// its connected account. Routes charges back to the platform account
// immediately. Does NOT delete the Stripe account itself (see
// clearConnectedAccountId); a later `start` mints a fresh Express account.
router.post(
  "/admin/billing/stripe-connect/disconnect",
  adminWriteRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const row = await readOrgStripe(orgId);
    const priorAccountId = row?.stripe_account_id ?? null;
    try {
      await clearConnectedAccountId(orgId);
    } catch (err) {
      logger.warn(
        { ...stripeErrLogFields(err) },
        "stripe-connect: disconnect failed",
      );
      res.status(502).json({ error: "stripe_connect_disconnect_failed" });
      return;
    }
    await logAudit({
      action: "billing.stripe_connect.disconnected",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "organizations",
      targetId: orgId,
      metadata: { priorAccountId },
      ip: req.ip ?? null,
      userAgent: null,
    }).catch((err) => {
      logger.warn({ err }, "stripe-connect: disconnect audit failed");
    });
    res.json({ connected: false, chargesEnabled: false, accountId: null });
  },
);

export default router;
