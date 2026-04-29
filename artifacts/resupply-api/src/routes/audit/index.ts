// Audit routes — /audit (paginated viewer).

import { Router, type IRouter } from "express";

import listRouter from "./list";
import exportRouter from "./export";

const router: IRouter = Router();
// More-specific path first: /audit/export.csv must be matched
// before any /audit catch-all in listRouter.
router.use(exportRouter);
router.use(listRouter);

export default router;
