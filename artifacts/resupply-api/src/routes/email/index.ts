// Email routes — /email/send-reminder (admin), /email/click
// (public link-click), /email/sendgrid-events (SendGrid webhook).
// Per-handler feature-flag check; 503 + stable error code when env is
// missing.

import { Router, type IRouter } from "express";

import clickRouter from "./click";
import inboundParseRouter from "./inbound-parse";
import sendReminderRouter from "./send-reminder";
import sendgridEventsRouter from "./sendgrid-events";

const router: IRouter = Router();
router.use(sendReminderRouter);
router.use(clickRouter);
router.use(sendgridEventsRouter);
router.use(inboundParseRouter);

export default router;
