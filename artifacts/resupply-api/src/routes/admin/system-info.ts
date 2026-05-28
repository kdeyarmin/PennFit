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

import { hasLinkHmacKey } from "@workspace/resupply-secrets";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/admin/system-info", requireAdmin, async (_req, res) => {
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
        configured: Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL),
        fromEmailConfigured: Boolean(env.SENDGRID_FROM_EMAIL),
      },
      twilio: {
        accountSidConfigured: Boolean(env.TWILIO_ACCOUNT_SID),
        authTokenConfigured: Boolean(env.TWILIO_AUTH_TOKEN),
        messagingServiceConfigured: Boolean(env.TWILIO_MESSAGING_SERVICE_SID),
        voicePhoneConfigured: Boolean(env.TWILIO_VOICE_PHONE_NUMBER),
        faxPhoneConfigured: Boolean(env.TWILIO_FAX_FROM_NUMBER),
      },
      stripe: {
        secretKeyConfigured: Boolean(env.STRIPE_SECRET_KEY),
        webhookSecretConfigured: Boolean(env.STRIPE_WEBHOOK_SIGNING_SECRET),
      },
      objectStorage: {
        privateBucketConfigured: Boolean(env.SUPABASE_STORAGE_BUCKET_PRIVATE),
      },
      openai: {
        apiKeyConfigured: Boolean(env.OPENAI_API_KEY),
      },
    },
    secrets: {
      // We only surface presence — never the value, never a
      // fingerprint. `RESUPPLY_LINK_HMAC_KEY` signs unsubscribe and
      // confirmation deep-links so they can't be forged.
      linkHmacKeyConfigured: hasLinkHmacKey(),
    },
  });
});

export default router;
