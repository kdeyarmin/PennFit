import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import meRouter from "./me.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);

export default router;
