// Episode routes — /episodes (list + per-status counts strip).

import { Router, type IRouter } from "express";

import bulkSendRouter from "./bulk-send";
import countsRouter from "./counts";
import listRouter from "./list";

const router: IRouter = Router();
// More-specific paths first (`/episodes/counts`, `/episodes/bulk-send`)
// so they resolve before any wildcard the list router would match.
// Express would still route correctly today (all are exact paths)
// but the ordering hedges against a future `/:id` route landing in
// list.ts.
router.use(bulkSendRouter);
router.use(countsRouter);
router.use(listRouter);

export default router;
