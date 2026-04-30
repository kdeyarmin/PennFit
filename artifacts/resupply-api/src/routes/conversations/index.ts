// Conversation routes — /conversations (list), /conversations/:id (detail),
// and /conversations/:id/reply (admin appends to an open thread).

import { Router, type IRouter } from "express";

import detailRouter from "./detail";
import listRouter from "./list";
import replyRouter from "./reply";

const router: IRouter = Router();
router.use(listRouter);
router.use(detailRouter);
router.use(replyRouter);

export default router;
