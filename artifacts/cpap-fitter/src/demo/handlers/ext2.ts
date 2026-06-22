// Conversations / CSR-tools demo handlers (ext2). Seeds the admin
// endpoints that power the shared company calendar, the conversation
// coaching/triage/routing surfaces, the AI draft-reply composer, the
// content search, the CSR macro library, CSR "sign & pay" order
// requests, CSR shift coverage, and walk-in counter ordering.
//
// Each route returns a fully-shaped payload matching the live API
// (see artifacts/resupply-api/src/routes/admin/<name>.ts) so the
// admin pages render realistic sample data instead of the router's
// empty-object GET fallback (which crashes pages that deref nested
// fields / map over arrays).
//
// DATA RULES: everything here is fictional demo data — obviously-fake
// patient/customer names ("Demo Patient", "Avery Sample"), demo ids,
// fresh relative dates. Platform = CareMetric Breathe; the tenant is
// Penn Home Medical Supply (pennpaps.com). NO real PHI.
//
// SKIPPED (handled elsewhere / not suitable for the sandbox):
//   * GET /admin/shop/customers + /:userId — already seeded in
//     handlers/admin.ts (customers.ts maps to the same path).
//   * GET /admin/patients/:id/compliance-attestation — streams a PDF
//     binary; not seeded.
//   * GET /admin/conversations/:id/transcript.csv — streams CSV; not
//     seeded.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, daysFromNow, NOW_ISO } from "../fixtures/dates";

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
): number {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Company calendar (company-calendar.ts) ────────────────────────────
// GET /admin/company-calendar?from=&to=  → { events: CompanyCalendarEvent[] }
function companyCalendarEvents() {
  return {
    events: [
      {
        id: "demo-cal-0001-0000-0000-0000-000000000001",
        patientId: "demo-patient-4",
        patientFirstName: "Avery",
        patientLastName: "Sample",
        eventType: "fitting_in_person" as const,
        status: "scheduled" as const,
        startsAt: daysFromNow(1),
        endsAt: daysFromNow(1),
        location: "Penn Home Medical Supply — Front Desk",
        notes: "New mask fitting; bring nasal-pillow samples",
        createdByUserId: "demo-user-csr-1",
        createdByEmail: "demo.csr@pennpaps.example",
        assignedToUserId: "demo-user-rt-1",
        assignedToEmail: "demo.rt@pennpaps.example",
        createdAt: daysAgo(2),
        updatedAt: daysAgo(2),
      },
      {
        id: "demo-cal-0001-0000-0000-0000-000000000002",
        patientId: "demo-patient-2",
        patientFirstName: "Demo",
        patientLastName: "Patient",
        eventType: "setup_virtual" as const,
        status: "scheduled" as const,
        startsAt: daysFromNow(3),
        endsAt: daysFromNow(3),
        location: "Video visit",
        notes: "First-night setup walkthrough",
        createdByUserId: "demo-user-csr-1",
        createdByEmail: "demo.csr@pennpaps.example",
        assignedToUserId: "demo-user-rt-2",
        assignedToEmail: "demo.rt2@pennpaps.example",
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
      },
      {
        id: "demo-cal-0001-0000-0000-0000-000000000003",
        patientId: "demo-patient-6",
        patientFirstName: "Quinn",
        patientLastName: "Mockton",
        eventType: "follow_up" as const,
        status: "completed" as const,
        startsAt: daysAgo(4),
        endsAt: daysAgo(4),
        location: "Phone",
        notes: "30-day adherence check — doing well",
        createdByUserId: "demo-user-rt-1",
        createdByEmail: "demo.rt@pennpaps.example",
        assignedToUserId: null,
        assignedToEmail: null,
        createdAt: daysAgo(10),
        updatedAt: daysAgo(4),
      },
    ],
  };
}

// GET /admin/company-calendar/assignable-staff → { staff: AssignableStaff[] }
function assignableStaff() {
  return {
    staff: [
      {
        userId: "demo-user-rt-1",
        email: "demo.rt@pennpaps.example",
        displayName: "Demo RT",
      },
      {
        userId: "demo-user-rt-2",
        email: "demo.rt2@pennpaps.example",
        displayName: "Sample Therapist",
      },
      {
        userId: "demo-user-csr-1",
        email: "demo.csr@pennpaps.example",
        displayName: "Demo CSR",
      },
    ],
  };
}

// ── Conversation coaching notes (conversation-coaching-notes.ts) ──────
// GET /admin/conversations/:id/coaching-notes → { notes: [...] }
function conversationCoachingNotes(conversationId: string) {
  return {
    notes: [
      {
        id: "demo-coach-0001",
        conversationId,
        targetUserId: "demo-user-csr-1",
        authorUserId: "demo-user-admin-1",
        kind: "praise" as const,
        body: "Great empathy on the leak complaint — you reassured the patient before jumping to a fix.",
        createdAt: daysAgo(2),
        updatedAt: daysAgo(2),
      },
      {
        id: "demo-coach-0002",
        conversationId,
        targetUserId: "demo-user-csr-1",
        authorUserId: "demo-user-admin-1",
        kind: "suggestion" as const,
        body: "Next time, confirm the device serial before promising a replacement cushion size.",
        createdAt: daysAgo(5),
        updatedAt: daysAgo(5),
      },
    ],
  };
}

// GET /admin/team/:userId/coaching-notes → { counts, notes: [...] }
function teamCoachingNotes() {
  const notes = [
    {
      id: "demo-coach-0001",
      conversationId: "demo-conv-1",
      authorUserId: "demo-user-admin-1",
      kind: "praise" as const,
      body: "Great empathy on the leak complaint.",
      createdAt: daysAgo(2),
    },
    {
      id: "demo-coach-0002",
      conversationId: "demo-conv-3",
      authorUserId: "demo-user-admin-1",
      kind: "suggestion" as const,
      body: "Confirm the device serial before promising a replacement.",
      createdAt: daysAgo(5),
    },
    {
      id: "demo-coach-0003",
      conversationId: "demo-conv-2",
      authorUserId: "demo-user-admin-1",
      kind: "concern" as const,
      body: "Response time on this thread slipped past 24h — flag busy days early.",
      createdAt: daysAgo(12),
    },
  ];
  const counts = notes.reduce<Record<string, number>>((acc, n) => {
    acc[n.kind] = (acc[n.kind] ?? 0) + 1;
    return acc;
  }, {});
  return { counts, notes };
}

// ── Conversation routing (conversation-routing.ts) ────────────────────
// GET /admin/conversations/:id/assignee-suggestions
//   → { requiredSkills, candidates: [...] }
function assigneeSuggestions() {
  const requiredSkills = ["billing", "mask_fit"];
  return {
    requiredSkills,
    candidates: [
      {
        adminUserId: "demo-user-rt-1",
        displayName: "Demo RT",
        email: "demo.rt@pennpaps.example",
        role: "supervisor",
        skills: ["mask_fit", "billing", "adherence"],
        matchedSkillCount: 2,
        coversAll: true,
        openQueueSize: 3,
      },
      {
        adminUserId: "demo-user-csr-1",
        displayName: "Demo CSR",
        email: "demo.csr@pennpaps.example",
        role: "csr",
        skills: ["billing"],
        matchedSkillCount: 1,
        coversAll: false,
        openQueueSize: 5,
      },
      {
        adminUserId: "demo-user-rt-2",
        displayName: "Sample Therapist",
        email: "demo.rt2@pennpaps.example",
        role: "csr",
        skills: ["mask_fit"],
        matchedSkillCount: 1,
        coversAll: false,
        openQueueSize: 1,
      },
    ],
  };
}

// ── Conversations content search (conversations-search.ts) ────────────
// GET /admin/conversations-search?q= → { results, count }
function conversationsSearch(q: string) {
  const results = [
    {
      conversationId: "demo-conv-1",
      snippet: `My mask keeps leaking around the top — could that be the "${q}" issue you mentioned?`,
      direction: "inbound",
      matchedAt: daysAgo(1),
    },
    {
      conversationId: "demo-conv-3",
      snippet: `Thanks for the help with my ${q} order, the new cushion fits great.`,
      direction: "inbound",
      matchedAt: daysAgo(4),
    },
  ];
  return { results, count: results.length };
}

// ── CSR macros (csr-macros.ts) ────────────────────────────────────────
// GET /admin/csr-macros → { macros: [...] }
const CSR_MACROS = [
  {
    id: "demo-macro-0001",
    key: "leak-troubleshoot",
    label: "Mask leak — first steps",
    category: "troubleshooting",
    body: "Sorry to hear about the leak! Try repositioning the cushion with the headgear slightly looser, then reseal. If it persists, reply here and we'll size you for a different cushion.",
    channels: ["sms", "email"],
    isActive: true,
    sortOrder: 10,
    createdAt: daysAgo(40),
    updatedAt: daysAgo(8),
    createdBy: "demo-user-admin-1",
    updatedBy: "demo-user-admin-1",
  },
  {
    id: "demo-macro-0002",
    key: "resupply-eligible",
    label: "Resupply now eligible",
    category: "resupply",
    body: "Good news — your supplies are due for replacement and covered. Reply YES and we'll ship your refill.",
    channels: ["sms"],
    isActive: true,
    sortOrder: 20,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(15),
    createdBy: "demo-user-admin-1",
    updatedBy: "demo-user-csr-1",
  },
  {
    id: "demo-macro-0003",
    key: "insurance-update",
    label: "Insurance on file needs update",
    category: "billing",
    body: "Before we can ship your next order, we need to confirm your current insurance. Reply with your member ID or call us at the number on your card.",
    channels: ["email"],
    isActive: true,
    sortOrder: 30,
    createdAt: daysAgo(90),
    updatedAt: daysAgo(30),
    createdBy: "demo-user-admin-1",
    updatedBy: "demo-user-admin-1",
  },
];

function csrMacroById(id: string, patch: Record<string, unknown>) {
  const base = CSR_MACROS.find((m) => m.id === id) ?? CSR_MACROS[0]!;
  return { ...base, id, ...patch, updatedAt: NOW_ISO() };
}

// ── CSR order requests (csr-order-requests.ts) ────────────────────────
// GET /admin/csr-order-requests → { requests, total, page, pageSize }
const CSR_ORDER_REQUESTS = [
  {
    id: "demo-csro-0001",
    orderReference: "PHM-DEMO-1001",
    status: "signed" as const,
    customerName: "Avery Sample",
    customerEmail: "avery.sample@example.com",
    customerPhone: "+15555550101",
    items: [
      {
        description: "Nasal pillow cushion (M)",
        quantity: 2,
        unitAmountCents: 2400,
      },
      {
        description: "Headgear replacement",
        quantity: 1,
        unitAmountCents: 3200,
      },
    ],
    amountTotalCents: 8000,
    currency: "usd",
    noteToCustomer: "Replacement supplies as discussed on your call.",
    documents: [
      {
        key: "abn",
        title: "Advance Beneficiary Notice",
        requiresSignature: true,
      },
    ],
    expiresAt: daysFromNow(10),
    sentAt: daysAgo(3),
    firstViewedAt: daysAgo(2),
    signedAt: daysAgo(2),
    signerName: "Avery Sample",
    canceledAt: null,
    payment: {
      status: "paid",
      paidAt: daysAgo(2),
      shopOrderId: "demo-order-9101",
    },
    createdByEmail: "demo.csr@pennpaps.example",
    createdAt: daysAgo(3),
  },
  {
    id: "demo-csro-0002",
    orderReference: "PHM-DEMO-1002",
    status: "sent" as const,
    customerName: "Demo Patient",
    customerEmail: "demo.patient@example.com",
    customerPhone: null,
    items: [
      {
        description: "CPAP tubing (heated)",
        quantity: 1,
        unitAmountCents: 4500,
      },
    ],
    amountTotalCents: 4500,
    currency: "usd",
    noteToCustomer: null,
    documents: [],
    expiresAt: daysFromNow(13),
    sentAt: daysAgo(1),
    firstViewedAt: null,
    signedAt: null,
    signerName: null,
    canceledAt: null,
    payment: { status: "not_started", paidAt: null, shopOrderId: null },
    createdByEmail: "demo.csr@pennpaps.example",
    createdAt: daysAgo(1),
  },
  {
    id: "demo-csro-0003",
    orderReference: "PHM-DEMO-1003",
    status: "viewed" as const,
    customerName: "Quinn Mockton",
    customerEmail: "quinn.mockton@example.com",
    customerPhone: "+15555550144",
    items: [
      {
        description: "Disposable filters (6-pack)",
        quantity: 1,
        unitAmountCents: 1800,
      },
      { description: "Water chamber", quantity: 1, unitAmountCents: 2900 },
    ],
    amountTotalCents: 4700,
    currency: "usd",
    noteToCustomer: "Pick-up or ship — let us know which you prefer.",
    documents: [],
    expiresAt: daysFromNow(6),
    sentAt: daysAgo(2),
    firstViewedAt: daysAgo(1),
    signedAt: null,
    signerName: null,
    canceledAt: null,
    payment: { status: "not_started", paidAt: null, shopOrderId: null },
    createdByEmail: "demo.csr@pennpaps.example",
    createdAt: daysAgo(2),
  },
];

function csrOrderRequestsList(
  status: string | null,
  page: number,
  pageSize: number,
) {
  const filtered = status
    ? CSR_ORDER_REQUESTS.filter((r) => r.status === status)
    : CSR_ORDER_REQUESTS;
  return { requests: filtered, total: filtered.length, page, pageSize };
}

function csrOrderRequestDetail(id: string) {
  const row =
    CSR_ORDER_REQUESTS.find((r) => r.id === id) ?? CSR_ORDER_REQUESTS[0]!;
  return {
    request: { ...row, id },
    signingLink: row.canceledAt
      ? null
      : `https://pennpaps.com/order/${id}?v=1&sig=demo-signature`,
  };
}

// ── CSR shifts (csr-shifts.ts) ────────────────────────────────────────
// GET /admin/csr-shifts → { shifts: [...] }
function csrShifts() {
  return {
    shifts: [
      {
        id: "demo-shift-0001",
        staffUserId: "demo-user-csr-1",
        startsAt: daysAgo(0),
        endsAt: daysFromNow(0),
        status: "actual" as const,
        notes: "Front desk + inbox",
        createdAt: daysAgo(5),
        updatedAt: daysAgo(5),
      },
      {
        id: "demo-shift-0002",
        staffUserId: "demo-user-rt-1",
        startsAt: daysFromNow(1),
        endsAt: daysFromNow(1),
        status: "scheduled" as const,
        notes: "Fittings",
        createdAt: daysAgo(4),
        updatedAt: daysAgo(4),
      },
      {
        id: "demo-shift-0003",
        staffUserId: "demo-user-rt-2",
        startsAt: daysFromNow(2),
        endsAt: daysFromNow(2),
        status: "scheduled" as const,
        notes: null,
        createdAt: daysAgo(3),
        updatedAt: daysAgo(3),
      },
    ],
  };
}

// GET /admin/csr-shifts/on-now → { onShift: [...] }
function csrShiftsOnNow() {
  return {
    onShift: [
      {
        id: "demo-shift-0001",
        staffUserId: "demo-user-csr-1",
        startsAt: daysAgo(0),
        endsAt: daysFromNow(0),
        status: "actual" as const,
      },
    ],
  };
}

export const ext2Handlers: DemoHandler[] = [
  // ── Company calendar ────────────────────────────────────────────────
  // assignable-staff MUST be registered before the generic
  // /:id matchers below (it is a static sibling of the list route).
  route("GET", "/resupply-api/admin/company-calendar/assignable-staff", () =>
    json(assignableStaff()),
  ),
  route("GET", "/resupply-api/admin/company-calendar", () =>
    json(companyCalendarEvents()),
  ),
  route("POST", "/resupply-api/admin/company-calendar", () =>
    json({ id: "demo-cal-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/company-calendar/:id", () =>
    json({ ok: true }),
  ),
  route("DELETE", "/resupply-api/admin/company-calendar/:id", () =>
    json({ ok: true }),
  ),

  // ── Conversation coaching notes ─────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/conversations/:id/coaching-notes",
    (_req, { id }) => json(conversationCoachingNotes(id)),
  ),
  route("POST", "/resupply-api/admin/conversations/:id/coaching-notes", () =>
    json({ id: "demo-coach-00ff" }, 201),
  ),
  route("GET", "/resupply-api/admin/team/:userId/coaching-notes", () =>
    json(teamCoachingNotes()),
  ),

  // ── Conversation draft reply (AI composer; benign canned draft) ─────
  route("POST", "/resupply-api/admin/conversations/:id/draft-reply", () =>
    json({
      available: true,
      draft:
        "Thanks for reaching out! I'm sorry the mask has been leaking. Let's try repositioning the cushion with the headgear a touch looser, then reseal while lying down. If it's still leaking after that, just reply here and we'll get you sized for a different cushion right away.",
      provider: "anthropic",
      redactions: 0,
    }),
  ),

  // ── Conversation routing ────────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/conversations/:id/assignee-suggestions",
    () => json(assigneeSuggestions()),
  ),
  route("POST", "/resupply-api/admin/conversations/:id/auto-assign", () =>
    json({
      assigned: true,
      adminUserId: "demo-user-rt-1",
      matchedSkillCount: 2,
    }),
  ),
  route(
    "PATCH",
    "/resupply-api/admin/conversations/:id/required-skills",
    (req) => {
      const body = req.json<{ requiredSkills?: string[] }>() ?? {};
      return json({ ok: true, requiredSkills: body.requiredSkills ?? [] });
    },
  ),
  route("PATCH", "/resupply-api/admin/team/:id/skills", (req) => {
    const body = req.json<{ skills?: string[] }>() ?? {};
    return json({ ok: true, skills: body.skills ?? [] });
  }),

  // ── Conversation triage (snooze / tags / claim) ────────────────────
  route("PATCH", "/resupply-api/admin/conversations/:id/snooze", (req) => {
    const body = req.json<{ snoozedUntil?: string | null }>() ?? {};
    return json({
      ok: true,
      snoozedUntil: body.snoozedUntil ?? daysFromNow(1),
    });
  }),
  route("PATCH", "/resupply-api/admin/conversations/:id/tags", (req) => {
    const body = req.json<{ tags?: string[] }>() ?? {};
    return json({ ok: true, tags: body.tags ?? [] });
  }),
  route("POST", "/resupply-api/admin/conversations/:id/claim", () =>
    json({ ok: true }),
  ),

  // ── Conversations content search ────────────────────────────────────
  route("GET", "/resupply-api/admin/conversations-search", (req) =>
    json(conversationsSearch(req.query.get("q") ?? "mask")),
  ),

  // ── Counter orders (walk-in front desk; benign created order) ───────
  route("POST", "/resupply-api/admin/shop/counter-orders", (req) => {
    const body =
      req.json<{
        paymentMethod?: "cash" | "insurance";
        fulfillmentMethod?: "pickup" | "ship";
      }>() ?? {};
    const paymentMethod =
      body.paymentMethod === "insurance" ? "insurance" : "cash";
    const fulfillmentMethod =
      body.fulfillmentMethod === "ship" ? "ship" : "pickup";
    return json(
      {
        order: {
          id: "demo-order-counter-0001",
          status: paymentMethod === "cash" ? "paid" : "pending",
          source: "counter",
          paymentMethod,
          fulfillmentMethod,
          pickupLocationId:
            fulfillmentMethod === "pickup" ? "demo-pickup-loc-1" : null,
          amountTotalCents: 6400,
          currency: "usd",
          itemCount: 2,
        },
      },
      201,
    );
  }),

  // ── CSR macros ──────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/csr-macros", (req) => {
    const includeInactive = req.query.get("includeInactive") === "1";
    const macros = includeInactive
      ? CSR_MACROS
      : CSR_MACROS.filter((m) => m.isActive);
    return json({ macros });
  }),
  route("POST", "/resupply-api/admin/csr-macros", (req) => {
    const body =
      req.json<{
        key?: string;
        label?: string;
        category?: string | null;
        body?: string;
        channels?: string[];
        sortOrder?: number;
      }>() ?? {};
    return json(
      {
        macro: {
          id: "demo-macro-00ff",
          key: body.key ?? "demo-macro",
          label: body.label ?? "Demo macro",
          category: body.category ?? null,
          body: body.body ?? "",
          channels: body.channels ?? ["sms"],
          isActive: true,
          sortOrder: body.sortOrder ?? 100,
          createdAt: NOW_ISO(),
          updatedAt: NOW_ISO(),
          createdBy: "demo-user-admin-1",
          updatedBy: "demo-user-admin-1",
        },
      },
      201,
    );
  }),
  route("PATCH", "/resupply-api/admin/csr-macros/:id", (req, { id }) => {
    const body = req.json<Record<string, unknown>>() ?? {};
    return json({ macro: csrMacroById(id, body) });
  }),
  route("DELETE", "/resupply-api/admin/csr-macros/:id", (req) => {
    const hard = req.query.get("hard") === "1";
    return json({ ok: true, hardDeleted: hard });
  }),

  // ── CSR order requests ──────────────────────────────────────────────
  // on-now / list ordering: the static list path is registered first;
  // the /:id detail matcher comes after so it doesn't shadow it.
  route("GET", "/resupply-api/admin/csr-order-requests", (req) =>
    json(
      csrOrderRequestsList(
        req.query.get("status"),
        intParam(req, "page", 1),
        intParam(req, "pageSize", 25),
      ),
    ),
  ),
  route("POST", "/resupply-api/admin/csr-order-requests", () =>
    json(
      {
        id: "demo-csro-00ff",
        orderReference: "PHM-DEMO-1099",
        status: "sent",
        signingLink:
          "https://pennpaps.com/order/demo-csro-00ff?v=1&sig=demo-signature",
        emailSent: true,
        smsSent: false,
      },
      201,
    ),
  ),
  route("GET", "/resupply-api/admin/csr-order-requests/:id", (_req, { id }) =>
    json(csrOrderRequestDetail(id)),
  ),
  route(
    "POST",
    "/resupply-api/admin/csr-order-requests/:id/resend",
    (_req, { id }) =>
      json({
        status: "sent",
        signingLink: `https://pennpaps.com/order/${id}?v=2&sig=demo-signature`,
        emailSent: true,
        smsSent: false,
      }),
  ),
  route("POST", "/resupply-api/admin/csr-order-requests/:id/cancel", () =>
    json({ status: "canceled" }),
  ),

  // ── CSR shifts ──────────────────────────────────────────────────────
  // on-now is a static sibling of the list route — register it first.
  route("GET", "/resupply-api/admin/csr-shifts/on-now", () =>
    json(csrShiftsOnNow()),
  ),
  route("GET", "/resupply-api/admin/csr-shifts", () => json(csrShifts())),
  route("POST", "/resupply-api/admin/csr-shifts", () =>
    json({ id: "demo-shift-00ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/csr-shifts/:id", () =>
    json({ ok: true }),
  ),
];
