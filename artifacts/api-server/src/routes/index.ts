import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import recommendRouter from "./recommend.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(recommendRouter);

export default router;
