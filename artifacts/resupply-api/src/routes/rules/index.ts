// Frequency-rules routes — /rules CRUD.

import { Router, type IRouter } from "express";

import createRouter from "./create";
import deleteRouter from "./delete";
import listRouter from "./list";
import testRouter from "./test";
import updateRouter from "./update";

const router: IRouter = Router();
router.use(listRouter);
router.use(createRouter);
router.use(updateRouter);
router.use(deleteRouter);
router.use(testRouter);

export default router;
