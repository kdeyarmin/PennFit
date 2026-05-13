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
import followupsRouter from "./followups";
import notesCreateRouter from "./notes-create";
import notesListRouter from "./notes-list";
import prescriptionsAttachmentRouter from "./prescriptions-attachment";
import patientDocumentsRouter from "./patient-documents";
import prescriptionsCreateRouter from "./prescriptions-create";
import prescriptionsUpdateRouter from "./prescriptions-update";
import sleepStudiesRouter from "./sleep-studies";
import insuranceCoveragesRouter from "./insurance-coverages";
import priorAuthorizationsRouter from "./prior-authorizations";
import equipmentRouter from "./equipment";
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
// /patients/:id/followups — CSR-scheduled callback reminders (Phase 19).
// Mounted alongside the notes routers since they share the same
// "literal-segment-after-:id" pattern and shouldn't be swallowed by
// the detail/timeline param routes.
router.use(followupsRouter);
router.use(prescriptionsCreateRouter);
router.use(prescriptionsUpdateRouter);
// Attachment routes — admin-only, prescription-scoped object-storage
// upload/download/delete. Mounted after the create/update so the
// /attachment literal segment can never collide with a future
// :rxId-style param route on the same prefix.
router.use(prescriptionsAttachmentRouter);
// /patients/:id/documents — admin-facing list/download/delete of
// patient-uploaded documents (insurance cards, prescriptions, etc.).
router.use(patientDocumentsRouter);
// /patients/:id/sleep-studies — diagnostic sleep-study records that
// document OSA diagnosis under Medicare LCD L33718. See
// patients/sleep-studies.ts for the full state machine.
router.use(sleepStudiesRouter);
// /patients/:id/insurance-coverages — verified payer coverage
// records (capture-only in this Tier-2a sprint).
router.use(insuranceCoveragesRouter);
// /patients/:id/prior-authorizations — payer auths to dispense a
// specific HCPCS for a specific patient (capture-only in 2a).
router.use(priorAuthorizationsRouter);
// /patients/:id/equipment — clinical equipment asset registry
// (patient ↔ device serial-number link). Required for manufacturer
// recall workflows. Distinct from Pacware warehouse inventory.
router.use(equipmentRouter);
router.use(detailRouter);
router.use(timelineRouter);
router.use(updateRouter);

export default router;
