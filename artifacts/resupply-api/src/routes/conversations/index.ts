// Conversation routes — /conversations (list) and /conversations/:id (detail).

import { Router, type IRouter } from "express";

import detailRouter from "./detail";
import listRouter from "./list";

const router: IRouter = Router();
router.use(listRouter);
router.use(detailRouter);

export default router;
