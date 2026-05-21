// GET /admin/system/integrations-status
//
// Roll-up of EVERY integration the API talks to + its current
// "configured / partial / unconfigured" posture. Distinct from the
// /readyz / /healthz probe set (those gate traffic); this is the
// admin-facing "is the platform actually wired correctly" view.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { resolveBillingIdentity, resolveClearinghouse } from "../../lib/billing/identity-resolver";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/system/integrations-status",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const env = process.env;

    const [identity, clearinghouse, queueDepth, recentWebhookFails] =
      await Promise.all([
        resolveBillingIdentity({ supabase }),
        resolveClearinghouse({ supabase }),
        supabase
          .schema("resupply")
          .from("webhook_deliveries")
          .select("id", { count: "exact", head: true })
          .eq("status", "queued"),
        supabase
          .schema("resupply")
          .from("webhook_deliveries")
          .select("id", { count: "exact", head: true })
          .eq("status", "exhausted")
          .gte(
            "updated_at",
            new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
          ),
      ]);

    res.json({
      dmeIdentity: {
        source: identity.source,
        organizationName: identity.billingProvider.organizationName,
        configured: identity.source === "db",
      },
      clearinghouseOfficeAlly: {
        source: clearinghouse.source,
        configured: clearinghouse.source !== "stub",
        usageIndicator: clearinghouse.usageIndicator,
        lastPolledAt: clearinghouse.row?.last_polled_at ?? null,
      },
      stripe: {
        configured: !!env.STRIPE_SECRET_KEY,
        webhookSigningConfigured: !!env.STRIPE_WEBHOOK_SECRET,
      },
      openai: {
        configured: !!env.OPENAI_API_KEY,
        note: "Powers AI scrub, denial analysis, sleep coach, patient explainer.",
      },
      sendgrid: {
        configured: !!env.SENDGRID_API_KEY,
      },
      twilio: {
        configured:
          !!env.TWILIO_ACCOUNT_SID && !!env.TWILIO_AUTH_TOKEN,
        faxConfigured: !!env.TWILIO_FAX_FROM_NUMBER,
      },
      davinciPas: {
        // We treat the integration as configured if at least ONE
        // payer_profile has a davinci_pas_endpoint_url set.
        configured: await hasAnyPasPayer(supabase),
      },
      webhooks: {
        queuedDeliveries: queueDepth.count ?? 0,
        exhaustedDeliveries24h: recentWebhookFails.count ?? 0,
        healthy:
          (queueDepth.count ?? 0) < 100 &&
          (recentWebhookFails.count ?? 0) < 10,
      },
      generatedAt: new Date().toISOString(),
    });
  },
);

async function hasAnyPasPayer(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
): Promise<boolean> {
  const { count } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("id", { count: "exact", head: true })
    .not("davinci_pas_endpoint_url", "is", null);
  return (count ?? 0) > 0;
}

export default router;
