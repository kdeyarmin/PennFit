// seed-sample-data — populate a NON-PRODUCTION database with clearly
// marked sample data so the team can exercise the storefront/account
// chatbot, the admin console (customers, orders, subscriptions, the CSR
// inbox), and the patients list end to end.
//
// Run with:
//   ALLOW_SAMPLE_SEED=1 \
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//   pnpm --filter @workspace/scripts seed:sample
//
// Flags:
//   --dry-run        Print what would be written; touch nothing.
//   --clean          Remove previously-seeded sample rows, then exit.
//   --no-logins      Skip creating sign-in-able auth users (data only).
//   --password=...   Password for the sample customer logins
//                    (default: SampleTest123!).
//   --force          Bypass the production guard (use with care).
//
// What it creates (every value is fictional and marked "(test)" /
// "@example.com" so it can never be mistaken for real PHI):
//   * 3 shop customers — Alex (3 orders + active sub + a CSR thread),
//     Jordan (1 delivered order + a paused sub), Casey (brand-new,
//     nothing on file). Each gets a saved CPAP device where it makes
//     sense, so get_my_device / get_my_recent_orders / etc. return data.
//   * Matching shop_orders + shop_order_items + shop_subscriptions.
//   * One in-app conversation with a CSR reply (so the account
//     assistant's escalate_to_human lands somewhere visible and the
//     /account → Messages thread isn't empty).
//   * 2 sample patients for the admin patients list.
//   * 2 signature packets for those patients — one completed (with
//     acknowledged documents + a captured signature) and one still
//     outstanding — so /admin/patient-packets and the packets tab on a
//     patient chart aren't empty.
//   * 2 chart documents (a reviewed sleep study, an unreviewed insurance
//     card) so /admin/patients/:id Documents lists real rows. Placeholder
//     file bytes are uploaded to the private bucket so the documents are
//     actually downloadable (not just metadata).
//   * Additional admin-surface rows so the most prominent worklists aren't
//     empty: patient chart notes, insurance coverages, prescriptions, a
//     referral-inbox review, a shop customer note, and a shop return.
//
// All sample rows are tagged with the seed tenant's org_id
// (organizations.slug = SEED_ORG_SLUG); every table here is
// tenant-scoped (NOT NULL org_id) on the multi-tenant schema, so the
// seed resolves the tenant first and fails fast if it isn't onboarded.
//   By default each customer also gets a real auth login (role
//   "customer", status active, email verified) so you can actually sign
//   in as them and chat with the account assistant.
//
// Idempotent: every row uses a fixed id / natural key and is upserted,
// so re-running updates in place rather than duplicating. `--clean`
// removes the data rows (auth users are left in place — harmless, and
// deleting auth rows is out of scope for a seeder).
//
// Production guard: refuses to run unless ALLOW_SAMPLE_SEED=1 (or
// --force) is set, so it can never silently scribble fake data into a
// real environment.

import {
  getSupabaseServiceRoleClient,
  resolveSeedOrgId,
  SEED_ORG_SLUG,
} from "@workspace/resupply-db";
import {
  hashPassword,
  normalizeEmail,
  supabaseAuthRepository,
  writeUserChosenPassword,
} from "@workspace/resupply-auth";

const TAG = "[seed:sample]";
function out(msg: string): void {
  process.stdout.write(`${TAG} ${msg}\n`);
}
function fail(msg: string): never {
  process.stderr.write(`${TAG} ${msg}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const clean = args.includes("--clean");
const withLogins = !args.includes("--no-logins");
const force = args.includes("--force");
const password =
  args.find((a) => a.startsWith("--password="))?.slice("--password=".length) ||
  "SampleTest123!";

// Production guard. Seeding fake data is never something we want to
// happen by accident against a real environment, so require an explicit
// opt-in. --dry-run is always allowed (it writes nothing).
if (!dryRun && !force && process.env.ALLOW_SAMPLE_SEED !== "1") {
  fail(
    "refusing to write sample data without ALLOW_SAMPLE_SEED=1 (or --force). " +
      "Re-run with ALLOW_SAMPLE_SEED=1 once you've confirmed this is a " +
      "dev/preview database. (--dry-run needs no opt-in.)",
  );
}

const nowIso = new Date().toISOString();
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

// ── Sample dataset (fixed ids → idempotent upserts) ─────────────────

interface SampleCustomer {
  customerId: string;
  // Set only after a login is successfully created (ensureLogin). Stays
  // null otherwise — shop_customers.auth_user_id is an FK to
  // resupply_auth.users(id), so a placeholder/dangling id would fail the
  // FK and abort the seed.
  authUserId: string | null;
  email: string;
  displayName: string;
  phoneE164: string;
  device: {
    manufacturer: string;
    model: string;
    pressureSetting: string;
  } | null;
  shipping: {
    name: string;
    line1: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
}

const CUSTOMERS: SampleCustomer[] = [
  {
    customerId: "sample-cust-alex",
    authUserId: null,
    email: "sample.alex@example.com",
    displayName: "Alex Sample (test)",
    phoneE164: "+18145550101",
    device: {
      manufacturer: "ResMed",
      model: "AirSense 11",
      pressureSetting: "9 cmH2O",
    },
    shipping: {
      name: "Alex Sample",
      line1: "100 Test Street",
      city: "Altoona",
      state: "PA",
      postal_code: "16601",
      country: "US",
    },
  },
  {
    customerId: "sample-cust-jordan",
    authUserId: null,
    email: "sample.jordan@example.com",
    displayName: "Jordan Sample (test)",
    phoneE164: "+18145550102",
    device: {
      manufacturer: "Philips",
      model: "DreamStation 2",
      pressureSetting: "11 cmH2O",
    },
    shipping: {
      name: "Jordan Sample",
      line1: "200 Example Ave",
      city: "State College",
      state: "PA",
      postal_code: "16801",
      country: "US",
    },
  },
  {
    customerId: "sample-cust-casey",
    authUserId: null,
    email: "sample.casey@example.com",
    displayName: "Casey Sample (test)",
    phoneE164: "+18145550103",
    device: null,
    shipping: {
      name: "Casey Sample",
      line1: "300 Sample Blvd",
      city: "Hollidaysburg",
      state: "PA",
      postal_code: "16648",
      country: "US",
    },
  },
];

interface SampleOrder {
  id: string;
  customerId: string;
  sessionId: string;
  status: string;
  amountTotalCents: number;
  paidAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  items: Array<{
    productId: string;
    quantity: number;
    unitAmountCents: number;
  }>;
}

const ORDERS: SampleOrder[] = [
  {
    id: "5a3b1e00-0a00-4000-8000-000000000101",
    customerId: "sample-cust-alex",
    sessionId: "cs_test_sample_alex_1",
    status: "paid",
    amountTotalCents: 4295,
    paidAt: daysAgo(40),
    shippedAt: daysAgo(39),
    deliveredAt: daysAgo(37),
    trackingCarrier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    items: [
      { productId: "airfit-p10-cushion", quantity: 1, unitAmountCents: 1995 },
      {
        productId: "disposable-filters-2pk",
        quantity: 1,
        unitAmountCents: 2300,
      },
    ],
  },
  {
    id: "5a3b1e00-0a00-4000-8000-000000000102",
    customerId: "sample-cust-alex",
    sessionId: "cs_test_sample_alex_2",
    status: "paid",
    amountTotalCents: 3200,
    paidAt: daysAgo(8),
    shippedAt: daysAgo(7),
    deliveredAt: null,
    trackingCarrier: "USPS",
    trackingNumber: "9400111899223344556677",
    items: [
      { productId: "standard-tubing", quantity: 1, unitAmountCents: 3200 },
    ],
  },
  {
    id: "5a3b1e00-0a00-4000-8000-000000000103",
    customerId: "sample-cust-alex",
    sessionId: "cs_test_sample_alex_3",
    status: "paid",
    amountTotalCents: 1995,
    paidAt: daysAgo(1),
    shippedAt: null,
    deliveredAt: null,
    trackingCarrier: null,
    trackingNumber: null,
    items: [
      { productId: "airfit-p10-cushion", quantity: 1, unitAmountCents: 1995 },
    ],
  },
  {
    id: "5a3b1e00-0a00-4000-8000-000000000201",
    customerId: "sample-cust-jordan",
    sessionId: "cs_test_sample_jordan_1",
    status: "paid",
    amountTotalCents: 5400,
    paidAt: daysAgo(20),
    shippedAt: daysAgo(19),
    deliveredAt: daysAgo(16),
    trackingCarrier: "FedEx",
    trackingNumber: "770012345678",
    items: [
      { productId: "dreamwear-full-face", quantity: 1, unitAmountCents: 5400 },
    ],
  },
];

interface SampleSubscription {
  id: string;
  customerId: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  items: Array<{
    name: string;
    quantity: number;
    unitAmountCents: number;
    currency: string;
    intervalLabel: string;
  }>;
}

const SUBSCRIPTIONS: SampleSubscription[] = [
  {
    id: "5a3b1e00-0b00-4000-8000-000000000301",
    customerId: "sample-cust-alex",
    stripeSubscriptionId: "sub_sample_alex_1",
    status: "active",
    currentPeriodEnd: daysFromNow(50),
    cancelAtPeriodEnd: false,
    items: [
      {
        name: "AirFit P10 cushion",
        quantity: 1,
        unitAmountCents: 1995,
        currency: "usd",
        intervalLabel: "every 90 days",
      },
    ],
  },
  {
    id: "5a3b1e00-0b00-4000-8000-000000000302",
    customerId: "sample-cust-jordan",
    stripeSubscriptionId: "sub_sample_jordan_1",
    status: "paused",
    currentPeriodEnd: daysFromNow(12),
    cancelAtPeriodEnd: false,
    items: [
      {
        name: "DreamWear full-face cushion",
        quantity: 1,
        unitAmountCents: 2400,
        currency: "usd",
        intervalLabel: "every 90 days",
      },
    ],
  },
];

const CONVERSATION = {
  id: "5a3b1e00-0c00-4000-8000-000000000401",
  customerId: "sample-cust-alex",
  messages: [
    {
      id: "5a3b1e00-0d00-4000-8000-000000000501",
      direction: "inbound" as const,
      senderRole: "customer" as const,
      body: "Hi — my new cushion seems to leak around the bridge of my nose. Can you help?",
      createdAt: daysAgo(3),
    },
    {
      id: "5a3b1e00-0d00-4000-8000-000000000502",
      direction: "outbound" as const,
      senderRole: "admin" as const,
      body: "Happy to help! Let's try a smaller cushion size — I can send one under the comfort guarantee. Want me to ship it?",
      createdAt: daysAgo(2),
    },
  ],
};

interface SamplePatient {
  id: string;
  pacwareId: string;
  firstName: string;
  lastName: string;
  dob: string;
  phoneE164: string;
  email: string;
}

const PATIENTS: SamplePatient[] = [
  {
    id: "5a3b1e00-0e00-4000-8000-000000000601",
    pacwareId: "SAMPLE-PT-001",
    firstName: "Pat",
    lastName: "Testpatient",
    dob: "1955-04-12",
    phoneE164: "+18145550201",
    email: "sample.pat@example.com",
  },
  {
    id: "5a3b1e00-0e00-4000-8000-000000000602",
    pacwareId: "SAMPLE-PT-002",
    firstName: "Sam",
    lastName: "Exampleton",
    dob: "1968-09-30",
    phoneE164: "+18145550202",
    email: "sample.sam@example.com",
  },
];

// Email recorded as the packet's sender. Plain text (no FK) — clearly
// fictional so it can't be mistaken for a real operator.
const SEED_ADMIN_EMAIL = "demo.admin@example.com";

// Packet document content version. Matches the live template version
// (`V` in artifacts/resupply-api/src/lib/patient-packet/templates.ts) so
// the seeded snapshots line up with the current catalog; if the catalog
// version bumps, these are still valid historical snapshots.
const PACKET_CONTENT_VERSION = "2026-06-06.v1";

type PatientPacketStatus = "draft" | "sent" | "viewed" | "completed";

interface SamplePacketDocument {
  id: string;
  documentKey: string;
  title: string;
  sortOrder: number;
  requiresSignature: boolean;
}

interface SamplePacket {
  id: string;
  patientId: string;
  title: string;
  status: PatientPacketStatus;
  recipientName: string;
  recipientEmail: string;
  recipientPhone: string;
  sentAt: string;
  firstViewedAt: string | null;
  completedAt: string | null;
  documents: SamplePacketDocument[];
  // Present only on completed packets.
  signature: {
    id: string;
    signerName: string;
    signerRelationship: string;
    signedAt: string;
  } | null;
}

// The standard onboarding document set (a subset of the live catalog —
// the welcome letter plus the two acknowledgement documents).
const ONBOARDING_DOCS: Omit<SamplePacketDocument, "id">[] = [
  {
    documentKey: "welcome_instructions",
    title: "Welcome & Equipment Use Instructions",
    sortOrder: 0,
    requiresSignature: false,
  },
  {
    documentKey: "assignment_of_benefits",
    title: "Assignment of Benefits & Authorization to Bill Insurance",
    sortOrder: 1,
    requiresSignature: true,
  },
  {
    documentKey: "notice_of_privacy_practices",
    title: "Notice of Privacy Practices — Acknowledgement of Receipt",
    sortOrder: 2,
    requiresSignature: true,
  },
];

const PACKETS: SamplePacket[] = [
  {
    // Completed onboarding packet for Pat — has acknowledged documents
    // and a captured signature, so the packet detail view is fully
    // populated.
    id: "5a3b1e00-0f00-4000-8000-000000000701",
    patientId: "5a3b1e00-0e00-4000-8000-000000000601",
    title: "Welcome packet — Pat Testpatient",
    status: "completed",
    recipientName: "Pat Testpatient",
    recipientEmail: "sample.pat@example.com",
    recipientPhone: "+18145550201",
    sentAt: daysAgo(10),
    firstViewedAt: daysAgo(9),
    completedAt: daysAgo(9),
    documents: ONBOARDING_DOCS.map((d, i) => ({
      ...d,
      id: `5a3b1e00-1000-4000-8000-0000000007${(10 + i).toString(16).padStart(2, "0")}`,
    })),
    signature: {
      id: "5a3b1e00-1100-4000-8000-000000000901",
      signerName: "Pat Testpatient",
      signerRelationship: "self",
      signedAt: daysAgo(9),
    },
  },
  {
    // Outstanding packet for Sam — sent and viewed but not yet signed,
    // so it shows up in the "awaiting signature" worklist.
    id: "5a3b1e00-0f00-4000-8000-000000000702",
    patientId: "5a3b1e00-0e00-4000-8000-000000000602",
    title: "Onboarding documents — Sam Exampleton",
    status: "viewed",
    recipientName: "Sam Exampleton",
    recipientEmail: "sample.sam@example.com",
    recipientPhone: "+18145550202",
    sentAt: daysAgo(2),
    firstViewedAt: daysAgo(1),
    completedAt: null,
    documents: ONBOARDING_DOCS.map((d, i) => ({
      ...d,
      id: `5a3b1e00-1000-4000-8000-0000000007${(20 + i).toString(16).padStart(2, "0")}`,
    })),
    signature: null,
  },
];

// Tiny but structurally-valid placeholder file bytes so the seeded chart
// documents actually open in the admin viewer instead of 404-ing. The
// download path streams whatever bytes live in storage and sets the
// content-type from the DB row, so a minimal PDF / 1×1 JPEG is enough.
const SAMPLE_PDF_BYTES = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
    "",
  ].join("\n"),
  "utf8",
);
// A valid 1×1-pixel baseline JPEG.
const SAMPLE_JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
    "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
    "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==",
  "base64",
);

interface SampleChartDocument {
  id: string;
  patientId: string;
  /** Canonical `/objects/<path>` key the download endpoint resolves;
   *  the bytes are uploaded to `<path>` in the private bucket. */
  objectKey: string;
  documentType: string;
  filename: string;
  contentType: string;
  /** Placeholder bytes uploaded to storage so the file is downloadable. */
  bytes: Buffer;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

const CHART_DOCUMENTS: SampleChartDocument[] = [
  {
    // Reviewed sleep study on Pat's chart.
    id: "5a3b1e00-1200-4000-8000-000000000a01",
    patientId: "5a3b1e00-0e00-4000-8000-000000000601",
    objectKey: "/objects/sample/patient-documents/pat-sleep-study.pdf",
    documentType: "sleep_study",
    filename: "sleep-study-report.pdf",
    contentType: "application/pdf",
    bytes: SAMPLE_PDF_BYTES,
    reviewedAt: daysAgo(15),
    reviewNote: "AHI 32 — qualifies for CPAP. (sample)",
    createdAt: daysAgo(16),
  },
  {
    // Unreviewed insurance card on Sam's chart (badges as needs-review).
    id: "5a3b1e00-1200-4000-8000-000000000a02",
    patientId: "5a3b1e00-0e00-4000-8000-000000000602",
    objectKey: "/objects/sample/patient-documents/sam-insurance-card.jpg",
    documentType: "insurance_card",
    filename: "insurance-card-front.jpg",
    contentType: "image/jpeg",
    bytes: SAMPLE_JPEG_BYTES,
    reviewedAt: null,
    reviewNote: null,
    createdAt: daysAgo(3),
  },
];

// Strip the `/objects/` prefix to get the storage path the bytes live at.
function storagePathFor(objectKey: string): string {
  return objectKey.replace(/^\/objects\//u, "");
}

// ── Additional admin surfaces (chart + shop worklists) ──────────────
// A focused, patient-anchored set so the most prominent "empty" admin
// pages render real rows: chart notes, insurance, prescriptions, the
// referral inbox, plus a shop customer note and a return.

const PAT_ID = "5a3b1e00-0e00-4000-8000-000000000601";
const SAM_ID = "5a3b1e00-0e00-4000-8000-000000000602";

interface SamplePatientNote {
  id: string;
  patientId: string;
  body: string;
  createdAt: string;
}

const PATIENT_NOTES: SamplePatientNote[] = [
  {
    id: "5a3b1e00-1300-4000-8000-000000000b01",
    patientId: PAT_ID,
    body: "Patient called about mask fit — advised smaller cushion, shipping under comfort guarantee. (sample)",
    createdAt: daysAgo(12),
  },
  {
    id: "5a3b1e00-1300-4000-8000-000000000b02",
    patientId: SAM_ID,
    body: "New referral intake. Awaiting signed Rx before first shipment. (sample)",
    createdAt: daysAgo(2),
  },
];

interface SampleCoverage {
  id: string;
  patientId: string;
  rank: "primary" | "secondary";
  payerName: string;
  planName: string;
  memberId: string;
  groupNumber: string;
  relationship: "self";
  effectiveDate: string;
  inNetwork: boolean;
  deductibleCents: number;
  deductibleMetCents: number;
  verifiedAt: string | null;
}

const COVERAGES: SampleCoverage[] = [
  {
    id: "5a3b1e00-1400-4000-8000-000000000c01",
    patientId: PAT_ID,
    rank: "primary",
    payerName: "Medicare Part B",
    planName: "Original Medicare",
    memberId: "1EG4-TE5-MK72",
    groupNumber: "—",
    relationship: "self",
    effectiveDate: "2020-01-01",
    inNetwork: true,
    deductibleCents: 24000,
    deductibleMetCents: 24000,
    verifiedAt: daysAgo(14),
  },
  {
    id: "5a3b1e00-1400-4000-8000-000000000c02",
    patientId: SAM_ID,
    rank: "primary",
    payerName: "Highmark BCBS",
    planName: "PPO Blue",
    memberId: "HMK998877665",
    groupNumber: "GRP-44821",
    relationship: "self",
    effectiveDate: "2025-01-01",
    inNetwork: true,
    deductibleCents: 150000,
    deductibleMetCents: 42000,
    verifiedAt: null,
  },
];

interface SamplePrescription {
  id: string;
  patientId: string;
  itemSku: string;
  cadenceDays: number;
  validFrom: string;
  validUntil: string;
  status: "active";
  hcpcsCode: string;
}

const PRESCRIPTIONS: SamplePrescription[] = [
  {
    id: "5a3b1e00-1500-4000-8000-000000000d01",
    patientId: PAT_ID,
    itemSku: "airfit-p10-cushion",
    cadenceDays: 90,
    validFrom: daysAgo(200).slice(0, 10),
    validUntil: daysFromNow(165).slice(0, 10),
    status: "active",
    hcpcsCode: "A7032",
  },
  {
    id: "5a3b1e00-1500-4000-8000-000000000d02",
    patientId: SAM_ID,
    itemSku: "dreamwear-full-face",
    cadenceDays: 90,
    validFrom: daysAgo(60).slice(0, 10),
    validUntil: daysFromNow(305).slice(0, 10),
    status: "active",
    hcpcsCode: "A7030",
  },
];

const REFERRAL_REVIEW = {
  id: "5a3b1e00-1600-4000-8000-000000000e01",
  source: "fax" as const,
  status: "extracted" as const,
  extraction: {
    patientName: "Jamie Newpatient",
    dateOfBirth: "1972-02-18",
    referringProvider: "Dr. Quinn Sleepwell",
    diagnosis: "Obstructive sleep apnea (G47.33)",
    note: "Sample extracted referral awaiting CSR acceptance.",
  },
  extractionModel: "sample-seed",
  createdAt: daysAgo(1),
};

interface SampleCustomerNote {
  id: string;
  customerId: string;
  body: string;
  createdAt: string;
}

const SHOP_CUSTOMER_NOTES: SampleCustomerNote[] = [
  {
    id: "5a3b1e00-1700-4000-8000-000000000f01",
    customerId: "sample-cust-alex",
    body: "VIP — long-time resupply customer. Prefers email over SMS. (sample)",
    createdAt: daysAgo(30),
  },
];

const SHOP_RETURN = {
  id: "sample-return-jordan-1",
  customerId: "sample-cust-jordan",
  orderId: "5a3b1e00-0a00-4000-8000-000000000201",
  sessionId: "cs_test_sample_jordan_1",
  status: "requested" as const,
  reason: "defective",
  reasonNote: "Cushion arrived with a torn seam. (sample)",
  createdAt: daysAgo(5),
};

// Lazily constructed so `--dry-run` works without SUPABASE_* env set
// (getSupabaseServiceRoleClient validates env eagerly). Only the clean
// and real-seed paths build the client.
let _supabase: ReturnType<typeof getSupabaseServiceRoleClient> | null = null;
function db(): ReturnType<typeof getSupabaseServiceRoleClient> {
  if (!_supabase) _supabase = getSupabaseServiceRoleClient();
  return _supabase;
}

// Every table this script writes is tenant-scoped: `org_id` is NOT NULL
// on the multi-tenant schema, so each row must carry the seed tenant's
// id or the upsert fails the not-null constraint. Resolve it once (the
// db helper caches it) and fail fast with an actionable message if the
// seed tenant hasn't been onboarded yet.
let _orgId: string | null = null;
async function resolveOrgId(): Promise<string> {
  if (_orgId) return _orgId;
  const id = await resolveSeedOrgId();
  if (!id) {
    fail(
      `no seed tenant found (organizations.slug='${SEED_ORG_SLUG}'). ` +
        "Onboard it first (pnpm --filter @workspace/scripts tenant:onboard) " +
        "before seeding sample data.",
    );
  }
  _orgId = id;
  out(`tenant org_id=${id}`);
  return id;
}

function check(label: string, error: unknown): void {
  if (error) {
    fail(
      `${label} failed: ${
        error instanceof Error ? error.message : JSON.stringify(error)
      }`,
    );
  }
}

// ── Clean ────────────────────────────────────────────────────────────

async function runClean(): Promise<void> {
  out("cleaning previously-seeded sample rows…");
  const messageIds = CONVERSATION.messages.map((m) => m.id);
  const orderIds = ORDERS.map((o) => o.id);
  const customerIds = CUSTOMERS.map((c) => c.customerId);
  const subIds = SUBSCRIPTIONS.map((s) => s.id);
  const patientIds = PATIENTS.map((p) => p.id);
  const packetIds = PACKETS.map((p) => p.id);
  const packetSignatureIds = PACKETS.flatMap((p) =>
    p.signature ? [p.signature.id] : [],
  );
  const packetDocumentIds = PACKETS.flatMap((p) =>
    p.documents.map((d) => d.id),
  );
  const chartDocumentIds = CHART_DOCUMENTS.map((d) => d.id);

  // Children first to respect FKs. The additional-surface rows are all
  // leaf children of patients / shop_customers / shop_orders, so remove
  // them before those parents are deleted below.
  check(
    "delete patient_notes",
    (
      await db()
        .schema("resupply")
        .from("patient_notes")
        .delete()
        .in(
          "id",
          PATIENT_NOTES.map((n) => n.id),
        )
    ).error,
  );
  check(
    "delete insurance_coverages",
    (
      await db()
        .schema("resupply")
        .from("insurance_coverages")
        .delete()
        .in(
          "id",
          COVERAGES.map((c) => c.id),
        )
    ).error,
  );
  check(
    "delete prescriptions",
    (
      await db()
        .schema("resupply")
        .from("prescriptions")
        .delete()
        .in(
          "id",
          PRESCRIPTIONS.map((rx) => rx.id),
        )
    ).error,
  );
  check(
    "delete referral_reviews",
    (
      await db()
        .schema("resupply")
        .from("referral_reviews")
        .delete()
        .eq("id", REFERRAL_REVIEW.id)
    ).error,
  );
  check(
    "delete shop_customer_notes",
    (
      await db()
        .schema("resupply")
        .from("shop_customer_notes")
        .delete()
        .in(
          "id",
          SHOP_CUSTOMER_NOTES.map((n) => n.id),
        )
    ).error,
  );
  check(
    "delete shop_returns",
    (
      await db()
        .schema("resupply")
        .from("shop_returns")
        .delete()
        .eq("id", SHOP_RETURN.id)
    ).error,
  );

  // Best-effort removal of the uploaded chart-document bytes.
  const cleanBucket = (
    process.env.SUPABASE_STORAGE_BUCKET_PRIVATE ?? ""
  ).trim();
  if (cleanBucket) {
    const paths = CHART_DOCUMENTS.map((d) => storagePathFor(d.objectKey));
    const { error: rmErr } = await db().storage.from(cleanBucket).remove(paths);
    if (rmErr) {
      process.stderr.write(
        `${TAG} WARN: could not remove sample storage objects: ${rmErr.message}\n`,
      );
    }
  }

  check(
    "delete messages",
    (
      await db()
        .schema("resupply")
        .from("messages")
        .delete()
        .in("id", messageIds)
    ).error,
  );
  check(
    "delete conversations",
    (
      await db()
        .schema("resupply")
        .from("conversations")
        .delete()
        .eq("id", CONVERSATION.id)
    ).error,
  );
  check(
    "delete shop_order_items",
    (
      await db()
        .schema("resupply")
        .from("shop_order_items")
        .delete()
        .in("order_id", orderIds)
    ).error,
  );
  check(
    "delete shop_orders",
    (
      await db()
        .schema("resupply")
        .from("shop_orders")
        .delete()
        .in("id", orderIds)
    ).error,
  );
  check(
    "delete shop_subscriptions",
    (
      await db()
        .schema("resupply")
        .from("shop_subscriptions")
        .delete()
        .in("id", subIds)
    ).error,
  );
  check(
    "delete shop_customers",
    (
      await db()
        .schema("resupply")
        .from("shop_customers")
        .delete()
        .in("customer_id", customerIds)
    ).error,
  );
  // Packet children (signatures + documents) before the packets, and
  // packets + chart documents before the patients they reference.
  check(
    "delete patient_packet_signatures",
    (
      await db()
        .schema("resupply")
        .from("patient_packet_signatures")
        .delete()
        .in("id", packetSignatureIds)
    ).error,
  );
  check(
    "delete patient_packet_documents",
    (
      await db()
        .schema("resupply")
        .from("patient_packet_documents")
        .delete()
        .in("id", packetDocumentIds)
    ).error,
  );
  check(
    "delete patient_packets",
    (
      await db()
        .schema("resupply")
        .from("patient_packets")
        .delete()
        .in("id", packetIds)
    ).error,
  );
  check(
    "delete patient_documents",
    (
      await db()
        .schema("resupply")
        .from("patient_documents")
        .delete()
        .in("id", chartDocumentIds)
    ).error,
  );
  check(
    "delete patients",
    (
      await db()
        .schema("resupply")
        .from("patients")
        .delete()
        .in("id", patientIds)
    ).error,
  );
  out(
    "clean complete. (Sample auth-user logins are left in place — delete them " +
      "from the admin team tools if you need to.)",
  );
}

// ── Seed ─────────────────────────────────────────────────────────────

async function ensureLogin(c: SampleCustomer): Promise<void> {
  const repo = supabaseAuthRepository(db());
  const emailLower = normalizeEmail(c.email);
  let userId: string;
  const existing = await repo.findUserByEmail(emailLower);
  if (existing) {
    userId = existing.id;
    if (existing.status !== "active") {
      await repo.updateUserStatus(userId, "active");
    }
  } else {
    const inserted = await repo.insertUser({
      emailLower,
      displayName: c.displayName,
      role: "customer",
      status: "active",
    });
    userId = inserted.id;
  }
  await repo.markEmailVerified(userId, new Date());
  const passwordHash = await hashPassword(password);
  // Seed it as a user-chosen password (mustChange=false, no
  // set_by_admin_at) so the sample login works immediately without a
  // forced reset on first sign-in. Routed through the shared helper per
  // the no-direct-upsertCredential lint rule.
  await writeUserChosenPassword(repo, { userId, passwordHash });
  // Bind the login to the shop customer so the customerIdResolver maps
  // this auth user → our stable customer_id at sign-in time.
  c.authUserId = userId;
}

async function runSeed(): Promise<void> {
  if (dryRun) {
    out("--dry-run: the following would be written (no DB writes):");
    out(
      `  ${CUSTOMERS.length} shop customers (logins: ${withLogins ? "yes" : "no"})`,
    );
    out(`  ${ORDERS.length} orders + items`);
    out(`  ${SUBSCRIPTIONS.length} subscriptions`);
    out(
      `  1 in-app conversation with ${CONVERSATION.messages.length} messages`,
    );
    out(`  ${PATIENTS.length} patients`);
    out(
      `  ${PACKETS.length} signature packets (${PACKETS.reduce((n, p) => n + p.documents.length, 0)} documents)`,
    );
    out(`  ${CHART_DOCUMENTS.length} chart documents (+ uploaded file bytes)`);
    out(`  ${PATIENT_NOTES.length} patient notes`);
    out(`  ${COVERAGES.length} insurance coverages`);
    out(`  ${PRESCRIPTIONS.length} prescriptions`);
    out(`  1 referral review`);
    out(`  ${SHOP_CUSTOMER_NOTES.length} shop customer notes`);
    out(`  1 shop return`);
    return;
  }

  // Every table below is tenant-scoped (NOT NULL org_id); resolve the
  // seed tenant up front so every row can be tagged. Fails fast if the
  // tenant hasn't been onboarded.
  const orgId = await resolveOrgId();

  // Logins first so we can bind auth_user_id onto the shop_customers row.
  if (withLogins) {
    for (const c of CUSTOMERS) {
      try {
        await ensureLogin(c);
      } catch (err) {
        // Login failed — make sure we don't leave a dangling auth_user_id
        // on the shop_customers upsert (it's an FK). Fall back to a
        // data-only customer (no sign-in) rather than aborting the seed.
        c.authUserId = null;
        process.stderr.write(
          `${TAG} WARN: could not create login for ${c.email}: ${
            err instanceof Error ? err.message : String(err)
          } (continuing with data-only for this customer)\n`,
        );
      }
    }
  }

  // shop_customers
  for (const c of CUSTOMERS) {
    const { error } = await db()
      .schema("resupply")
      .from("shop_customers")
      .upsert({
        customer_id: c.customerId,
        display_name: c.displayName,
        email_lower: normalizeEmail(c.email),
        phone_e164: c.phoneE164,
        shipping_address_json: c.shipping,
        cpap_device_json: c.device,
        // Non-null only when a login was successfully created above.
        auth_user_id: c.authUserId,
        org_id: orgId,
        created_at: daysAgo(120),
        updated_at: nowIso,
      });
    check(`upsert shop_customers ${c.customerId}`, error);
  }
  out(`✓ ${CUSTOMERS.length} shop customers`);

  // orders + items
  for (const o of ORDERS) {
    const { error: oErr } = await db()
      .schema("resupply")
      .from("shop_orders")
      .upsert({
        id: o.id,
        stripe_session_id: o.sessionId,
        status: o.status,
        amount_total_cents: o.amountTotalCents,
        amount_refunded_cents: 0,
        currency: "usd",
        customer_id: o.customerId,
        customer_email: normalizeEmail(
          CUSTOMERS.find((c) => c.customerId === o.customerId)?.email ?? "",
        ),
        tracking_carrier: o.trackingCarrier,
        tracking_number: o.trackingNumber,
        shipped_at: o.shippedAt,
        delivered_at: o.deliveredAt,
        shipping_address_json:
          CUSTOMERS.find((c) => c.customerId === o.customerId)?.shipping ??
          null,
        paid_at: o.paidAt,
        org_id: orgId,
        created_at: o.paidAt,
        updated_at: nowIso,
      });
    check(`upsert shop_orders ${o.id}`, oErr);

    let i = 0;
    for (const item of o.items) {
      // Keep the id UUID-shaped (the column is a uuid): reuse the order
      // id and overwrite its last two hex chars with the item index.
      const itemId = `${o.id.slice(0, -2)}${(10 + i).toString(16).padStart(2, "0")}`;
      const { error: iErr } = await db()
        .schema("resupply")
        .from("shop_order_items")
        .upsert({
          id: itemId,
          order_id: o.id,
          stripe_session_id: o.sessionId,
          customer_id: o.customerId,
          product_id: item.productId,
          price_id: `price_sample_${item.productId}`,
          quantity: item.quantity,
          unit_amount_cents: item.unitAmountCents,
          currency: "usd",
          paid_at: o.paidAt,
          org_id: orgId,
          created_at: o.paidAt,
        });
      check(`upsert shop_order_items ${itemId}`, iErr);
      i += 1;
    }
  }
  out(`✓ ${ORDERS.length} orders + items`);

  // subscriptions
  for (const s of SUBSCRIPTIONS) {
    const { error } = await db()
      .schema("resupply")
      .from("shop_subscriptions")
      .upsert({
        id: s.id,
        customer_id: s.customerId,
        stripe_subscription_id: s.stripeSubscriptionId,
        status: s.status,
        items: s.items,
        current_period_end: s.currentPeriodEnd,
        cancel_at_period_end: s.cancelAtPeriodEnd,
        org_id: orgId,
        created_at: daysAgo(60),
        updated_at: nowIso,
      });
    check(`upsert shop_subscriptions ${s.id}`, error);
  }
  out(`✓ ${SUBSCRIPTIONS.length} subscriptions`);

  // in-app conversation + messages
  const lastMsg = CONVERSATION.messages.at(-1)!;
  const { error: convErr } = await db()
    .schema("resupply")
    .from("conversations")
    .upsert({
      id: CONVERSATION.id,
      customer_id: CONVERSATION.customerId,
      channel: "in_app",
      status: "awaiting_patient",
      last_message_at: lastMsg.createdAt,
      org_id: orgId,
      created_at: CONVERSATION.messages[0].createdAt,
      updated_at: nowIso,
    });
  check("upsert conversations", convErr);
  for (const m of CONVERSATION.messages) {
    const { error } = await db().schema("resupply").from("messages").upsert({
      id: m.id,
      conversation_id: CONVERSATION.id,
      direction: m.direction,
      sender_role: m.senderRole,
      body: m.body,
      sent_at: m.createdAt,
      org_id: orgId,
      created_at: m.createdAt,
    });
    check(`upsert messages ${m.id}`, error);
  }
  out(`✓ 1 in-app conversation with ${CONVERSATION.messages.length} messages`);

  // patients
  for (const p of PATIENTS) {
    const { error } = await db()
      .schema("resupply")
      .from("patients")
      .upsert({
        id: p.id,
        pacware_id: p.pacwareId,
        legal_first_name: p.firstName,
        legal_last_name: p.lastName,
        date_of_birth: p.dob,
        phone_e164: p.phoneE164,
        email: p.email,
        status: "active",
        timezone: "America/New_York",
        org_id: orgId,
        created_at: daysAgo(200),
        updated_at: nowIso,
      });
    check(`upsert patients ${p.id}`, error);
  }
  out(`✓ ${PATIENTS.length} patients`);

  // signature packets (+ documents + signature)
  let packetDocCount = 0;
  for (const pk of PACKETS) {
    const { error: pkErr } = await db()
      .schema("resupply")
      .from("patient_packets")
      .upsert({
        id: pk.id,
        patient_id: pk.patientId,
        title: pk.title,
        status: pk.status,
        recipient_name: pk.recipientName,
        recipient_email: pk.recipientEmail,
        recipient_phone: pk.recipientPhone,
        link_version: 1,
        sent_at: pk.sentAt,
        first_viewed_at: pk.firstViewedAt,
        completed_at: pk.completedAt,
        expires_at: daysFromNow(20),
        reminder_count: 0,
        created_by_email: SEED_ADMIN_EMAIL,
        org_id: orgId,
        created_at: pk.sentAt,
        updated_at: nowIso,
      });
    check(`upsert patient_packets ${pk.id}`, pkErr);

    for (const d of pk.documents) {
      const acknowledged = pk.status === "completed" && d.requiresSignature;
      const { error: dErr } = await db()
        .schema("resupply")
        .from("patient_packet_documents")
        .upsert({
          id: d.id,
          packet_id: pk.id,
          document_key: d.documentKey,
          title: d.title,
          content_version: PACKET_CONTENT_VERSION,
          sort_order: d.sortOrder,
          requires_signature: d.requiresSignature,
          acknowledged,
          acknowledged_at: acknowledged ? pk.completedAt : null,
          org_id: orgId,
          created_at: pk.sentAt,
        });
      check(`upsert patient_packet_documents ${d.id}`, dErr);
      packetDocCount += 1;
    }

    if (pk.signature) {
      const signedKeys = pk.documents
        .filter((d) => d.requiresSignature)
        .map((d) => d.documentKey);
      const { error: sErr } = await db()
        .schema("resupply")
        .from("patient_packet_signatures")
        .upsert({
          id: pk.signature.id,
          packet_id: pk.id,
          signer_name: pk.signature.signerName,
          signer_relationship: pk.signature.signerRelationship,
          consent_esign: true,
          acknowledged_document_keys: signedKeys,
          signed_at: pk.signature.signedAt,
          org_id: orgId,
          created_at: pk.signature.signedAt,
        });
      check(`upsert patient_packet_signatures ${pk.signature.id}`, sErr);
    }
  }
  out(`✓ ${PACKETS.length} signature packets (${packetDocCount} documents)`);

  // chart documents — upload placeholder bytes first (best-effort) so
  // the file is downloadable, then write the metadata row pointing at it.
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET_PRIVATE ?? "").trim();
  let uploadedBytes = 0;
  for (const d of CHART_DOCUMENTS) {
    if (bucket) {
      const path = storagePathFor(d.objectKey);
      const { error: upErr } = await db()
        .storage.from(bucket)
        .upload(path, d.bytes, { contentType: d.contentType, upsert: true });
      if (upErr) {
        process.stderr.write(
          `${TAG} WARN: could not upload ${path} to bucket ${bucket}: ${upErr.message} ` +
            "(the document row is still seeded; download will 404 until bytes exist)\n",
        );
      } else {
        uploadedBytes += 1;
      }
    }
    const { error } = await db()
      .schema("resupply")
      .from("patient_documents")
      .upsert({
        id: d.id,
        patient_id: d.patientId,
        object_key: d.objectKey,
        document_type: d.documentType,
        filename: d.filename,
        content_type: d.contentType,
        size_bytes: d.bytes.length,
        reviewed_at: d.reviewedAt,
        review_note: d.reviewNote,
        legal_hold: false,
        org_id: orgId,
        created_at: d.createdAt,
        updated_at: nowIso,
      });
    check(`upsert patient_documents ${d.id}`, error);
  }
  if (!bucket) {
    process.stderr.write(
      `${TAG} WARN: SUPABASE_STORAGE_BUCKET_PRIVATE unset — chart document ` +
        "bytes not uploaded; downloads will 404 until the bucket is configured.\n",
    );
  }
  out(
    `✓ ${CHART_DOCUMENTS.length} chart documents (${uploadedBytes} files uploaded)`,
  );

  // patient chart notes
  for (const n of PATIENT_NOTES) {
    const { error } = await db()
      .schema("resupply")
      .from("patient_notes")
      .upsert({
        id: n.id,
        patient_id: n.patientId,
        author_email: SEED_ADMIN_EMAIL,
        body: n.body,
        org_id: orgId,
        created_at: n.createdAt,
      });
    check(`upsert patient_notes ${n.id}`, error);
  }
  out(`✓ ${PATIENT_NOTES.length} patient notes`);

  // insurance coverages
  for (const c of COVERAGES) {
    const { error } = await db()
      .schema("resupply")
      .from("insurance_coverages")
      .upsert({
        id: c.id,
        patient_id: c.patientId,
        rank: c.rank,
        payer_name: c.payerName,
        plan_name: c.planName,
        member_id: c.memberId,
        group_number: c.groupNumber,
        policyholder_relationship: c.relationship,
        effective_date: c.effectiveDate,
        in_network: c.inNetwork,
        deductible_cents: c.deductibleCents,
        deductible_met_cents: c.deductibleMetCents,
        verified_at: c.verifiedAt,
        org_id: orgId,
        created_at: nowIso,
        updated_at: nowIso,
      });
    check(`upsert insurance_coverages ${c.id}`, error);
  }
  out(`✓ ${COVERAGES.length} insurance coverages`);

  // prescriptions
  for (const rx of PRESCRIPTIONS) {
    const { error } = await db()
      .schema("resupply")
      .from("prescriptions")
      .upsert({
        id: rx.id,
        patient_id: rx.patientId,
        item_sku: rx.itemSku,
        cadence_days: rx.cadenceDays,
        valid_from: rx.validFrom,
        valid_until: rx.validUntil,
        status: rx.status,
        hcpcs_code: rx.hcpcsCode,
        org_id: orgId,
        created_at: nowIso,
        updated_at: nowIso,
      });
    check(`upsert prescriptions ${rx.id}`, error);
  }
  out(`✓ ${PRESCRIPTIONS.length} prescriptions`);

  // referral review (the referral inbox)
  const { error: refErr } = await db()
    .schema("resupply")
    .from("referral_reviews")
    .upsert({
      id: REFERRAL_REVIEW.id,
      source: REFERRAL_REVIEW.source,
      status: REFERRAL_REVIEW.status,
      extraction: REFERRAL_REVIEW.extraction,
      extraction_model: REFERRAL_REVIEW.extractionModel,
      extracted_at: REFERRAL_REVIEW.createdAt,
      org_id: orgId,
      created_at: REFERRAL_REVIEW.createdAt,
      updated_at: nowIso,
    });
  check("upsert referral_reviews", refErr);
  out("✓ 1 referral review");

  // shop customer notes
  for (const n of SHOP_CUSTOMER_NOTES) {
    const { error } = await db()
      .schema("resupply")
      .from("shop_customer_notes")
      .upsert({
        id: n.id,
        customer_id: n.customerId,
        body: n.body,
        author_email: SEED_ADMIN_EMAIL,
        org_id: orgId,
        created_at: n.createdAt,
      });
    check(`upsert shop_customer_notes ${n.id}`, error);
  }
  out(`✓ ${SHOP_CUSTOMER_NOTES.length} shop customer notes`);

  // shop return
  const { error: retErr } = await db()
    .schema("resupply")
    .from("shop_returns")
    .upsert({
      id: SHOP_RETURN.id,
      customer_id: SHOP_RETURN.customerId,
      order_id: SHOP_RETURN.orderId,
      stripe_session_id: SHOP_RETURN.sessionId,
      status: SHOP_RETURN.status,
      reason: SHOP_RETURN.reason,
      reason_note: SHOP_RETURN.reasonNote,
      org_id: orgId,
      created_at: SHOP_RETURN.createdAt,
      updated_at: nowIso,
    });
  check("upsert shop_returns", retErr);
  out("✓ 1 shop return");
}

// ── Main ─────────────────────────────────────────────────────────────

if (clean) {
  await runClean();
  process.exit(0);
}

await runSeed();

if (!dryRun) {
  out("done. Sample data is in place.");
  if (withLogins) {
    out("");
    out("Sign in as a sample customer to test the account assistant:");
    for (const c of CUSTOMERS) {
      out(`  ${c.email}  /  ${password}`);
    }
    out("");
    out(
      "Admin console: see /admin/customers, /admin/conversations, and " +
        "/admin/patients for the seeded rows.",
    );
  }
  out("Re-run with --clean to remove the sample data.");
}
