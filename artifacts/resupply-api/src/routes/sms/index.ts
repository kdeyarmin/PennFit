// SMS routes — /sms/send-reminder (operator), /sms/inbound (Twilio
// webhook), /sms/status-callback (Twilio webhook). Each handler does
// its own feature-flag check so a missing env var becomes a clean 503
// (operator endpoint) or TwiML 503 (vendor endpoints) rather than a
// generic 404.

import { Router, type IRouter } from "express";

import inboundRouter from "./inbound";
import sendReminderRouter from "./send-reminder";
import statusCallbackRouter from "./status-callback";

const router: IRouter = Router();
router.use(sendReminderRouter);
router.use(inboundRouter);
router.use(statusCallbackRouter);

export default router;
