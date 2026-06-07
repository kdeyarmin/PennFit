// /admin/system-info — read-only environment + deployment metadata.
//
// Surfaces what ops typically needs to confirm during incident
// response without ssh-ing into the box: which environment they're
// looking at, server time (drift check), Postgres version, git
// commit, configured public URLs, and per-vendor configuration
// presence.
//
// Privacy posture: env-var VALUES are never returned. We only return
// "is this set?" booleans plus the sizes of the admin/agent
// allowlists (counts, not the addresses themselves).

import { Router, type IRouter } from "express";

import { applyEnvAliases, hasLinkHmacKey } from "@workspace/resupply-secrets";

import { getEffectiveEnv } from "../../lib/app-config/store";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/system-info",
  adminReadRateLimiter,
  requireAdmin,
  async (_req, res) => {
    // pgVersion / migrationCount / lastMigrationAt are returned as
    // placeholders: PostgREST doesn't expose `SHOW server_version`, and
    // the on-DB migration bookkeeping table is only consulted by the
    // deploy migrator (`scripts/migrate.mjs`). The Supabase dashboard
    // surfaces both pieces directly to operators; here we return nulls
    // to keep the response shape stable for the existing SPA renderer.
    const pgVersion: string | null = null;
    const migrationCount = 0;
    const lastMigrationAt: string | null = null;

    const env = process.env;
    // Vendor presence is computed against the EFFECTIVE env (process.env
    // plus values saved in System Configuration / resupply.app_config) so
    // a credential entered in the app reads as "configured" here, matching
    // the System Configuration page. Cached + fail-soft: any DB hiccup
    // degrades to process.env. Non-vendor fields below stay on the live
    // process.env (e.g. the public webhook URLs, which the running process
    // signs against until the next deploy).
    //
    // applyEnvAliases() then resolves the consolidated env aliases over
    // that effective env — the same backfill the process runs at boot
    // (app.ts), but extended to cover values saved in System
    // Configuration. Without it, a Twilio number entered there (saved
    // under the canonical TWILIO_PHONE_NUMBER, the name the call path and
    // the catalog use) would never flip `voicePhoneConfigured` below,
    // which reads the retired TWILIO_VOICE_PHONE_NUMBER alias: the
    // boot-time aliaser only runs over process.env, never over the
    // app_config overlay. Spread into a fresh object first so we never
    // mutate process.env (getEffectiveEnv returns it as-is when there are
    // no overrides).
    const vendorEnv = { ...(await getEffectiveEnv()) };
    applyEnvAliases(vendorEnv);
    const allowlistCount = (raw: string | undefined) =>
      raw
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean).length
        : 0;

    res.json({
      server: {
        now: new Date().toISOString(),
        nodeVersion: process.version,
        pgVersion,
        uptimeSeconds: Math.round(process.uptime()),
        // Best-effort git commit. Read from common CI env vars; never
        // an env var that contains secrets.
        gitSha:
          env.GIT_COMMIT_SHA ??
          env.VERCEL_GIT_COMMIT_SHA ??
          env.RAILWAY_GIT_COMMIT_SHA ??
          env.SOURCE_COMMIT ??
          null,
        nodeEnv: env.NODE_ENV ?? null,
      },
      database: {
        migrationCount,
        lastMigrationAt,
      },
      publicUrls: {
        shop: env.SHOP_PUBLIC_BASE_URL ?? null,
        voice: env.RESUPPLY_VOICE_PUBLIC_BASE_URL ?? null,
        dashboard: env.RESUPPLY_DASHBOARD_PUBLIC_BASE_URL ?? null,
      },
      auth: {
        adminAllowlistCount: allowlistCount(env.RESUPPLY_ADMIN_EMAILS),
        agentAllowlistCount: allowlistCount(env.RESUPPLY_AGENT_EMAILS),
        legacyAdminAllowlistCount: allowlistCount(env.RESUPPLY_OPERATOR_EMAILS),
      },
      vendors: {
        sendgrid: {
          configured: Boolean(vendorEnv.SENDGRID_API_KEY),
          fromEmailConfigured: Boolean(vendorEnv.SENDGRID_FROM_EMAIL),
        },
        twilio: {
          accountSidConfigured: Boolean(vendorEnv.TWILIO_ACCOUNT_SID),
          authTokenConfigured: Boolean(vendorEnv.TWILIO_AUTH_TOKEN),
          messagingServiceConfigured: Boolean(
            vendorEnv.TWILIO_MESSAGING_SERVICE_SID,
          ),
          voicePhoneConfigured: Boolean(vendorEnv.TWILIO_VOICE_PHONE_NUMBER),
          faxPhoneConfigured: Boolean(vendorEnv.TWILIO_FAX_FROM_NUMBER),
        },
        stripe: {
          secretKeyConfigured: Boolean(vendorEnv.STRIPE_SECRET_KEY),
          webhookSecretConfigured: Boolean(
            vendorEnv.STRIPE_WEBHOOK_SIGNING_SECRET,
          ),
        },
        objectStorage: {
          privateBucketConfigured: Boolean(
            vendorEnv.SUPABASE_STORAGE_BUCKET_PRIVATE,
          ),
        },
        openai: {
          apiKeyConfigured: Boolean(vendorEnv.OPENAI_API_KEY),
        },
      },
      secrets: {
        // We only surface presence — never the value, never a
        // fingerprint. `RESUPPLY_LINK_HMAC_KEY` signs unsubscribe and
        // confirmation deep-links so they can't be forged.
        linkHmacKeyConfigured: hasLinkHmacKey(),
      },
    });
  },
);

export default router;
