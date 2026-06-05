// Compliance-rules routes — /compliance-rules CRUD.
//
// Per-payer CPAP adherence thresholds (migration 0212). Sibling of the
// frequency-rules (/rules) router; the rows here are resolved by
// resupply.resolve_compliance_thresholds() inside the therapy-fleet and
// setup-adherence RPCs.

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
