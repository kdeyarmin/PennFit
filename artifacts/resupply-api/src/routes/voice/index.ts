// Voice routes — /voice/place-call, /voice/twiml-connect,
// /voice/status-callback. The actual WS upgrade for
// /voice/stream is wired in `src/index.ts` because it lives on the
// HTTP server, not the Express router.
//
// These three routes are mounted unconditionally — each handler does
// its own feature-flag check (so a single 503 reply tells operators
// exactly which env var is missing). That avoids a class of subtle
// "routes vanished after deploy" bug where a missing env var would
// silently demote a 503 into a generic 404.

import { Router, type IRouter } from "express";

import placeCallRouter from "./place-call";
import statusCallbackRouter from "./status-callback";
import twimlConnectRouter from "./twiml-connect";

const router: IRouter = Router();
router.use(placeCallRouter);
router.use(twimlConnectRouter);
router.use(statusCallbackRouter);

export default router;
