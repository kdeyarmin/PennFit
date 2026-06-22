// GET /resupply-api/platform/health — platform-operator health snapshot.
//
// "Is the platform actually up and wired?" in one call:
//   * readiness — DB reachable + the in-process pg-boss worker ready
//     (reuses `checkReadiness`, the same probe behind /readyz), plus the
//     measured round-trip latency of that probe.
//   * vendors — which platform INFRASTRUCTURE credentials are present in
//     THIS running process: the AI brains, the comms carriers, payments,
//     and object storage. A pure env read — no vendor round-trip — so it
//     loads instantly and never hangs on a flaky third party.
//
// Gated by `requirePlatformAdmin`. No PHI and no secrets ever cross this
// surface — only booleans and the same coarse status strings /readyz
// already exposes.

import { Router, type IRouter } from "express";

import { checkReadiness } from "../../lib/readiness";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

// Pure env read — mirrors the per-vendor credential checks ops-status uses,
// scoped to the platform-shared infrastructure a super-admin provisions in
// Global integrations. A vendor degrades gracefully when unset, so these
// are "is it wired", not "is it required".
function computeVendorFlags(env: NodeJS.ProcessEnv) {
  return {
    ai: {
      anthropic: Boolean(env.ANTHROPIC_API_KEY),
      openai: Boolean(env.OPENAI_API_KEY),
      elevenlabs: Boolean(env.ELEVENLABS_API_KEY),
      deepgram: Boolean(env.DEEPGRAM_API_KEY),
    },
    comms: {
      sendgrid: Boolean(env.SENDGRID_API_KEY),
      twilioVoice: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
      twilioSms: Boolean(
        env.TWILIO_ACCOUNT_SID &&
        env.TWILIO_AUTH_TOKEN &&
        env.TWILIO_MESSAGING_SERVICE_SID,
      ),
      telnyxFax: Boolean(
        env.TELNYX_API_KEY &&
        env.TELNYX_FAX_CONNECTION_ID &&
        env.TELNYX_FAX_FROM_NUMBER &&
        env.TELNYX_PUBLIC_KEY,
      ),
    },
    payments: {
      stripe: Boolean(env.STRIPE_SECRET_KEY),
      platformBilling: Boolean(env.STRIPE_PLATFORM_SECRET_KEY),
    },
    storage: Boolean(env.SUPABASE_STORAGE_BUCKET_PRIVATE),
  };
}

router.get(
  "/platform/health",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res): Promise<void> => {
    const startedAt = Date.now();
    const readiness = await checkReadiness();
    const latencyMs = Date.now() - startedAt;

    res.json({
      generatedAt: new Date().toISOString(),
      readiness: {
        status: readiness.status,
        checks: readiness.checks,
        errors: readiness.errors ?? null,
        latencyMs,
      },
      vendors: computeVendorFlags(process.env),
    });
  },
);

export default router;
