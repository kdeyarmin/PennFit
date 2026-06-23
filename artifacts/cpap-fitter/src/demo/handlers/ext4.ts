// Demo-sandbox handlers — batch "ext4". Seeds a cluster of admin admin
// surfaces (insurance leads/discovery, therapy-integration sync actions,
// inventory reconciliation, locations, the global lookup bar, manual claim
// entry, manual document packets, and per-customer message-template
// overrides) so those pages render realistic sample data in demo mode
// instead of the interceptor's empty `{}` fallback (which crashes pages
// that read nested fields / map over arrays).
//
// Each endpoint mirrors the EXACT res.json shape of its live route under
// artifacts/resupply-api/src/routes/admin/*.ts. Mutations return a benign
// success in the route's real result shape.
//
// DATA RULES: everything here is fictional demo data. Obviously-fake names
// ("Avery Sample", "Demo Patient"), demo ids, 555 phone numbers, fresh
// relative dates. Platform = CareMetric Breathe; tenant = Penn Home Medical
// Supply (pennpaps.com). Therapy-cloud vendors are the real product names
// (ResMed AirView, Philips Care Orchestrator, 3B/React Health). NO real PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, dateOnly, NOW_ISO } from "../fixtures/dates";

// ── Insurance leads (insurance-leads.ts) ──────────────────────────────
// GET /resupply-api/admin/shop/insurance-leads → { rows, counts }
// PATCH /resupply-api/admin/shop/insurance-leads/:id → updated row
//
// NOTE: the public /resupply-api/shop/insurance-leads POST (lead capture)
// is handled in handlers/shop.ts — this is the ADMIN queue surface.
interface InsuranceLeadRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  insuranceCarrier: string | null;
  memberId: string | null;
  groupNumber: string | null;
  prescribingPhysician: string | null;
  notes: string | null;
  status: "new" | "contacted" | "verified" | "closed";
  csrNote: string | null;
  notificationEmailDelivered: boolean | null;
  confirmationEmailDelivered: boolean | null;
  moderatedAt: string | null;
  moderatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const INSURANCE_LEADS: InsuranceLeadRow[] = [
  {
    id: "11111111-1111-4111-8111-000000000001",
    fullName: "Avery Sample",
    email: "avery.sample@example.com",
    phone: "+12155550142",
    dateOfBirth: "1968-04-12",
    insuranceCarrier: "Demo Health Plan",
    memberId: "DEMO-MBR-77810",
    groupNumber: "GRP-5521",
    prescribingPhysician: "Dr. Demo Prescriber",
    notes: "Asked about coverage for a new full-face mask.",
    status: "new",
    csrNote: null,
    notificationEmailDelivered: true,
    confirmationEmailDelivered: true,
    moderatedAt: null,
    moderatedBy: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  },
  {
    id: "11111111-1111-4111-8111-000000000002",
    fullName: "Jordan Fixture",
    email: "jordan.fixture@example.com",
    phone: "+12155550188",
    dateOfBirth: "1975-11-30",
    insuranceCarrier: "Demo Medicaid MCO",
    memberId: "DEMO-MCO-21034",
    groupNumber: null,
    prescribingPhysician: "Dr. Sample Physician",
    notes: null,
    status: "contacted",
    csrNote: "Left voicemail; will call back Thursday.",
    notificationEmailDelivered: true,
    confirmationEmailDelivered: true,
    moderatedAt: daysAgo(2),
    moderatedBy: "demo.csr@caremetric.example",
    createdAt: daysAgo(4),
    updatedAt: daysAgo(2),
  },
  {
    id: "11111111-1111-4111-8111-000000000003",
    fullName: "Quinn Mockton",
    email: "quinn.mockton@example.com",
    phone: "+12155550173",
    dateOfBirth: "1982-07-08",
    insuranceCarrier: "Demo PPO",
    memberId: "DEMO-PPO-90455",
    groupNumber: "GRP-1180",
    prescribingPhysician: null,
    notes: "Verified active — ready to start a resupply order.",
    status: "verified",
    csrNote: "Eligibility confirmed active through year-end.",
    notificationEmailDelivered: true,
    confirmationEmailDelivered: true,
    moderatedAt: daysAgo(6),
    moderatedBy: "demo.csr@caremetric.example",
    createdAt: daysAgo(9),
    updatedAt: daysAgo(6),
  },
  {
    id: "11111111-1111-4111-8111-000000000004",
    fullName: "Demo Patient",
    email: "demo.patient@example.com",
    phone: "+12155550100",
    dateOfBirth: "1959-02-21",
    insuranceCarrier: "Demo Advantage",
    memberId: "DEMO-ADV-33120",
    groupNumber: null,
    prescribingPhysician: "Dr. Demo Prescriber",
    notes: null,
    status: "closed",
    csrNote: "Patient went with a different supplier. Closed.",
    notificationEmailDelivered: true,
    confirmationEmailDelivered: false,
    moderatedAt: daysAgo(20),
    moderatedBy: "demo.csr@caremetric.example",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(20),
  },
];

function insuranceLeadsList(status: string): {
  rows: InsuranceLeadRow[];
  counts: Record<InsuranceLeadRow["status"], number>;
} {
  const counts: Record<InsuranceLeadRow["status"], number> = {
    new: INSURANCE_LEADS.filter((l) => l.status === "new").length,
    contacted: INSURANCE_LEADS.filter((l) => l.status === "contacted").length,
    verified: INSURANCE_LEADS.filter((l) => l.status === "verified").length,
    closed: INSURANCE_LEADS.filter((l) => l.status === "closed").length,
  };
  const rows =
    status === "all" || !status
      ? INSURANCE_LEADS
      : INSURANCE_LEADS.filter((l) => l.status === status);
  return { rows, counts };
}

// ── Insurance discovery (insurance-discovery.ts) ──────────────────────
// POST /resupply-api/admin/billing/insurance-discovery
//   200 { status: "found", coverages, activeCount, latencyMs } | { status: "none", latencyMs }
// Seed a benign "found" result with two synthetic discovered coverages.
function insuranceDiscoveryResult() {
  return {
    status: "found" as const,
    coverages: [
      {
        payerName: "Demo Health Plan",
        payerId: "DEMO01",
        memberId: "DEMO-MBR-77810",
        planName: "Demo Choice PPO",
        isActive: true,
        coverageStart: dateOnly(-400),
        coverageEnd: dateOnly(120),
      },
      {
        payerName: "Demo Advantage",
        payerId: "DEMOADV",
        memberId: "DEMO-ADV-33120",
        planName: "Demo Advantage HMO",
        isActive: false,
        coverageStart: dateOnly(-800),
        coverageEnd: dateOnly(-30),
      },
    ],
    activeCount: 1,
    latencyMs: 842,
  };
}

// ── Inventory reconciliation (inventory-reconciliation.ts) ────────────
// GET  /resupply-api/admin/shop/inventory/reconciliations → { reconciliations }
// GET  /resupply-api/admin/shop/inventory/reconciliations/:id → { reconciliation, lines, currentProducts }
// POST /resupply-api/admin/shop/inventory/reconciliations → 201 { id, startedAt }
// POST /resupply-api/admin/shop/inventory/reconciliations/:id/submit → result
interface ReconciliationListItem {
  id: string;
  periodLabel: string;
  status: "draft" | "submitted";
  startedByEmail: string;
  startedAt: string;
  submittedAt: string | null;
  totalLines: number;
  totalVarianceUnits: number;
  appliedToStripe: boolean;
}

const RECONCILIATIONS: ReconciliationListItem[] = [
  {
    id: "22222222-2222-4222-8222-000000000001",
    periodLabel: dateOnly(-1).slice(0, 7),
    status: "draft",
    startedByEmail: "demo.csr@caremetric.example",
    startedAt: daysAgo(1),
    submittedAt: null,
    totalLines: 0,
    totalVarianceUnits: 0,
    appliedToStripe: false,
  },
  {
    id: "22222222-2222-4222-8222-000000000002",
    periodLabel: dateOnly(-35).slice(0, 7),
    status: "submitted",
    startedByEmail: "demo.csr@caremetric.example",
    startedAt: daysAgo(35),
    submittedAt: daysAgo(34),
    totalLines: 24,
    totalVarianceUnits: 7,
    appliedToStripe: true,
  },
  {
    id: "22222222-2222-4222-8222-000000000003",
    periodLabel: dateOnly(-66).slice(0, 7),
    status: "submitted",
    startedByEmail: "demo.csr@caremetric.example",
    startedAt: daysAgo(66),
    submittedAt: daysAgo(65),
    totalLines: 22,
    totalVarianceUnits: 3,
    appliedToStripe: true,
  },
];

function reconciliationDetail(id: string) {
  const header =
    RECONCILIATIONS.find((r) => r.id === id) ?? RECONCILIATIONS[1]!;
  const isDraft = header.status === "draft";
  const lines = isDraft
    ? []
    : [
        {
          id: "33333333-3333-4333-8333-000000000001",
          productId: "prod_demo_mask_cushion",
          productName: "Nasal Pillow Cushion (Medium)",
          systemCount: 40,
          countedQty: 38,
          variance: -2,
          applied: true,
          createdAt: header.submittedAt ?? daysAgo(34),
        },
        {
          id: "33333333-3333-4333-8333-000000000002",
          productId: "prod_demo_tubing",
          productName: "Standard 6ft Heated Tubing",
          systemCount: 25,
          countedQty: 28,
          variance: 3,
          applied: true,
          createdAt: header.submittedAt ?? daysAgo(34),
        },
        {
          id: "33333333-3333-4333-8333-000000000003",
          productId: "prod_demo_filter",
          productName: "Disposable Fine Filter (2-pack)",
          systemCount: 60,
          countedQty: 58,
          variance: -2,
          applied: true,
          createdAt: header.submittedAt ?? daysAgo(34),
        },
      ];
  const currentProducts = isDraft
    ? [
        {
          productId: "prod_demo_mask_cushion",
          name: "Nasal Pillow Cushion (Medium)",
          category: "Mask parts",
          systemCount: 40,
          lowStockThreshold: 10,
        },
        {
          productId: "prod_demo_tubing",
          name: "Standard 6ft Heated Tubing",
          category: "Tubing",
          systemCount: 25,
          lowStockThreshold: 8,
        },
        {
          productId: "prod_demo_filter",
          name: "Disposable Fine Filter (2-pack)",
          category: "Filters",
          systemCount: 60,
          lowStockThreshold: 15,
        },
      ]
    : null;
  return {
    reconciliation: {
      id: header.id,
      periodLabel: header.periodLabel,
      status: header.status,
      startedByEmail: header.startedByEmail,
      startedByUserId: "demo-user-csr-1",
      startedAt: header.startedAt,
      submittedAt: header.submittedAt,
      notes: isDraft ? null : "Monthly shelf count — demo data.",
      totalLines: header.totalLines,
      totalVarianceUnits: header.totalVarianceUnits,
      appliedToStripe: header.appliedToStripe,
    },
    lines,
    currentProducts,
  };
}

// ── Locations (locations.ts) ──────────────────────────────────────────
// GET   /resupply-api/admin/locations → { locations (RAW snake_case), primaryId }
// GET   /resupply-api/admin/locations/rollup → { branches, unassigned }
// POST  /resupply-api/admin/locations → 201 { id }
// PATCH /resupply-api/admin/locations/:id → { ok: true }
//
// The list endpoint returns raw PostgREST columns (snake_case); the client
// maps to camelCase. So the demo MUST return snake_case rows here.
interface RawLocation {
  id: string;
  name: string;
  code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone_e164: string | null;
  npi: string | null;
  is_primary: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const LOCATIONS: RawLocation[] = [
  {
    id: "44444444-4444-4444-8444-000000000001",
    name: "Penn Home Medical Supply — Main",
    code: "MAIN",
    address_line1: "120 Market Street",
    address_line2: "Suite 200",
    city: "Philadelphia",
    state: "PA",
    postal_code: "19106",
    phone_e164: "+12155550100",
    npi: "1234567893",
    is_primary: true,
    is_active: true,
    created_at: daysAgo(420),
    updated_at: daysAgo(30),
  },
  {
    id: "44444444-4444-4444-8444-000000000002",
    name: "Penn Home Medical Supply — West Branch",
    code: "WEST",
    address_line1: "5500 Lancaster Avenue",
    address_line2: null,
    city: "Philadelphia",
    state: "PA",
    postal_code: "19131",
    phone_e164: "+12155550155",
    npi: null,
    is_primary: false,
    is_active: true,
    created_at: daysAgo(180),
    updated_at: daysAgo(12),
  },
  {
    id: "44444444-4444-4444-8444-000000000003",
    name: "Penn Home Medical Supply — Warehouse (Legacy)",
    code: "WH1",
    address_line1: "9 Industrial Way",
    address_line2: null,
    city: "King of Prussia",
    state: "PA",
    postal_code: "19406",
    phone_e164: null,
    npi: null,
    is_primary: false,
    is_active: false,
    created_at: daysAgo(700),
    updated_at: daysAgo(200),
  },
];

function locationsRollup() {
  return {
    branches: [
      {
        locationId: LOCATIONS[0]!.id,
        name: LOCATIONS[0]!.name,
        isActive: true,
        patientCount: 412,
        activePatientCount: 388,
        staffCount: 9,
      },
      {
        locationId: LOCATIONS[1]!.id,
        name: LOCATIONS[1]!.name,
        isActive: true,
        patientCount: 137,
        activePatientCount: 121,
        staffCount: 4,
      },
      {
        locationId: LOCATIONS[2]!.id,
        name: LOCATIONS[2]!.name,
        isActive: false,
        patientCount: 0,
        activePatientCount: 0,
        staffCount: 0,
      },
    ],
    unassigned: { patientCount: 18, activePatientCount: 14, staffCount: 1 },
  };
}

// ── Global lookup bar (lookup.ts) ─────────────────────────────────────
// GET /resupply-api/admin/lookup?q=… → { q, hits }
// PHI policy: phone/email never echoed; only ids, labels, hrefs, hints.
interface LookupHit {
  kind:
    | "patient"
    | "conversation"
    | "episode"
    | "fulfillment"
    | "shop_order"
    | "shop_customer";
  id: string;
  label: string;
  href: string;
  hint?: string | null;
}

function lookupHits(q: string): { q: string; hits: LookupHit[] } {
  if (q.length < 3) return { q, hits: [] };
  // A small, realistic mixed result set that always returns for the demo
  // regardless of the typed query (so the lookup bar shows something).
  const hits: LookupHit[] = [
    {
      kind: "patient",
      id: "demo-p-2004",
      label: "Avery Sample",
      href: "/admin/patients/demo-p-2004",
      hint: "PACware #PW-10004",
    },
    {
      kind: "patient",
      id: "demo-p-2005",
      label: "Quinn Mockton",
      href: "/admin/patients/demo-p-2005",
      hint: "PACware #PW-12005",
    },
    {
      kind: "conversation",
      id: "demo-conv-9001",
      label: "Conversation · sms · open",
      href: "/admin/conversations/demo-conv-9001",
    },
    {
      kind: "shop_order",
      id: "demo-order-7001",
      label: "Shop order · paid · $129.00",
      href: "/admin/shop/returns?orderId=demo-order-7001",
      hint: "abcdef123456",
    },
  ];
  return { q, hits };
}

// ── Manual document packets (manual-document-packets.ts) ──────────────
// GET  /resupply-api/admin/manual-document-packets → { packets } (RAW snake_case)
// GET  /resupply-api/admin/manual-document-packets/:id → { packet, documents, missingDocumentIds }
// POST /resupply-api/admin/manual-document-packets → 201 { id, status }
// PATCH/DELETE → { ok: true }
// (PDF / send-email / send-fax skipped — binary/transmission endpoints.)
interface PacketSummary {
  id: string;
  title: string;
  recipient_name: string | null;
  recipient_address: string | null;
  recipient_email: string | null;
  recipient_fax_e164: string | null;
  document_ids: string[];
  include_cover_sheet: boolean;
  status: "draft" | "sent";
  last_emailed_at: string | null;
  last_faxed_at: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

const PACKETS: PacketSummary[] = [
  {
    id: "55555555-5555-4555-8555-000000000001",
    title: "Avery Sample — Setup paperwork packet",
    recipient_name: "Dr. Demo Prescriber",
    recipient_address: "Demo Sleep Clinic, 400 Clinical Way, Philadelphia, PA",
    recipient_email: "records@demosleepclinic.example",
    recipient_fax_e164: "+12155550101",
    document_ids: [
      "66666666-6666-4666-8666-000000000001",
      "66666666-6666-4666-8666-000000000002",
    ],
    include_cover_sheet: true,
    status: "draft",
    last_emailed_at: null,
    last_faxed_at: null,
    created_by_email: "demo.csr@caremetric.example",
    created_at: daysAgo(1),
    updated_at: daysAgo(1),
  },
  {
    id: "55555555-5555-4555-8555-000000000002",
    title: "Quinn Mockton — CMN + delivery packet",
    recipient_name: "Dr. Sample Physician",
    recipient_address: "Fixture Pulmonary, 88 Health Plaza, Philadelphia, PA",
    recipient_email: null,
    recipient_fax_e164: "+12155550109",
    document_ids: ["66666666-6666-4666-8666-000000000003"],
    include_cover_sheet: true,
    status: "sent",
    last_emailed_at: null,
    last_faxed_at: daysAgo(3),
    created_by_email: "demo.csr@caremetric.example",
    created_at: daysAgo(5),
    updated_at: daysAgo(3),
  },
];

const PACKET_MEMBERS: Record<
  string,
  Array<{ id: string; document_type: string; title: string; status: string }>
> = {
  "55555555-5555-4555-8555-000000000001": [
    {
      id: "66666666-6666-4666-8666-000000000001",
      document_type: "cmn",
      title: "Certificate of Medical Necessity",
      status: "draft",
    },
    {
      id: "66666666-6666-4666-8666-000000000002",
      document_type: "delivery_ticket",
      title: "Delivery / Proof-of-Delivery ticket",
      status: "draft",
    },
  ],
  "55555555-5555-4555-8555-000000000002": [
    {
      id: "66666666-6666-4666-8666-000000000003",
      document_type: "cmn",
      title: "Certificate of Medical Necessity",
      status: "sent",
    },
  ],
};

function packetDetail(id: string) {
  const packet = PACKETS.find((p) => p.id === id) ?? PACKETS[0]!;
  return {
    packet,
    documents: PACKET_MEMBERS[packet.id] ?? [],
    missingDocumentIds: [] as string[],
  };
}

// ── Message-template overrides (message-template-overrides.ts) ────────
// GET    /resupply-api/admin/shop/customers/:userId/message-template-overrides → { overrides }
// POST   …                                                                     → 201 { override }
// PATCH  …/:id                                                                  → { override }
// DELETE …/:id                                                                  → { override }
interface OverrideView {
  id: string;
  customerId: string;
  templateKey: string;
  channel: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

function overridesFor(userId: string): OverrideView[] {
  return [
    {
      id: "77777777-7777-4777-8777-000000000001",
      customerId: userId,
      templateKey: "resupply.reminder",
      channel: "sms",
      subject: null,
      bodyHtml: null,
      bodyText:
        "Hi {{firstName}}, it's time for your CPAP resupply. Reply YES to confirm.",
      isActive: true,
      note: "Customer prefers a shorter SMS than the global default.",
      createdAt: daysAgo(14),
      createdBy: "demo.csr@caremetric.example",
      updatedAt: daysAgo(14),
      updatedBy: "demo.csr@caremetric.example",
    },
    {
      id: "77777777-7777-4777-8777-000000000002",
      customerId: userId,
      templateKey: "order.shipped",
      channel: "email",
      subject: "Your Penn Home Medical Supply order is on its way",
      bodyHtml: "<p>Hi {{firstName}}, your order has shipped.</p>",
      bodyText: "Hi {{firstName}}, your order has shipped.",
      isActive: false,
      note: "Old override — deactivated after the global copy was refreshed.",
      createdAt: daysAgo(60),
      createdBy: "demo.csr@caremetric.example",
      updatedAt: daysAgo(20),
      updatedBy: "demo.csr@caremetric.example",
    },
  ];
}

function newOverride(userId: string, body: unknown): OverrideView {
  const b = (body ?? {}) as {
    templateKey?: string;
    channel?: string;
    subject?: string | null;
    bodyHtml?: string | null;
    bodyText?: string | null;
    isActive?: boolean;
    note?: string;
  };
  return {
    id: "77777777-7777-4777-8777-0000000000ff",
    customerId: userId,
    templateKey: b.templateKey ?? "resupply.reminder",
    channel: b.channel ?? "sms",
    subject: b.subject ?? null,
    bodyHtml: b.bodyHtml ?? null,
    bodyText: b.bodyText ?? null,
    isActive: b.isActive ?? true,
    note: b.note ?? null,
    createdAt: NOW_ISO(),
    createdBy: "demo.csr@caremetric.example",
    updatedAt: NOW_ISO(),
    updatedBy: "demo.csr@caremetric.example",
  };
}

export const ext4Handlers: DemoHandler[] = [
  // ── Insurance leads (admin queue) ───────────────────────────────────
  route("GET", "/resupply-api/admin/shop/insurance-leads", (req) =>
    json(insuranceLeadsList(req.query.get("status") ?? "all")),
  ),
  route("PATCH", "/resupply-api/admin/shop/insurance-leads/:id", (req, p) => {
    const body = req.json<{
      status?: InsuranceLeadRow["status"];
      csrNote?: string | null;
    }>();
    const existing =
      INSURANCE_LEADS.find((l) => l.id === p.id) ?? INSURANCE_LEADS[0]!;
    return json({
      id: existing.id,
      status: body?.status ?? existing.status,
      csrNote: body?.csrNote !== undefined ? body.csrNote : existing.csrNote,
      moderatedAt: NOW_ISO(),
      moderatedBy: "demo.csr@caremetric.example",
      updatedAt: NOW_ISO(),
    });
  }),

  // ── Insurance discovery (paid add-on; POST-only) ────────────────────
  route("POST", "/resupply-api/admin/billing/insurance-discovery", () =>
    json(insuranceDiscoveryResult()),
  ),

  // ── Therapy-integration sync actions (benign success) ───────────────
  // NOTE: POST /resupply-api/admin/integrations/nightly-sync is already
  // seeded in handlers/integrations-comms.ts — not repeated here.
  route(
    "POST",
    "/resupply-api/admin/patients/:id/integrations/refresh-supplies",
    () =>
      json({
        refreshed: 2,
        sources: ["resmed_airview", "philips_care_orchestrator"],
        failed: 0,
      }),
  ),
  route(
    "POST",
    "/resupply-api/admin/patients/:id/integrations/sync-equipment",
    () => json({ scanned: 3, linked: 1, recallsQueued: 0, skipped: 2 }),
  ),

  // ── Inventory reconciliation ────────────────────────────────────────
  route("GET", "/resupply-api/admin/shop/inventory/reconciliations", () =>
    json({ reconciliations: RECONCILIATIONS }),
  ),
  route(
    "GET",
    "/resupply-api/admin/shop/inventory/reconciliations/:id",
    (_req, p) => json(reconciliationDetail(p.id)),
  ),
  route("POST", "/resupply-api/admin/shop/inventory/reconciliations", () =>
    json(
      {
        id: "22222222-2222-4222-8222-0000000000ff",
        startedAt: NOW_ISO(),
      },
      201,
    ),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/inventory/reconciliations/:id/submit",
    (req, p) => {
      const body = req.json<{ lines?: unknown[]; applyToStripe?: boolean }>();
      const lineCount = Array.isArray(body?.lines) ? body!.lines.length : 0;
      return json({
        id: p.id,
        totalLines: lineCount,
        totalVarianceUnits: 0,
        appliedToStripe: body?.applyToStripe ?? false,
        stripeApplyFailures: 0,
      });
    },
  ),

  // ── Locations ───────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/locations/rollup", () =>
    json(locationsRollup()),
  ),
  route("GET", "/resupply-api/admin/locations", () =>
    json({
      locations: LOCATIONS,
      primaryId: LOCATIONS.find((l) => l.is_primary)?.id ?? null,
    }),
  ),
  route("POST", "/resupply-api/admin/locations", () =>
    json({ id: "44444444-4444-4444-8444-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/locations/:id", () => json({ ok: true })),

  // ── Global lookup bar ───────────────────────────────────────────────
  route("GET", "/resupply-api/admin/lookup", (req) =>
    json(lookupHits((req.query.get("q") ?? "").trim())),
  ),

  // ── Manual claim entry (benign success in the route's shape) ────────
  route("POST", "/resupply-api/admin/patients/:id/manual-claims", (req) => {
    const body = req.json<{
      claimFrequencyCode?: "1" | "7" | "8";
      originalClaimNumber?: string | null;
      lines?: Array<{ billedCents?: number }>;
    }>();
    const freq = body?.claimFrequencyCode ?? "1";
    const entrySource = freq === "7" || freq === "8" ? "adjustment" : "manual";
    const lines = Array.isArray(body?.lines) ? body!.lines : [];
    const totalBilledCents = lines.reduce(
      (sum, l) => sum + (typeof l.billedCents === "number" ? l.billedCents : 0),
      0,
    );
    return json(
      {
        id: "88888888-8888-4888-8888-0000000000ff",
        entrySource,
        claimFrequencyCode: freq,
        lineCount: lines.length,
        totalBilledCents,
      },
      201,
    );
  }),

  // ── Manual document packets ─────────────────────────────────────────
  route("GET", "/resupply-api/admin/manual-document-packets", (req) => {
    const status = req.query.get("status");
    const packets =
      status === "draft" || status === "sent"
        ? PACKETS.filter((p) => p.status === status)
        : PACKETS;
    return json({ packets });
  }),
  route("GET", "/resupply-api/admin/manual-document-packets/:id", (_req, p) =>
    json(packetDetail(p.id)),
  ),
  route("POST", "/resupply-api/admin/manual-document-packets", () =>
    json({ id: "55555555-5555-4555-8555-0000000000ff", status: "draft" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/manual-document-packets/:id", () =>
    json({ ok: true }),
  ),
  route("DELETE", "/resupply-api/admin/manual-document-packets/:id", () =>
    json({ ok: true }),
  ),

  // ── Per-customer message-template overrides ─────────────────────────
  route(
    "GET",
    "/resupply-api/admin/shop/customers/:userId/message-template-overrides",
    (_req, p) => json({ overrides: overridesFor(p.userId) }),
  ),
  route(
    "POST",
    "/resupply-api/admin/shop/customers/:userId/message-template-overrides",
    (req, p) => json({ override: newOverride(p.userId, req.json()) }, 201),
  ),
  route(
    "PATCH",
    "/resupply-api/admin/shop/customers/:userId/message-template-overrides/:id",
    (req, p) => {
      const base = overridesFor(p.userId)[0]!;
      const body = (req.json() ?? {}) as Partial<OverrideView> & {
        bodyHtml?: string | null;
        bodyText?: string | null;
      };
      return json({
        override: {
          ...base,
          id: p.id,
          subject: body.subject !== undefined ? body.subject : base.subject,
          bodyHtml: body.bodyHtml !== undefined ? body.bodyHtml : base.bodyHtml,
          bodyText: body.bodyText !== undefined ? body.bodyText : base.bodyText,
          isActive: body.isActive !== undefined ? body.isActive : base.isActive,
          note: body.note !== undefined ? body.note : base.note,
          updatedAt: NOW_ISO(),
        },
      });
    },
  ),
  route(
    "DELETE",
    "/resupply-api/admin/shop/customers/:userId/message-template-overrides/:id",
    (_req, p) => {
      const base = overridesFor(p.userId)[0]!;
      return json({
        override: { ...base, id: p.id, isActive: false, updatedAt: NOW_ISO() },
      });
    },
  ),
];
