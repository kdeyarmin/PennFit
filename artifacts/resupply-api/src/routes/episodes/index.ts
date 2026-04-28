// Episode routes — /episodes (list / overdue queue).

import { Router, type IRouter } from "express";

import listRouter from "./list";

const router: IRouter = Router();
router.use(listRouter);

export default router;
