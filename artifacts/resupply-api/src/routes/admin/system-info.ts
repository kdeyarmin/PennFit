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
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool } from "@workspace/resupply-db";
import {
  hasDataKey,
  hasPhoneHmacKey,
} from "@workspace/resupply-secrets";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/admin/system-info", requireAdmin, async (_req, res) => {
  const db = drizzle(getDbPool());
  let pgVersion: string | null;
  try {
    const v = await db.execute<{ server_version: string }>(
      sql`SHOW server_version`,
    );
    pgVersion = v.rows[0]?.server_version ?? null;
  } catch {
    pgVersion = null;
  }

  let migrationCount = 0;
  let lastMigrationAt: string | null = null;
  try {
    const rows = await db.execute<{ count: number; last_at: Date | null }>(sql`
      SELECT count(*)::int AS count, max(created_at) AS last_at
      FROM resupply.__drizzle_migrations
    `);
    migrationCount = Number(rows.rows[0]?.count ?? 0);
    const lastAt = rows.rows[0]?.last_at;
    lastMigrationAt =
      lastAt instanceof Date
        ? lastAt.toISOString()
        : lastAt
          ? new Date(String(lastAt)).toISOString()
          : null;
  } catch {
    // Drizzle migrations table may not exist on a fresh DB — that's
    // fine, leave the defaults.
  }

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
      },
      stripe: {
        secretKeyConfigured: Boolean(env.STRIPE_SECRET_KEY),
        webhookSecretConfigured: Boolean(env.STRIPE_WEBHOOK_SIGNING_SECRET),
      },
      clerk: {
        publishableKeyConfigured: Boolean(
          env.VITE_CLERK_PUBLISHABLE_KEY ?? env.CLERK_PUBLISHABLE_KEY,
        ),
        secretKeyConfigured: Boolean(env.CLERK_SECRET_KEY),
      },
      objectStorage: {
        privateBucketConfigured: Boolean(env.PRIVATE_OBJECT_DIR),
      },
      openai: {
        apiKeyConfigured: Boolean(env.OPENAI_API_KEY),
      },
    },
    encryption: {
      // PHI encryption key MUST be set in production. We only
      // surface presence — never the value, never a fingerprint.
      // `hasDataKey()` / `hasPhoneHmacKey()` accept either the
      // legacy per-purpose env var or a derivation from
      // RESUPPLY_MASTER_KEY.
      phiKeyConfigured: hasDataKey(),
      phoneHmacKeyConfigured: hasPhoneHmacKey(),
    },
  });
});

export default router;
