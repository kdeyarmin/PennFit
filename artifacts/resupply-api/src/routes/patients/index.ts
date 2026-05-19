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
import insuranceClaimsRouter from "./insurance-claims";
import insuranceClaimsSubmitRouter from "./insurance-claims-submit";
import insuranceClaimsHcfaRouter from "./insurance-claims-hcfa";
import insuranceClaimsPreflightRouter from "./insurance-claims-preflight";
import insuranceClaimsAiRouter from "./insurance-claims-ai";
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
// /patients/:id/insurance-claims — payer claim & EOB tracking
// (Tier-2 capture-only). Adds claim CRUD, per-HCPCS line items, and
// an append-only event history covering state transitions, EOB
// receipts, partial-pay reconciliation, and CSR notes. Mounted in
// the same band as prior-authorizations because they share the
// patient-scoped + HCPCS-keyed shape.
router.use(insuranceClaimsRouter);
// /patients/:id/insurance-claims/:claimId/submit-office-ally — builds
// the 837P EDI for a draft claim, uploads via the Office Ally
// adapter (SFTP in prod, file-drop in stub mode), persists the
// office_ally_submissions row, and advances the claim to 'submitted'.
// Mounted directly after the read/write claim router so the literal
// /submit-office-ally segment never gets shadowed by a future
// :something param route on the claim path.
router.use(insuranceClaimsSubmitRouter);
// /patients/:id/insurance-claims/:claimId/hcfa-1500.pdf — CMS-1500
// paper claim form generator for paper-only payers in the catalog
// (and one-off override cases).
router.use(insuranceClaimsHcfaRouter);
// /patients/:id/insurance-claims/:claimId/preflight — structured
// readiness checklist for a draft claim. Drives the "ready to
// submit" / "needs work" CSR UX in front of the submit endpoint.
router.use(insuranceClaimsPreflightRouter);
// /patients/:id/insurance-claims/:claimId/ai-{scrub,denial-analysis,...}
// — OpenAI-driven pre-submission scrub + post-denial root-cause +
// one-click auto-fix-and-resubmit. PHI-safe context assembly +
// whitelisted patch applier; the route never lets a hallucinated
// patch mutate non-whitelisted fields.
router.use(insuranceClaimsAiRouter);
// /patients/:id/equipment — clinical equipment asset registry
// (patient ↔ device serial-number link). Required for manufacturer
// recall workflows. Distinct from Pacware warehouse inventory.
router.use(equipmentRouter);
router.use(detailRouter);
router.use(timelineRouter);
router.use(updateRouter);

export default router;
