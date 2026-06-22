// POST /admin/slack/test — send a verification message to the tenant's Slack.
//
// Backs the "Send test message" button in System Configuration → Team
// notifications (Slack). Confirms the tenant's bot token + alerts channel are
// wired correctly by posting a one-off message to the channel. Same gate as
// the config store itself (system.config.manage); reads the caller's tenant.

import { Router, type IRouter } from "express";

import { logger } from "../../lib/logger";
import { sendSlackTestMessage } from "../../lib/slack/notify";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

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
      logger.info(
        { event: "slack.test.sent", org_id: orgId },
        "slack: test message sent",
      );
      res.json({ success: true, message: "Test message sent to Slack." });
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

    // send_failed — surface Slack's error code (e.g. channel_not_found,
    // invalid_auth, not_in_channel) so the operator can fix the setup.
    logger.warn(
      { event: "slack.test.failed", org_id: orgId, error: result.error },
      "slack: test message failed",
    );
    res.status(502).json({
      error: "slack_send_failed",
      message: result.error
        ? `Slack rejected the message: ${result.error}`
        : "Slack rejected the message.",
    });
  },
);

export default router;
