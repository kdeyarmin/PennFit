// Demo handlers for the PATIENT CLINICAL DETAIL tabs and CSR admin
// tools. These seed the per-patient sub-resources (therapy snapshot,
// resupply summary, timeline, packets, onboarding, therapy links,
// same-or-similar, CMN, eligibility) plus the CSR note/timeline and
// signature-tracking surfaces, so the patient-detail tabs render with
// realistic sample data instead of falling through to the router's
// benign empty fallback.
//
// Patient ids are aligned to the `demo-patient-N` roster owned by
// `handlers/admin.ts` (which seeds the patient list + detail). This
// module intentionally does NOT touch the paths admin.ts already owns
// (`/resupply-api/patients` + `/resupply-api/patients/:id`).
//
// Each handler matches the FULL client path (the SPA's admin API
// clients call `/resupply-api/admin/...` absolute paths) and returns a
// shape matched against the live route under
// `artifacts/resupply-api/src/routes/admin/*`.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoTherapySnapshot,
  demoResupplySummary,
  demoPatientTimeline,
  demoManualDocuments,
  demoManualDocumentsCatalog,
  demoManualDocumentsStandardCatalog,
  demoPatientPackets,
  demoCustomerNotes,
  demoCustomerTimeline,
  demoOrderNotes,
  demoPatientOnboarding,
  demoPatientOnboardingAttempts,
  demoTherapyLinks,
  demoSameOrSimilar,
  demoCmnDocuments,
  demoCmnCatalog,
  demoEligibilityChecks,
  demoSignatureTracking,
} from "../fixtures/patient-detail";

export const patientDetailHandlers: DemoHandler[] = [
  // ── therapy + resupply summaries ─────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/patients/:id/therapy-snapshot",
    (_req, { id }) => json(demoTherapySnapshot(id)),
  ),
  route(
    "GET",
    "/resupply-api/admin/patients/:id/resupply-summary",
    (_req, { id }) => json(demoResupplySummary(id)),
  ),
  route("GET", "/resupply-api/admin/patients/:id/timeline", (_req, { id }) =>
    json(demoPatientTimeline(id)),
  ),

  // ── manual documents (catalogs MUST precede the list match) ──────
  route("GET", "/resupply-api/admin/manual-documents/catalog", () =>
    json(demoManualDocumentsCatalog()),
  ),
  route("GET", "/resupply-api/admin/manual-documents/standard-catalog", () =>
    json(demoManualDocumentsStandardCatalog()),
  ),
  route("GET", "/resupply-api/admin/manual-documents", () =>
    json(demoManualDocuments()),
  ),

  // ── patient signature packets ────────────────────────────────────
  route("GET", "/resupply-api/admin/patients/:id/packets", (_req, { id }) =>
    json(demoPatientPackets(id)),
  ),
  route("GET", "/resupply-api/admin/patient-packets", () =>
    json(demoPatientPackets()),
  ),

  // ── CSR notes + cross-channel timelines ──────────────────────────
  route(
    "GET",
    "/resupply-api/admin/shop/customers/:userId/notes",
    (_req, { userId }) => json(demoCustomerNotes(userId)),
  ),
  route(
    "GET",
    "/resupply-api/admin/shop/customers/:customerId/timeline",
    (_req, { customerId }) => json(demoCustomerTimeline(customerId)),
  ),
  route(
    "GET",
    "/resupply-api/admin/shop/orders/:orderId/notes",
    (_req, { orderId }) => json(demoOrderNotes(orderId)),
  ),

  // ── onboarding (first-90-day coaching) ───────────────────────────
  // `/onboarding/attempts` MUST precede `/onboarding` so the more
  // specific path wins (both are single-segment-after matches).
  route(
    "GET",
    "/resupply-api/admin/patients/:id/onboarding/attempts",
    (_req, { id }) => json(demoPatientOnboardingAttempts(id)),
  ),
  route("GET", "/resupply-api/admin/patients/:id/onboarding", (_req, { id }) =>
    json(demoPatientOnboarding(id)),
  ),

  // ── therapy-cloud links ──────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/patients/:id/therapy-links",
    (_req, { id }) => json(demoTherapyLinks(id)),
  ),

  // ── Medicare same-or-similar ─────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/patients/:id/same-or-similar",
    (_req, { id }) => json(demoSameOrSimilar(id)),
  ),

  // ── CMN / DIF structured documents ───────────────────────────────
  route("GET", "/resupply-api/admin/billing/cmn-catalog", () =>
    json(demoCmnCatalog()),
  ),
  route(
    "GET",
    "/resupply-api/admin/patients/:id/cmn-documents",
    (_req, { id }) => json(demoCmnDocuments(id)),
  ),

  // ── eligibility (270/271) checks ─────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/patients/:id/eligibility-checks",
    (_req, { id }) => json(demoEligibilityChecks(id)),
  ),

  // ── signature tracking dashboard ─────────────────────────────────
  route("GET", "/resupply-api/admin/signature-tracking", () =>
    json(demoSignatureTracking()),
  ),
];
