import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import meRouter from "./me.js";
import voiceRouter from "./voice/index.js";
import smsRouter from "./sms/index.js";
import emailRouter from "./email/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
// Voice + SMS + Email routes are mounted unconditionally; each handler
// does its own feature-flag check so a missing env var becomes a clean
// 503 (or TwiML 503 for vendor-only paths) rather than a generic 404.
router.use(voiceRouter);
router.use(smsRouter);
router.use(emailRouter);

export default router;
