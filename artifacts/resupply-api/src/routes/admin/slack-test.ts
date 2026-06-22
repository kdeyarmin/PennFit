// POST /admin/slack/test — verify the tenant's Slack wiring and send a test.
//
// Backs the "Send test message" button in System Configuration → Team
// notifications (Slack). It (1) confirms the bot token via Slack auth.test,
// (2) AUTO-SAVES the detected workspace (team) id so inbound interactivity
// routing works without the operator hunting for it, and (3) posts a visible
// test message to the channel. Same gate as the config store
// (system.config.manage); reads the caller's tenant.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  invalidateAppConfigCache,
  invalidateTenantConfigCache,
} from "../../lib/app-config/store";
import { logger } from "../../lib/logger";
import { sendSlackTestMessage } from "../../lib/slack/notify";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/**
 * Persist the auth.test-detected workspace id so inbound Slack requests route
 * to this tenant without the operator entering SLACK_TEAM_ID by hand.
 * Best-effort: the test already succeeded, so a write hiccup only means the
 * operator may need to set it manually — never fail the test on it.
 */
async function autoSaveTeamId(
  orgId: string,
  teamId: string,
  actor: { userId: string | null; email: string | null },
): Promise<void> {
  try {
    const supabase = getOrgScopedClient(orgId);
    await supabase.from("app_config").upsert(
      {
        key: "SLACK_TEAM_ID",
        value: teamId,
        updated_by_user_id: actor.userId,
        updated_by_email: actor.email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,key" },
    );
    invalidateAppConfigCache();
    invalidateTenantConfigCache();
  } catch (err) {
    logger.warn(
      {
        event: "slack.test.team_id_save_failed",
        org_id: orgId,
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "slack: auto-save of team id failed (test still succeeded)",
    );
  }
}

router.post(
  "/admin/slack/test",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "slack.test", preset: "sensitive" }),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const result = await sendSlackTestMessage(orgId);
    if (result.ok) {
      if (result.teamId) {
        await autoSaveTeamId(orgId, result.teamId, {
          userId: req.adminUserId ?? null,
          email: req.adminEmail ?? null,
        });
      }
      logger.info(
        {
          event: "slack.test.sent",
          org_id: orgId,
          autosaved_team: !!result.teamId,
        },
        "slack: test message sent",
      );
      res.json({
        success: true,
        message: result.team
          ? `Connected to ${result.team} — test message sent. Inbound routing is set up automatically.`
          : "Test message sent to Slack.",
        workspace: result.team,
        teamId: result.teamId,
      });
      return;
    }

    if (result.reason === "not_configured") {
      res.status(400).json({
        error: "slack_not_configured",
        message:
          "Add a Slack bot token and alerts channel above, then try again.",
      });
      return;
    }

    if (result.reason === "auth_failed") {
      res.status(400).json({
        error: "slack_auth_failed",
        message: result.error
          ? `Slack rejected the bot token: ${result.error}. Check the token and that the app is installed.`
          : "Slack rejected the bot token.",
      });
      return;
    }

    // send_failed — surface Slack's error code (e.g. channel_not_found,
    // not_in_channel) so the operator can fix the channel/invite.
    logger.warn(
      { event: "slack.test.failed", org_id: orgId, error: result.error },
      "slack: test message failed",
    );
    res.status(502).json({
      error: "slack_send_failed",
      message: result.error
        ? `Slack rejected the message: ${result.error}. Make sure the bot is invited to the channel.`
        : "Slack rejected the message.",
    });
  },
);

export default router;
