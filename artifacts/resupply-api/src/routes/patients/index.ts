// Patient routes — /patients list/create/detail/update/timeline + the
// nested admin-care routes:
//   - /patients/:id/notes      (list, create)
//   - /patients/:id/prescriptions (create) and /prescriptions/:rxId (status)
//   - /patients/import-csv     (bulk admin onboarding)

import { Router, type IRouter } from "express";

import bulkStatusRouter from "./bulk-status";
import createRouter from "./create";
import detailRouter from "./detail";
import exportCsvRouter from "./export-csv";
import importCsvRouter from "./import-csv";
import listRouter from "./list";
import notesCreateRouter from "./notes-create";
import notesListRouter from "./notes-list";
import prescriptionsCreateRouter from "./prescriptions-create";
import prescriptionsUpdateRouter from "./prescriptions-update";
import timelineRouter from "./timeline";
import updateRouter from "./update";

const router: IRouter = Router();
// Order matters: literal-segment routes MUST be registered BEFORE
// the `:id` parameter routes to avoid the param swallowing them.
// import-csv, export.csv, and bulk-status all start under /patients/
// with a literal segment that would otherwise be matched as `:id`.
router.use(importCsvRouter);
router.use(exportCsvRouter);
router.use(bulkStatusRouter);
router.use(listRouter);
router.use(createRouter);
router.use(notesListRouter);
router.use(notesCreateRouter);
router.use(prescriptionsCreateRouter);
router.use(prescriptionsUpdateRouter);
router.use(detailRouter);
router.use(timelineRouter);
router.use(updateRouter);

export default router;
