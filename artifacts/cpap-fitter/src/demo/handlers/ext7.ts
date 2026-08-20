// Extension handler set #7 for the demo sandbox. Seeds the admin routes
// under artifacts/resupply-api/src/routes/admin/ for the
// product-catalog-config, provider-registry / e-signature, referral-CRM,
// and reorder/refill surfaces. The fetch interceptor's empty `{}`
// fallback makes these admin pages crash (they read nested fields / map
// over arrays), so each route returns fully-shaped sample data matching
// the live API response shape (see the corresponding route file).
//
// DATA RULES: everything here is fictional demo data — obviously-fake
// names ("Demo Prescriber", "Sample Physician"), demo ids, 555 phone /
// fax numbers, and FAKE 1-prefixed 10-digit NPI values. Platform is
// CareMetric Breathe; the tenant is CareMetric Demo DME
// (demo.example). Fresh relative dates via the shared helpers. NO real
// PHI. Product ids / names reuse the demo catalog for consistency.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, daysFromNow, dateOnly, NOW_ISO } from "../fixtures/dates";

// ── product-compatibility.ts ──────────────────────────────────────────
// Admin surface is POST/DELETE only (customer-side reads live elsewhere).
//   POST   /resupply-api/admin/shop/products/:productId/compatibility → { id }
//   DELETE /resupply-api/admin/shop/products/:productId/compatibility/:entryId
//          → { id, deleted: true }

// ── product-costs.ts ──────────────────────────────────────────────────
// GET /resupply-api/admin/product-costs → { costs: [...] }
// PUT /resupply-api/admin/product-costs/:sku → upserted cost row
function productCosts() {
  const cost = (
    sku: string,
    unitCostCents: number,
    costSource: "manual" | "invoice" | "catalog" | "estimate",
    agoDays: number,
    notes: string | null,
  ) => ({
    sku,
    unitCostCents,
    currency: "usd",
    costSource,
    effectiveFrom: daysAgo(agoDays),
    notes,
    updatedAt: daysAgo(agoDays),
  });
  return {
    costs: [
      cost("CUSHION-N20", 1180, "invoice", 12, "Per last distributor invoice"),
      cost("CUSHION-P10", 950, "invoice", 12, null),
      cost("FILTER-DISP", 420, "catalog", 40, "6-pack landed"),
      cost("HEADGEAR-N20", 1390, "manual", 60, null),
      cost("MASK-N20", 5400, "invoice", 18, "Complete system"),
      cost("TUBING-SLIM", 880, "estimate", 90, "Estimated; awaiting invoice"),
    ],
  };
}

// ── product-hcpcs-map.ts ──────────────────────────────────────────────
// GET /resupply-api/admin/product-hcpcs-map → { rows: [...] }
// POST → { id }; PATCH /:id → { ok: true }
function productHcpcsMap() {
  const row = (
    id: string,
    lookupValue: string,
    hcpcsCode: string,
    defaultModifiers: string | null,
    description: string,
    defaultBilledCents: number | null,
  ) => ({
    id,
    lookupKind: "item_sku" as const,
    lookupValue,
    hcpcsCode,
    defaultModifiers,
    unitsPerDispense: 1,
    defaultBilledCents,
    description,
    isActive: true,
    createdAt: daysAgo(120),
    updatedAt: daysAgo(20),
  });
  return {
    rows: [
      row(
        "demo-hcpcs-0001",
        "CUSHION-N20",
        "A7032",
        "RR",
        "Nasal cushion",
        2999,
      ),
      row(
        "demo-hcpcs-0002",
        "CUSHION-P10",
        "A7033",
        "RR",
        "Nasal pillows",
        2449,
      ),
      row(
        "demo-hcpcs-0003",
        "FILTER-DISP",
        "A7038",
        null,
        "Disposable filter",
        1499,
      ),
      row("demo-hcpcs-0004", "HEADGEAR-N20", "A7035", null, "Headgear", 3499),
      row(
        "demo-hcpcs-0005",
        "TUBING-SLIM",
        "A7037",
        null,
        "Standard tubing",
        2299,
      ),
      row(
        "demo-hcpcs-0006",
        "MASK-N20",
        "A7034",
        "NU",
        "Full mask system",
        13900,
      ),
    ],
  };
}

// ── product-questions.ts ──────────────────────────────────────────────
// GET /resupply-api/admin/shop/product-questions?status=… → { items, nextCursor }
// PATCH /:id (answer | reject) → { id, status, answeredAt | moderatedAt }
function productQuestions(status: "pending" | "answered" | "rejected") {
  const pending = [
    {
      id: "demo-pq-0001-0000-0000-0000-000000000001",
      productId: "demo-prod-n20-cushion",
      askerDisplayName: "Sam Demo",
      askerEmail: "sam.demo@example.com",
      questionBody:
        "Does this cushion fit the AirFit N20 frame I already have?",
      answerBody: null,
      answeredByEmail: null,
      answeredAt: null,
      moderationNote: null,
      moderatedAt: null,
      status: "pending" as const,
      createdAt: daysAgo(1),
    },
    {
      id: "demo-pq-0001-0000-0000-0000-000000000002",
      productId: "demo-prod-p10-pillows",
      askerDisplayName: "Avery Sample",
      askerEmail: null,
      questionBody: "How often should I replace the nasal pillows?",
      answerBody: null,
      answeredByEmail: null,
      answeredAt: null,
      moderationNote: null,
      moderatedAt: null,
      status: "pending" as const,
      createdAt: daysAgo(2),
    },
  ];
  const answered = [
    {
      id: "demo-pq-0001-0000-0000-0000-000000000003",
      productId: "demo-prod-climateline",
      askerDisplayName: "Jordan Fixture",
      askerEmail: "jordan.fixture@example.com",
      questionBody: "Is this heated tubing compatible with the AirSense 10?",
      answerBody:
        "Yes — the ClimateLineAir heated tubing is designed for the AirSense 10 series.",
      answeredByEmail: "demo.csr@caremetric.example",
      answeredAt: daysAgo(3),
      moderationNote: null,
      moderatedAt: null,
      status: "answered" as const,
      createdAt: daysAgo(5),
    },
  ];
  const rejected = [
    {
      id: "demo-pq-0001-0000-0000-0000-000000000004",
      productId: "demo-prod-wipes",
      askerDisplayName: "Anonymous",
      askerEmail: null,
      questionBody: "(spam content removed)",
      answerBody: null,
      answeredByEmail: null,
      answeredAt: null,
      moderationNote: "Off-topic / promotional",
      moderatedAt: daysAgo(6),
      status: "rejected" as const,
      createdAt: daysAgo(7),
    },
  ];
  const byStatus = { pending, answered, rejected };
  return { items: byStatus[status], nextCursor: null };
}

// ── provider-esign.ts (provider-portal/*) ─────────────────────────────
const PROVIDER_ACCOUNTS = [
  {
    id: "demo-ppa-0001",
    providerId: "demo-prov-1",
    email: "dr.prescriber@demosleepclinic.example",
    status: "active" as const,
    mfaEnrolled: true,
    lastLoginAt: daysAgo(2),
    invitedByEmail: "demo.csr@caremetric.example",
    createdAt: daysAgo(45),
    providerName: "Dr. Demo Prescriber",
    providerNpi: "1234567893",
    practiceName: "Demo Sleep Clinic",
  },
  {
    id: "demo-ppa-0002",
    providerId: "demo-prov-2",
    email: "dr.physician@fixturepulmonary.example",
    status: "invited" as const,
    mfaEnrolled: false,
    lastLoginAt: null,
    invitedByEmail: "demo.csr@caremetric.example",
    createdAt: daysAgo(6),
    providerName: "Dr. Sample Physician",
    providerNpi: "1987654320",
    practiceName: "Fixture Pulmonary",
  },
];

const SIGNATURE_REQUESTS = [
  {
    id: "demo-sigreq-0000-0000-0000-000000000001",
    providerId: "demo-prov-1",
    providerName: "Dr. Demo Prescriber",
    providerNpi: "1234567893",
    subjectType: "prescription_packet" as const,
    subjectId: "demo-rxr-0001",
    title: "Standard Written Order — Avery Sample",
    patientName: "Avery Sample",
    status: "pending" as const,
    createdAt: daysAgo(2),
    signedAt: null,
    expiresAt: daysFromNow(12),
    readyToPrintAt: null,
    returnedSignedAt: null,
    attachedToChartAt: null,
    releasedAt: null,
    releaseKind: null,
  },
  {
    id: "demo-sigreq-0000-0000-0000-000000000002",
    providerId: "demo-prov-1",
    providerName: "Dr. Demo Prescriber",
    providerNpi: "1234567893",
    subjectType: "cmn" as const,
    subjectId: "demo-cmn-7700",
    title: "Certificate of Medical Necessity — Demo Patient",
    patientName: "Demo Patient",
    status: "signed" as const,
    createdAt: daysAgo(9),
    signedAt: daysAgo(7),
    expiresAt: null,
    readyToPrintAt: daysAgo(6),
    returnedSignedAt: null,
    attachedToChartAt: null,
    releasedAt: null,
    releaseKind: null,
  },
  {
    id: "demo-sigreq-0000-0000-0000-000000000003",
    providerId: "demo-prov-2",
    providerName: "Dr. Sample Physician",
    providerNpi: "1987654320",
    subjectType: "claim" as const,
    subjectId: "demo-claim-5512",
    title: "Insurance claim attestation — Quinn Mockton",
    patientName: "Quinn Mockton",
    status: "signed" as const,
    createdAt: daysAgo(20),
    signedAt: daysAgo(18),
    expiresAt: null,
    readyToPrintAt: daysAgo(17),
    returnedSignedAt: daysAgo(15),
    attachedToChartAt: daysAgo(14),
    releasedAt: daysAgo(13),
    releaseKind: "claim" as const,
  },
];

// Detail GET returns the raw request row plus chain integrity + events.
function signatureRequestDetail(id: string) {
  const summary =
    SIGNATURE_REQUESTS.find((r) => r.id === id) ?? SIGNATURE_REQUESTS[0]!;
  return {
    request: {
      id: summary.id,
      provider_id: summary.providerId,
      subject_type: summary.subjectType,
      subject_id: summary.subjectId,
      title: summary.title,
      patient_name_snapshot: summary.patientName,
      status: summary.status,
      created_at: summary.createdAt,
      signed_at: summary.signedAt,
      expires_at: summary.expiresAt,
      ready_to_print_at: summary.readyToPrintAt,
      returned_signed_at: summary.returnedSignedAt,
      attached_to_chart_at: summary.attachedToChartAt,
      released_at: summary.releasedAt,
      release_kind: summary.releaseKind,
      providers: {
        legal_name: summary.providerName,
        npi: summary.providerNpi,
        practice_name: "Demo Sleep Clinic",
      },
    },
    chainOk: true,
    events: [
      {
        seq: 1,
        eventType: "created",
        actorKind: "employee",
        actorEmail: "demo.csr@caremetric.example",
        occurredAt: summary.createdAt,
        eventHash: "demohash000000000000000000000001",
      },
      ...(summary.signedAt
        ? [
            {
              seq: 2,
              eventType: "signed",
              actorKind: "provider",
              actorEmail: summary.providerName,
              occurredAt: summary.signedAt,
              eventHash: "demohash000000000000000000000002",
            },
          ]
        : []),
    ],
  };
}

// ── providers.ts ──────────────────────────────────────────────────────
const PROVIDERS = [
  {
    id: "demo-prov-1",
    npi: "1234567893",
    legalName: "Dr. Demo Prescriber",
    taxonomyCode: "2080P0214X",
    phoneE164: "+15555550101",
    faxE164: "+15555550102",
    email: "dr.prescriber@demosleepclinic.example",
    practiceName: "Demo Sleep Clinic",
    source: "nppes" as const,
    verifiedAt: daysAgo(40),
    createdAt: daysAgo(120),
  },
  {
    id: "demo-prov-2",
    npi: "1987654320",
    legalName: "Dr. Sample Physician",
    taxonomyCode: "2080P0214X",
    phoneE164: "+15555550111",
    faxE164: "+15555550112",
    email: "dr.physician@fixturepulmonary.example",
    practiceName: "Fixture Pulmonary",
    source: "nppes" as const,
    verifiedAt: daysAgo(15),
    createdAt: daysAgo(80),
  },
  {
    id: "demo-prov-3",
    npi: "1122334455",
    legalName: "Dr. Casey Mockworth",
    taxonomyCode: null,
    phoneE164: "+15555550121",
    faxE164: null,
    email: null,
    practiceName: "Mockworth Family Medicine",
    source: "csr_entry" as const,
    verifiedAt: null,
    createdAt: daysAgo(10),
  },
];

function providerDetail(id: string) {
  const p = PROVIDERS.find((x) => x.id === id) ?? PROVIDERS[0]!;
  return {
    ...p,
    practiceAddress: {
      line1: "100 Demo Medical Plaza",
      line2: "Suite 200",
      city: "Sampletown",
      state: "PA",
      postalCode: "19000",
      country: "US",
    },
    notes: null,
    updatedAt: daysAgo(5),
  };
}

// Canned NPPES lookup result (NEVER calls the external registry in demo).
function nppesLookup(npi: string) {
  return {
    provider: {
      npi: /^\d{10}$/.test(npi) ? npi : "1234567893",
      legalName: "Dr. Demo Prescriber",
      taxonomyCode: "2080P0214X",
      phoneE164: "+15555550101",
      faxE164: "+15555550102",
      practiceName: "Demo Sleep Clinic",
      practiceAddress: {
        line1: "100 Demo Medical Plaza",
        line2: "Suite 200",
        city: "Sampletown",
        state: "PA",
        postalCode: "19000",
        country: "US",
      },
    },
  };
}

function providerCaseload() {
  return {
    patients: [
      {
        patientId: "demo-p-2004",
        legalFirstName: "Avery",
        legalLastName: "Sample",
        email: "avery.sample@example.com",
        phoneE164: "+15555550201",
        patientStatus: "active",
        prescriptionId: "demo-rx-9001",
        prescriptionStatus: "active",
        validFrom: dateOnly(-200),
        validUntil: dateOnly(165),
      },
      {
        patientId: "demo-p-3007",
        legalFirstName: "Demo",
        legalLastName: "Patient",
        email: null,
        phoneE164: "+15555550202",
        patientStatus: "active",
        prescriptionId: "demo-rx-9002",
        prescriptionStatus: "active",
        validFrom: dateOnly(-90),
        validUntil: dateOnly(275),
      },
    ],
  };
}

// ── referral-sources.ts ───────────────────────────────────────────────
// GET /resupply-api/admin/referrals/scorecard → { sinceDays, sources }
function referralScorecard(sinceDays: number) {
  return {
    sinceDays,
    sources: [
      {
        providerId: "demo-prov-1",
        providerName: "Dr. Demo Prescriber",
        practiceName: "Demo Sleep Clinic",
        npi: "1234567893",
        claimCount: 41,
        patientCount: 28,
        claimsSince: 12,
        paidCents: 1843200,
        lastActivityOn: dateOnly(-4),
      },
      {
        providerId: "demo-prov-2",
        providerName: "Dr. Sample Physician",
        practiceName: "Fixture Pulmonary",
        npi: "1987654320",
        claimCount: 19,
        patientCount: 14,
        claimsSince: 5,
        paidCents: 762400,
        lastActivityOn: dateOnly(-11),
      },
      {
        providerId: "demo-prov-3",
        providerName: "Dr. Casey Mockworth",
        practiceName: "Mockworth Family Medicine",
        npi: "1122334455",
        claimCount: 6,
        patientCount: 5,
        claimsSince: 2,
        paidCents: 214800,
        lastActivityOn: null,
      },
    ],
  };
}

// GET /resupply-api/admin/providers/:providerId/referral-activity
function referralActivity(providerId: string) {
  return {
    providerId,
    activity: [
      {
        id: "demo-rsa-0001",
        providerId,
        activityType: "visit",
        occurredOn: dateOnly(-4),
        summary: "Dropped off resupply order pads; discussed turnaround times.",
        nextAction: "Follow up on two pending SWO requests next week.",
        createdByEmail: "demo.csr@caremetric.example",
        createdAt: daysAgo(4),
      },
      {
        id: "demo-rsa-0002",
        providerId,
        activityType: "call",
        occurredOn: dateOnly(-18),
        summary: "Confirmed fax number and preferred contact for chart notes.",
        nextAction: null,
        createdByEmail: "demo.csr@caremetric.example",
        createdAt: daysAgo(18),
      },
    ],
  };
}

const intParam = (
  query: URLSearchParams,
  key: string,
  fallback: number,
): number => {
  const raw = query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const ext7Handlers: DemoHandler[] = [
  // ── product-compatibility.ts (POST + DELETE only) ───────────────────
  route(
    "POST",
    "/resupply-api/admin/shop/products/:productId/compatibility",
    () => json({ id: "demo-compat-0000-0000-0000-0000-0000000000ff" }, 201),
  ),
  route(
    "DELETE",
    "/resupply-api/admin/shop/products/:productId/compatibility/:entryId",
    (_req, { entryId }) => json({ id: entryId, deleted: true }),
  ),

  // ── product-costs.ts ────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/product-costs", () => json(productCosts())),
  route("PUT", "/resupply-api/admin/product-costs/:sku", (req, { sku }) => {
    const body = req.json<{
      unitCostCents?: number;
      currency?: string;
      costSource?: string;
    }>();
    const nowIso = NOW_ISO();
    return json({
      sku,
      unitCostCents: body?.unitCostCents ?? 0,
      currency: (body?.currency ?? "usd").toLowerCase(),
      costSource: body?.costSource ?? "manual",
      effectiveFrom: nowIso,
      updatedAt: nowIso,
    });
  }),

  // ── product-hcpcs-map.ts ────────────────────────────────────────────
  route("GET", "/resupply-api/admin/product-hcpcs-map", () =>
    json(productHcpcsMap()),
  ),
  route("POST", "/resupply-api/admin/product-hcpcs-map", () =>
    json({ id: "demo-hcpcs-0000-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/product-hcpcs-map/:id", () =>
    json({ ok: true }),
  ),

  // ── product-questions.ts ────────────────────────────────────────────
  route("GET", "/resupply-api/admin/shop/product-questions", (req) => {
    const raw = req.query.get("status");
    const status = raw === "answered" || raw === "rejected" ? raw : "pending";
    return json(productQuestions(status));
  }),
  route(
    "PATCH",
    "/resupply-api/admin/shop/product-questions/:id",
    (req, { id }) => {
      const body = req.json<{ action?: string }>();
      const nowIso = NOW_ISO();
      if (body?.action === "reject") {
        return json({ id, status: "rejected", moderatedAt: nowIso });
      }
      return json({ id, status: "answered", answeredAt: nowIso });
    },
  ),

  // ── provider-esign.ts (provider-portal/*) ───────────────────────────
  route("GET", "/resupply-api/admin/provider-portal/accounts", () =>
    json({ accounts: PROVIDER_ACCOUNTS }),
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-portal/accounts/invite",
    (req) => {
      const body = req.json<{ email?: string }>();
      return json({
        ok: true,
        email: body?.email ?? "dr.physician@fixturepulmonary.example",
        emailSent: true,
        inviteLink:
          "https://demo.example/reset-password?token=demo-invite-token",
      });
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-portal/accounts/:id/disable",
    () => json({ ok: true }),
  ),
  route("POST", "/resupply-api/admin/provider-portal/accounts/:id/enable", () =>
    json({ ok: true, status: "active" }),
  ),
  route(
    "GET",
    "/resupply-api/admin/provider-portal/signature-requests",
    (req) => {
      const status = req.query.get("status");
      const providerId = req.query.get("providerId");
      let requests = SIGNATURE_REQUESTS;
      if (status && status !== "all") {
        requests = requests.filter((r) => r.status === status);
      }
      if (providerId) {
        requests = requests.filter((r) => r.providerId === providerId);
      }
      return json({ requests });
    },
  ),
  route(
    "GET",
    "/resupply-api/admin/provider-portal/signature-requests/:id",
    (_req, { id }) => json(signatureRequestDetail(id)),
  ),
  route("POST", "/resupply-api/admin/provider-portal/signature-requests", () =>
    json({ ok: true, id: "demo-sigreq-0000-0000-0000-0000000000ff" }, 201),
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-portal/signature-requests/:id/void",
    () => json({ ok: true }),
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-portal/signature-requests/:id/ready-to-print",
    () => json({ ok: true }),
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-portal/signature-requests/:id/returned-signed",
    () => json({ ok: true }),
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-portal/signature-requests/:id/attach-to-chart",
    () => json({ ok: true }),
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-portal/signature-requests/:id/release",
    () => json({ ok: true }),
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-portal/signature-requests/:id/remind",
    () => json({ ok: true, emailSent: true }),
  ),

  // ── providers.ts ────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/providers", (req) => {
    const q = (req.query.get("q") ?? "").trim().toLowerCase();
    const filtered = q
      ? PROVIDERS.filter(
          (p) => p.npi === q || p.legalName.toLowerCase().includes(q),
        )
      : PROVIDERS;
    return json({
      total: filtered.length,
      limit: 50,
      offset: 0,
      providers: filtered,
    });
  }),
  // NPPES lookup proxy — canned, never calls out in demo mode. (Declared
  // before the :id detail route so the literal segment wins the match.)
  route("POST", "/resupply-api/admin/providers/nppes-lookup", (req) => {
    const body = req.json<{ npi?: string }>();
    return json(nppesLookup(body?.npi ?? ""));
  }),
  route("POST", "/resupply-api/admin/providers", () =>
    json(
      { id: "demo-prov-0000-0000-0000-0000-0000000000ff", created: true },
      201,
    ),
  ),
  route("GET", "/resupply-api/admin/providers/:id/patients", () =>
    json(providerCaseload()),
  ),
  route(
    "POST",
    "/resupply-api/admin/providers/:id/portal-link",
    (_req, { id }) =>
      json({
        token: "demo-portal-token",
        path: `/provider-portal/demo-portal-token`,
        expiresInDays: 30,
        providerId: id,
      }),
  ),
  route("DELETE", "/resupply-api/admin/providers/:id/portal-link", () =>
    json({ ok: true, portalLinkVersion: 2 }),
  ),
  // referral-sources.ts: rep-touch log + create (declared before the
  // bare :id detail so the literal suffix wins).
  route(
    "GET",
    "/resupply-api/admin/providers/:providerId/referral-activity",
    (_req, { providerId }) => json(referralActivity(providerId)),
  ),
  route(
    "POST",
    "/resupply-api/admin/providers/:providerId/referral-activity",
    () => json({ id: "demo-rsa-0000-ff", occurredOn: dateOnly(0) }, 201),
  ),
  route("GET", "/resupply-api/admin/providers/:id", (_req, { id }) =>
    json(providerDetail(id)),
  ),

  // ── referral-sources.ts (scorecard) ─────────────────────────────────
  route("GET", "/resupply-api/admin/referrals/scorecard", (req) =>
    json(referralScorecard(intParam(req.query, "sinceDays", 90))),
  ),

  // ── referrals-attribute.ts (POST sweep — benign success) ────────────
  route("POST", "/resupply-api/admin/referrals/scan-attribution", () =>
    json({ scanned: 8, converted: 3 }),
  ),

  // ── refill-confirmations.ts ─────────────────────────────────────────
  route("GET", "/resupply-api/admin/patients/:id/refill-confirmations", () =>
    json({
      confirmations: [
        {
          id: "demo-rc-0001",
          episode_id: "demo-ep-7001",
          prescription_id: "demo-rx-9001",
          item_sku: "CUSHION-N20",
          hcpcs_code: "A7032",
          channel: "sms",
          affirm_continued_use: true,
          affirm_supply_low: true,
          attestation_text:
            "I confirm I am still using my equipment and my supplies are running low.",
          requested_by: "patient",
          expected_depletion_on: dateOnly(-2),
          confirmed_at: daysAgo(3),
        },
        {
          id: "demo-rc-0002",
          episode_id: "demo-ep-6890",
          prescription_id: "demo-rx-9001",
          item_sku: "FILTER-DISP",
          hcpcs_code: "A7038",
          channel: "voice",
          affirm_continued_use: true,
          affirm_supply_low: true,
          attestation_text:
            "I confirm continued use and that I need a resupply.",
          requested_by: "patient",
          expected_depletion_on: dateOnly(-30),
          confirmed_at: daysAgo(32),
        },
      ],
    }),
  ),

  // ── reorder-reminders.ts (funnel analytics) ─────────────────────────
  route("GET", "/resupply-api/admin/reorder-reminders/funnel", (req) => {
    const days = intParam(req.query, "days", 30);
    return json({
      windowDays: days,
      due: 120,
      reminded: 96,
      confirmed: 61,
      shipped: 54,
      byChannel: {
        sms: { reminded: 70, confirmed: 47, shipped: 42 },
        email: { reminded: 58, confirmed: 33, shipped: 29 },
        voice: { reminded: 18, confirmed: 11, shipped: 10 },
      },
      rates: {
        remindedOfDue: 0.8,
        confirmedOfReminded: 0.6354,
        shippedOfConfirmed: 0.8852,
      },
    });
  }),
];
