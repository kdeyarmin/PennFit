// Demo handlers (batch 6) for the admin BILLING-CONFIG / PATIENT-ACTION
// surfaces. The fetch interceptor's empty `{}` fallback makes these
// pages crash (they map over arrays / read nested fields) or makes the
// prominent mutation buttons error, so each route below returns
// fully-shaped sample data matching the live API response (see the
// corresponding artifacts/resupply-api/src/routes/admin/*.ts route).
//
// Covers: patient payment-link send, portal-invite (send/resend/revoke),
// manual therapy-night entry, therapy-cloud sync (+ raw nights read),
// per-payer coverage-diagnosis overrides, fee-schedule CSV import,
// payer-profile catalog (list/detail/create/patch), physician fax
// outreach (list/create/retry), and prior-auth renewal-draft + request-
// form fax. The request-form PDF (GET) is intentionally NOT seeded —
// it's a binary stream.
//
// Paths the SPA already seeds elsewhere are NOT duplicated here:
// patient-detail.ts owns the per-patient `/therapy-snapshot`,
// `/resupply-summary`, `/timeline`, `/packets`, `/onboarding`,
// `/therapy-links`, `/same-or-similar`, `/cmn-documents`,
// `/eligibility-checks` sub-resources.
//
// DATA RULES: everything here is fictional demo data — obviously-fake
// patient/physician names, demo ids, 555 phones, fake fax numbers.
// Platform = CareMetric Breathe; tenant = Penn Home Medical Supply
// (pennpaps.com). Fresh relative dates via helpers. Money in cents.
// NO real PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, dateOnly } from "../fixtures/dates";

// ── Public storefront origin used in demo-returned links. ─────────────
const DEMO_BASE = "https://pennpaps.com";

// ── Payer profiles (payer-profiles.ts) ────────────────────────────────
// The catalog of PA payers. The SPA list filters on display_name / region
// / line-of-business; detail/create/patch round-trip the same shape.
interface DemoPayerProfile {
  id: string;
  slug: string;
  displayName: string;
  payerLegalName: string;
  parentOrg: string | null;
  lineOfBusiness: string;
  region: string;
  officeAllyPayerId: string | null;
  edi5010PayerId: string | null;
  claimFormat: string;
  paperOnly: boolean;
  requiresPriorAuthDme: boolean;
  requiresSignedPaperwork: boolean;
  priorAuthPhoneE164: string | null;
  claimStatusPhoneE164: string | null;
  providerPortalUrl: string | null;
  feeScheduleSource: string | null;
  notes: string | null;
  isActive: boolean;
  timelyFilingDays: number | null;
  claimsAddressLine1: string | null;
  claimsAddressLine2: string | null;
  claimsCity: string | null;
  claimsState: string | null;
  claimsZip: string | null;
  claimsPhoneE164: string | null;
  claimsFaxE164: string | null;
  priorAuthSubmissionMethod: string | null;
  priorAuthFaxE164: string | null;
  priorAuthTurnaroundBusinessDays: number | null;
  requiredClaimModifiers: string[];
  acceptsElectronicSecondary: boolean;
  ediEnrollmentStatus: string;
  memberIdFormatHint: string | null;
  requirementsLastVerifiedAt: string | null;
  requirementsLastVerifiedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function payerProfile(
  over: Partial<DemoPayerProfile> &
    Pick<DemoPayerProfile, "id" | "slug" | "displayName" | "payerLegalName">,
): DemoPayerProfile {
  return {
    parentOrg: null,
    lineOfBusiness: "commercial",
    region: "pa",
    officeAllyPayerId: null,
    edi5010PayerId: null,
    claimFormat: "837p",
    paperOnly: false,
    requiresPriorAuthDme: false,
    requiresSignedPaperwork: false,
    priorAuthPhoneE164: null,
    claimStatusPhoneE164: null,
    providerPortalUrl: null,
    feeScheduleSource: null,
    notes: null,
    isActive: true,
    timelyFilingDays: 365,
    claimsAddressLine1: null,
    claimsAddressLine2: null,
    claimsCity: null,
    claimsState: null,
    claimsZip: null,
    claimsPhoneE164: null,
    claimsFaxE164: null,
    priorAuthSubmissionMethod: null,
    priorAuthFaxE164: null,
    priorAuthTurnaroundBusinessDays: null,
    requiredClaimModifiers: [],
    acceptsElectronicSecondary: true,
    ediEnrollmentStatus: "enrolled",
    memberIdFormatHint: null,
    requirementsLastVerifiedAt: daysAgo(20),
    requirementsLastVerifiedBy: "demo.biller@pennfit.example",
    createdAt: daysAgo(220),
    updatedAt: daysAgo(20),
    ...over,
  };
}

const PAYER_PROFILES: DemoPayerProfile[] = [
  payerProfile({
    id: "demo-payer-0001",
    slug: "demo_keystone_health",
    displayName: "Demo Keystone Health Plan",
    payerLegalName: "Demo Keystone Health Plan East, Inc.",
    parentOrg: "Demo Independence Group",
    lineOfBusiness: "commercial",
    officeAllyPayerId: "DEMO01",
    edi5010PayerId: "54704",
    requiresPriorAuthDme: true,
    requiresSignedPaperwork: true,
    priorAuthPhoneE164: "+15555550110",
    claimStatusPhoneE164: "+15555550111",
    providerPortalUrl: "https://providers.demo-keystone.example",
    feeScheduleSource: "Demo Keystone DME fee schedule (2026 Q2)",
    timelyFilingDays: 180,
    claimsAddressLine1: "PO Box 1000",
    claimsCity: "Philadelphia",
    claimsState: "PA",
    claimsZip: "19101",
    claimsPhoneE164: "+15555550111",
    claimsFaxE164: "+15555550112",
    priorAuthSubmissionMethod: "fax",
    priorAuthFaxE164: "+15555550113",
    priorAuthTurnaroundBusinessDays: 5,
    requiredClaimModifiers: ["NU", "KX"],
    memberIdFormatHint: "10 digits, no dashes",
  }),
  payerProfile({
    id: "demo-payer-0002",
    slug: "demo_pa_medicaid_mco",
    displayName: "Demo PA Medicaid MCO",
    payerLegalName: "Demo Community HealthChoices, LLC",
    lineOfBusiness: "medicaid_mco",
    officeAllyPayerId: "DEMO02",
    edi5010PayerId: "23284",
    requiresPriorAuthDme: true,
    requiresSignedPaperwork: true,
    priorAuthPhoneE164: "+15555550120",
    priorAuthSubmissionMethod: "portal",
    providerPortalUrl: "https://providers.demo-pamco.example",
    priorAuthTurnaroundBusinessDays: 3,
    timelyFilingDays: 365,
    requiredClaimModifiers: ["KX"],
    memberIdFormatHint: "PA recipient ID, 10 digits",
  }),
  payerProfile({
    id: "demo-payer-0003",
    slug: "demo_medicare_part_b",
    displayName: "Demo Medicare Part B (Novitas)",
    payerLegalName: "Demo Novitas Solutions, Inc.",
    lineOfBusiness: "medicare_part_b",
    region: "national",
    officeAllyPayerId: "DEMO03",
    edi5010PayerId: "12502",
    requiresPriorAuthDme: false,
    feeScheduleSource: "CMS DMEPOS fee schedule (2026)",
    timelyFilingDays: 365,
    requiredClaimModifiers: ["NU", "KX"],
    memberIdFormatHint: "MBI: 11 chars, alphanumeric",
  }),
  payerProfile({
    id: "demo-payer-0004",
    slug: "demo_workers_comp",
    displayName: "Demo Workers Comp Carrier",
    payerLegalName: "Demo Liberty Indemnity Co.",
    lineOfBusiness: "workers_comp",
    paperOnly: true,
    claimFormat: "paper_1500",
    acceptsElectronicSecondary: false,
    ediEnrollmentStatus: "not_applicable",
    claimsAddressLine1: "PO Box 2200",
    claimsCity: "Harrisburg",
    claimsState: "PA",
    claimsZip: "17101",
    claimsFaxE164: "+15555550130",
    isActive: true,
  }),
];

function listPayerProfiles(q: {
  region?: string;
  lob?: string;
  active?: string;
  search?: string;
}): DemoPayerProfile[] {
  let rows = PAYER_PROFILES;
  if (q.region) rows = rows.filter((r) => r.region === q.region);
  if (q.lob) rows = rows.filter((r) => r.lineOfBusiness === q.lob);
  if (q.active === "true") rows = rows.filter((r) => r.isActive);
  if (q.active === "false") rows = rows.filter((r) => !r.isActive);
  if (q.search) {
    const needle = q.search.toLowerCase();
    rows = rows.filter((r) => r.displayName.toLowerCase().includes(needle));
  }
  return rows;
}

// ── Per-payer coverage-diagnosis overrides (payer-coverage-diagnoses.ts)
// GET .../payer-coverage-diagnoses?payerProfileId= → { overrides: [...] }
function coverageOverrides(payerProfileId: string) {
  // Only the first demo payer carries overrides; others return empty so
  // the "national default applies" notice renders for them.
  if (payerProfileId !== "demo-payer-0001") return { overrides: [] };
  return {
    overrides: [
      {
        id: "demo-cov-0001",
        hcpcsCode: "E0601",
        icd10Code: "G4733",
        description: "Obstructive sleep apnea (adult)",
        policy: "Payer policy",
        active: true,
      },
      {
        id: "demo-cov-0002",
        hcpcsCode: "E0601",
        icd10Code: "G4730",
        description: "Sleep apnea, unspecified",
        policy: "Payer policy",
        active: true,
      },
      {
        id: "demo-cov-0003",
        hcpcsCode: "E0470",
        icd10Code: "G4736",
        description: "Sleep related hypoventilation",
        policy: "Payer policy",
        active: true,
      },
    ],
  };
}

// ── Physician fax outreach (physician-fax-outreach.ts) ────────────────
// GET .../physician-fax-outreach?patientId= → { outreach, providerConfigured }
function faxOutreach(patientId: string) {
  return {
    outreach: [
      {
        id: "demo-fax-0001",
        patientId,
        prescriptionId: "demo-rx-0001",
        physicianName: "Dr. Demo Prescriber",
        physicianFaxE164: "+15555550201",
        status: "delivered",
        vendorRef: "demo-telnyx-ref-0001",
        vendorName: "telnyx",
        sentAt: daysAgo(4),
        deliveredAt: daysAgo(4),
        failedAt: null,
        failureReason: null,
        createdByEmail: "demo.csr@pennfit.example",
        createdAt: daysAgo(4),
      },
      {
        id: "demo-fax-0002",
        patientId,
        prescriptionId: null,
        physicianName: "Dr. Sample Physician",
        physicianFaxE164: "+15555550202",
        status: "failed",
        vendorRef: null,
        vendorName: "telnyx",
        sentAt: null,
        deliveredAt: null,
        failedAt: daysAgo(1),
        failureReason: "No answer at destination fax (demo).",
        createdByEmail: "demo.csr@pennfit.example",
        createdAt: daysAgo(1),
      },
    ],
    // Demo runs with no live Telnyx creds — surface the "not configured"
    // badge so the UI reflects the offline-vendor path.
    providerConfigured: false,
  };
}

// ── Raw therapy nights read (patient-therapy-sync.ts GET) ─────────────
// GET .../patients/:id/therapy-nights → { nights: [...] }
function therapyNights() {
  const night = (
    offset: number,
    usageMinutes: number,
    ahi: number,
    leak: number,
  ) => ({
    id: `demo-night-${Math.abs(offset)}`,
    nightDate: dateOnly(offset),
    source: "resmed_airview",
    usageMinutes,
    ahi,
    leakRateLMin: leak,
    pressureP95Cmh2o: 9.4,
  });
  return {
    nights: [
      night(-1, 421, 3.1, 11),
      night(-2, 388, 4.0, 14),
      night(-3, 210, 6.2, 33),
      night(-4, 402, 3.6, 12),
      night(-5, 365, 4.4, 19),
    ],
  };
}

export const ext6Handlers: DemoHandler[] = [
  // ── Patient payment link (POST action) ──────────────────────────────
  // Returns the route's real result shape, including a copy-able demo URL.
  route(
    "POST",
    "/resupply-api/admin/patients/:id/payment-link",
    (req, { id }) => {
      const body = req.json<{
        channel?: "email" | "sms";
        amountCents?: number;
      }>();
      const channel = body?.channel === "sms" ? "sms" : "email";
      const amountCents =
        typeof body?.amountCents === "number" ? body.amountCents : 4500;
      return json(
        {
          paymentId: `demo-pay-${id.slice(0, 8)}`,
          channel,
          delivered: true,
          deliveryError: null,
          amountCents,
          paymentUrl: `${DEMO_BASE}/pay/demo-checkout-session`,
        },
        201,
      );
    },
  ),

  // ── Patient portal invite (POST/resend/revoke) ──────────────────────
  // `/resend` MUST precede the bare `/portal-invite` matcher.
  route("POST", "/resupply-api/admin/patients/:id/portal-invite/resend", () =>
    json({
      portalStatus: "pending",
      emailSent: true,
      inviteLink: null,
    }),
  ),
  route("POST", "/resupply-api/admin/patients/:id/portal-invite", () =>
    json(
      {
        portalAuthUserId: "demo-portal-user-0001",
        portalStatus: "pending",
        emailSent: true,
        inviteLink: null,
      },
      201,
    ),
  ),
  route("DELETE", "/resupply-api/admin/patients/:id/portal-invite", () =>
    json({ portalStatus: "not_invited" }),
  ),

  // ── Manual therapy-night entry (POST) ───────────────────────────────
  route("POST", "/resupply-api/admin/patients/:id/therapy-nights", () =>
    json({ id: "demo-night-manual-0001" }, 201),
  ),

  // ── Therapy-cloud sync (raw nights read + POST sync) ────────────────
  // `/sync` MUST precede the bare `/therapy-nights` matcher.
  route(
    "POST",
    "/resupply-api/admin/patients/:id/therapy-nights/sync",
    (req) => {
      const body = req.json<{ source?: string; sinceDate?: string }>();
      const source = body?.source ?? "resmed_airview";
      const sinceDate = body?.sinceDate ?? dateOnly(-60);
      return json({ imported: 18, sinceDate, source });
    },
  ),
  route("GET", "/resupply-api/admin/patients/:id/therapy-nights", () =>
    json(therapyNights()),
  ),

  // ── Payer coverage-diagnosis overrides (list/create/delete) ─────────
  route("GET", "/resupply-api/admin/payer-coverage-diagnoses", (req) =>
    json(coverageOverrides(req.query.get("payerProfileId") ?? "")),
  ),
  route("POST", "/resupply-api/admin/payer-coverage-diagnoses", () =>
    json({ id: "demo-cov-00ff" }, 201),
  ),
  route(
    "DELETE",
    "/resupply-api/admin/payer-coverage-diagnoses/:id",
    () => new Response(null, { status: 204 }),
  ),

  // ── Payer fee-schedule CSV import (POST) ────────────────────────────
  route("POST", "/resupply-api/admin/payer-fee-schedules/import-csv", () =>
    json({ accepted: 24, errors: [] }, 201),
  ),

  // ── Payer profiles (list/detail/create/patch) ───────────────────────
  // Detail `/:id` must NOT shadow `/export.csv`; that path is a CSV
  // stream (skipped here) so it falls through to the router fallback.
  route("GET", "/resupply-api/admin/payer-profiles", (req) =>
    json({
      payerProfiles: listPayerProfiles({
        region: req.query.get("region") ?? undefined,
        lob: req.query.get("lineOfBusiness") ?? undefined,
        active: req.query.get("active") ?? undefined,
        search: req.query.get("q") ?? undefined,
      }),
    }),
  ),
  route("GET", "/resupply-api/admin/payer-profiles/:id", (_req, { id }) => {
    const found = PAYER_PROFILES.find((p) => p.id === id) ?? PAYER_PROFILES[0];
    return json({ payerProfile: found });
  }),
  route("POST", "/resupply-api/admin/payer-profiles", () =>
    json({ id: "demo-payer-00ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/payer-profiles/:id", () =>
    json({ ok: true }),
  ),

  // ── Physician fax outreach (list/create/retry) ──────────────────────
  route("GET", "/resupply-api/admin/physician-fax-outreach", (req) =>
    json(faxOutreach(req.query.get("patientId") ?? "demo-p-2004")),
  ),
  route("POST", "/resupply-api/admin/physician-fax-outreach", () =>
    json(
      {
        id: "demo-fax-00ff",
        // Demo has no live Telnyx creds — the row is created but pending.
        status: "pending",
        provider: "not_configured",
      },
      201,
    ),
  ),
  route(
    "POST",
    "/resupply-api/admin/physician-fax-outreach/:id/retry",
    (_req, { id }) =>
      json({ id, status: "pending", provider: "not_configured" }),
  ),

  // ── Prior-auth renewal draft (POST) ─────────────────────────────────
  route(
    "POST",
    "/resupply-api/admin/prior-authorizations/:id/draft-renewal",
    (_req, { id }) =>
      json({ id: "demo-pa-renewal-00ff", sourcePriorAuthId: id }, 201),
  ),

  // ── Prior-auth request-form fax (POST) ──────────────────────────────
  // The GET request-form endpoint streams a PDF — intentionally NOT
  // seeded; only the JSON fax action is.
  route(
    "POST",
    "/resupply-api/admin/patients/:id/prior-authorizations/:paId/fax",
    () => json({ ok: true, vendorRef: "demo-telnyx-ref-pa-0001" }),
  ),
];
