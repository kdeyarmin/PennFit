// Frequency-rules routes — /rules CRUD.

import { Router, type IRouter } from "express";

import createRouter from "./create";
import deleteRouter from "./delete";
import listRouter from "./list";
import updateRouter from "./update";

const router: IRouter = Router();
router.use(listRouter);
router.use(createRouter);
router.use(updateRouter);
router.use(deleteRouter);

export default router;
