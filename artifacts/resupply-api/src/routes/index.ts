import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import meRouter from "./me.js";
import voiceRouter from "./voice/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
// Voice routes are mounted unconditionally; each handler does its own
// feature-flag check so a missing env var becomes a clean 503 rather
// than a generic 404. See routes/voice/index.ts.
router.use(voiceRouter);

export default router;
