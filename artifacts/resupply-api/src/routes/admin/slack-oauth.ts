// Slack "Add to Slack" OAuth flow — one-click per-tenant install.
//
//   GET /admin/slack/oauth/start     (admin)  → redirect to Slack consent
//   GET /slack/oauth/callback        (public) → exchange code, store install
//
// Model: the PLATFORM registers ONE distributed Slack app (SLACK_CLIENT_ID /
// SLACK_CLIENT_SECRET, platform-scoped). Each tenant clicks "Add to Slack",
// authorizes it into THEIR workspace, and the callback stores that workspace's
// bot token + team id + chosen channel into the tenant's app_config — so the
// operator never pastes a token/id/channel by hand.
//
// Security: the `start` route is admin-gated and mints an HMAC-signed `state`
// bound to the tenant (orgId) + a 15-min expiry. The public callback verifies
// that state (CSRF + cross-tenant replay defense) before redeeming the code.

import { Router, type IRouter, type Request } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  exchangeSlackOAuthCode,
  SLACK_OAUTH_SCOPES,
} from "@workspace/resupply-integrations-slack";

import {
  getEffectiveEnv,
  invalidateAppConfigCache,
  invalidateTenantConfigCache,
} from "../../lib/app-config/store";
import { logger } from "../../lib/logger";
import {
  signSlackOAuthState,
  verifySlackOAuthState,
} from "../../lib/slack/oauth-state";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const CONFIG_PAGE = "/admin/system/configuration";

/** Platform public origin the OAuth redirect URL is built from — must match
 *  the redirect URL registered in the Slack app. Platform-level (NOT the
 *  tenant custom domain), since the single app has one registered redirect. */
function platformBaseUrl(): string | null {
  const explicit = process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway.replace(/^https?:\/\//, "")}`;
  return null;
}

function redirectUri(base: string): string {
  return `${base}/resupply-api/slack/oauth/callback`;
}

interface OAuthAppCreds {
  clientId: string;
  clientSecret: string;
}

function readOAuthApp(env: NodeJS.ProcessEnv): OAuthAppCreds | null {
  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ── GET /admin/slack/oauth/start ─────────────────────────────────────
router.get(
  "/admin/slack/oauth/start",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "slack.oauth.start", preset: "sensitive" }),
  async (req: Request, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const env = await getEffectiveEnv();
    const app = readOAuthApp(env);
    const base = platformBaseUrl();
    if (!app || !base) {
      // The platform operator hasn't registered the Slack app yet — bounce
      // back to the config page with a notice (no one-click available).
      res.redirect(`${CONFIG_PAGE}?slack=oauth_unavailable`);
      return;
    }

    const state = signSlackOAuthState(orgId);
    const url = new URL(SLACK_AUTHORIZE_URL);
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("scope", SLACK_OAUTH_SCOPES);
    url.searchParams.set("redirect_uri", redirectUri(base));
    url.searchParams.set("state", state);
    res.redirect(url.toString());
  },
);

// ── GET /slack/oauth/callback ────────────────────────────────────────
// Public: Slack redirects the operator's browser here. The signed `state`
// (not the session) is the authorization, so this works regardless of cookies.
router.get("/slack/oauth/callback", async (req: Request, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const denied = typeof req.query.error === "string" ? req.query.error : null;

  if (denied || !code || !state) {
    res.redirect(`${CONFIG_PAGE}?slack=error`);
    return;
  }
  const verified = verifySlackOAuthState(state);
  if (!verified.valid) {
    logger.warn(
      { event: "slack.oauth.bad_state", reason: verified.reason },
      "slack oauth: invalid state on callback",
    );
    res.redirect(`${CONFIG_PAGE}?slack=error`);
    return;
  }
  const orgId = verified.orgId;

  const env = await getEffectiveEnv();
  const app = readOAuthApp(env);
  const base = platformBaseUrl();
  if (!app || !base) {
    res.redirect(`${CONFIG_PAGE}?slack=oauth_unavailable`);
    return;
  }

  const result = await exchangeSlackOAuthCode({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    code,
    redirectUri: redirectUri(base),
  });
  if (!result.ok || !result.botToken) {
    logger.warn(
      {
        event: "slack.oauth.exchange_failed",
        org_id: orgId,
        error: result.error,
      },
      "slack oauth: code exchange failed",
    );
    res.redirect(`${CONFIG_PAGE}?slack=error`);
    return;
  }

  try {
    const supabase = getOrgScopedClient(orgId);
    const nowIso = new Date().toISOString();
    const rows: Array<{ key: string; value: string; updated_at: string }> = [
      { key: "SLACK_BOT_TOKEN", value: result.botToken, updated_at: nowIso },
    ];
    if (result.teamId)
      rows.push({
        key: "SLACK_TEAM_ID",
        value: result.teamId,
        updated_at: nowIso,
      });
    if (result.channelId)
      rows.push({
        key: "SLACK_ALERTS_CHANNEL",
        value: result.channelId,
        updated_at: nowIso,
      });
    const { error } = await supabase
      .from("app_config")
      .upsert(rows, { onConflict: "org_id,key" });
    if (error) throw error;
    invalidateAppConfigCache();
    invalidateTenantConfigCache();
    logger.info(
      {
        event: "slack.oauth.connected",
        org_id: orgId,
        team: result.teamName ?? null,
        channel_captured: !!result.channelId,
      },
      "slack oauth: workspace connected",
    );
  } catch (err) {
    logger.error(
      {
        event: "slack.oauth.store_failed",
        org_id: orgId,
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "slack oauth: failed to store install",
    );
    res.redirect(`${CONFIG_PAGE}?slack=error`);
    return;
  }

  res.redirect(`${CONFIG_PAGE}?slack=connected`);
});

export default router;
