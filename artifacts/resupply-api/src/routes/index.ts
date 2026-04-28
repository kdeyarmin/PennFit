import { Router, type IRouter } from "express";
import auditRouter from "./audit/index.js";
import conversationsRouter from "./conversations/index.js";
import dashboardRouter from "./dashboard/index.js";
import emailRouter from "./email/index.js";
import episodesRouter from "./episodes/index.js";
import healthRouter from "./health.js";
import meRouter from "./me.js";
import patientsRouter from "./patients/index.js";
import rulesRouter from "./rules/index.js";
import smsRouter from "./sms/index.js";
import voiceRouter from "./voice/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
// Voice + SMS + Email routes are mounted unconditionally; each handler
// does its own feature-flag check so a missing env var becomes a clean
// 503 (or TwiML 503 for vendor-only paths) rather than a generic 404.
router.use(voiceRouter);
router.use(smsRouter);
router.use(emailRouter);
// Operator-console READ endpoints. Each handler is gated by
// requireOperator and surfaces only PHI the dashboard needs to
// render — decrypted name on lists, decrypted message bodies only on
// the conversation detail endpoint, never phone or email values.
router.use(dashboardRouter);
router.use(patientsRouter);
router.use(rulesRouter);
router.use(conversationsRouter);
router.use(episodesRouter);
router.use(auditRouter);

export default router;
