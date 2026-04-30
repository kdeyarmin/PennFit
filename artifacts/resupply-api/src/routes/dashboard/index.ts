// Dashboard routes — admin counters for the dashboard home.

import { Router, type IRouter } from "express";

import summaryRouter from "./summary";

const router: IRouter = Router();
router.use(summaryRouter);

export default router;
