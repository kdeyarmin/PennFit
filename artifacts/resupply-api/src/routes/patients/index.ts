// Patient routes — /patients (list) and /patients/:id (detail).

import { Router, type IRouter } from "express";

import createRouter from "./create";
import detailRouter from "./detail";
import listRouter from "./list";
import timelineRouter from "./timeline";
import updateRouter from "./update";

const router: IRouter = Router();
router.use(listRouter);
router.use(createRouter);
router.use(detailRouter);
router.use(timelineRouter);
router.use(updateRouter);

export default router;
