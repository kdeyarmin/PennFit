// Patient routes — /patients list/create/detail/update/timeline + the
// nested admin-care routes:
//   - /patients/:id/notes      (list, create)
//   - /patients/:id/prescriptions (create) and /prescriptions/:rxId (status)
//   - /patients/import-csv     (bulk admin onboarding)

import { Router, type IRouter } from "express";

import createRouter from "./create";
import detailRouter from "./detail";
import importCsvRouter from "./import-csv";
import listRouter from "./list";
import notesCreateRouter from "./notes-create";
import notesListRouter from "./notes-list";
import prescriptionsCreateRouter from "./prescriptions-create";
import prescriptionsUpdateRouter from "./prescriptions-update";
import timelineRouter from "./timeline";
import updateRouter from "./update";

const router: IRouter = Router();
// Order matters: import-csv MUST be before detail/notes/prescriptions
// to avoid `:id` swallowing the literal "import-csv" segment.
router.use(importCsvRouter);
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
