// Seed data for the admin console. All names/records are obviously
// fictional — this is a demonstration sandbox, never real PHI.

import type { AdminIdentity } from "@workspace/api-client-react/admin";
import { daysAgo, hoursAgo, daysFromNow, NOW_ISO } from "./dates";

export const DEMO_ADMIN_AUTH = {
  id: "demo-admin-1",
  email: "demo.admin@caremetric.example",
  displayName: "Demo Admin",
  role: "admin" as const,
  emailVerified: true,
  mustChangePassword: false,
};

export function demoAdminIdentity(): AdminIdentity {
  return {
    userId: DEMO_ADMIN_AUTH.id,
    email: DEMO_ADMIN_AUTH.email,
    role: "admin",
    // Grant the full RBAC permission set (the demo admin is an Owner /
    // super_admin) so every nav entry is explorable. These are the exact
    // permission tokens the sidebar's `requiredPermission` checks against
    // (lib/resupply-auth `Permission`), so the whole console renders.
    permissions: [
      "patients.read",
      "patients.update",
      "returns.read",
      "returns.approve",
      "returns.manage",
      "orders.create",
      "compliance.read",
      "compliance.resolve",
      "audit.export",
      "audit.read",
      "admin_team.manage",
      "reports.read",
      "cost.read",
      "cost.write",
      "metrics.read",
      "bulk_campaigns.send",
      "fit_session.override",
      "inventory.read",
      "conversations.manage",
      "admin.tools.manage",
      "clinical.read",
      "clinical.note.write",
      "clinical.intervention.write",
      "cases.read",
      "cases.manage",
      "targets.manage",
      "provider_portal.manage",
      "billing.manage",
      "system.config.manage",
    ],
  };
}

export function demoInboxCounts() {
  return {
    awaitingReplyConversations: 3,
    pendingReturns: 2,
    pendingReviews: 4,
    overdueFollowups: 5,
    newPatientDocuments: 2,
    newInboundFaxes: 1,
    serverTime: NOW_ISO(),
  };
}

export function demoDashboardSummary() {
  return {
    activeConversations: 14,
    awaitingAdmin: 3,
    overdueEpisodes: 5,
    fulfillmentsThisWeek: 42,
    pausedPatients: 6,
    serverTime: NOW_ISO(),
  };
}

const FIRST_NAMES = [
  "Jordan",
  "Casey",
  "Morgan",
  "Riley",
  "Avery",
  "Quinn",
  "Harper",
  "Rowan",
  "Sawyer",
  "Emerson",
  "Devon",
  "Skylar",
];
const LAST_NAMES = [
  "Sample",
  "Demo",
  "Example",
  "Tester",
  "Placeholder",
  "Fictional",
  "Mockford",
  "Sandbox",
  "Trial",
  "Preview",
  "Dummy",
  "Faux",
];

type PatientStatus = "active" | "paused" | "closed";

export function demoPatients(limit = 25, offset = 0, search?: string | null) {
  let all = FIRST_NAMES.map((first, i) => {
    const status: PatientStatus =
      i % 7 === 0 ? "paused" : i % 11 === 0 ? "closed" : "active";
    return {
      id: `demo-patient-${i + 1}`,
      pacwareId: `PW-${10240 + i}`,
      firstName: first,
      lastName: LAST_NAMES[i % LAST_NAMES.length],
      status,
      hasPhone: i % 3 !== 0,
      hasEmail: true,
      createdAt: daysAgo(120 - i * 5),
      updatedAt: daysAgo(i),
      lastMessageAt: i % 2 === 0 ? hoursAgo(i + 1) : null,
      lastMessageDirection: i % 2 === 0 ? ("inbound" as const) : null,
      lastMessagePreview:
        i % 2 === 0
          ? "Hi, I wanted to check on my next resupply shipment."
          : null,
    };
  });
  const q = (search ?? "").trim().toLowerCase();
  if (q.length > 0) {
    all = all.filter((p) =>
      `${p.firstName} ${p.lastName} ${p.pacwareId}`.toLowerCase().includes(q),
    );
  }
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, limit, offset };
}

// Full patient detail (header + the four related-record arrays the
// page derefs for its tab counts) for /resupply-api/patients/:id.
// Without this the detail GET hits the router's empty-object fallback
// and `data.episodes.length` (and its siblings) throw into the global
// ErrorBoundary the instant a demo explorer clicks a roster row.
export function demoPatientDetail(id: string) {
  const n = Number.parseInt(id.replace(/\D/g, ""), 10) || 1;
  const i = n - 1;
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const last = LAST_NAMES[i % LAST_NAMES.length];
  const status: PatientStatus =
    i % 7 === 0 ? "paused" : i % 11 === 0 ? "closed" : "active";
  const rxId = `demo-rx-${n}`;
  const epId = `demo-ep-${n}`;
  return {
    id,
    pacwareId: `PW-${10240 + i}`,
    firstName: first,
    lastName: last,
    status,
    hasPhone: i % 3 !== 0,
    hasEmail: true,
    insurancePayer: "Aetna PPO",
    cadenceOverrideDays: null,
    channelPreference: null,
    locationId: null,
    locationName: null,
    createdAt: daysAgo(120 - i * 5),
    updatedAt: daysAgo(i),
    lastMessageAt: hoursAgo(i + 1),
    lastMessageDirection: "inbound" as const,
    lastMessagePreview: "Hi, I wanted to check on my next resupply shipment.",
    prescriptions: [
      {
        id: rxId,
        itemSku: "A7034",
        hcpcsCode: "A7034",
        cadenceDays: 90,
        validFrom: daysAgo(200),
        validUntil: daysFromNow(160),
        status: "active" as const,
        createdAt: daysAgo(200),
      },
    ],
    episodes: [
      {
        id: epId,
        prescriptionId: rxId,
        itemSku: "A7034",
        status: "awaiting_response" as const,
        dueAt: daysFromNow(5),
        createdAt: daysAgo(10),
      },
    ],
    conversations: [
      {
        id: `demo-conv-${n}`,
        episodeId: epId,
        channel: "sms" as const,
        status: "awaiting_admin" as const,
        lastMessageAt: hoursAgo(i + 1),
        createdAt: daysAgo(2),
      },
    ],
    fulfillments: [
      {
        id: `demo-ful-${n}`,
        episodeId: epId,
        itemSku: "A7034",
        quantity: 1,
        status: "shipped" as const,
        pacwareOrderRef: `PW-ORD-${3300 + i}`,
        shippedAt: daysAgo(40),
        deliveredAt: daysAgo(38),
        createdAt: daysAgo(42),
      },
    ],
    portalStatus: "active" as const,
    portalInvitedAt: daysAgo(60),
    linkedCustomerUserId: i % 2 === 0 ? `demo-customer-${n}` : null,
  };
}

export function demoShopCustomers(opts: {
  q?: string | null;
  page?: number;
  pageSize?: number;
  subscription?: string | null;
  awaitingReply?: boolean;
}) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = opts.pageSize ?? 25;
  const all = FIRST_NAMES.map((first, i) => {
    const last = LAST_NAMES[i % LAST_NAMES.length];
    const orders = (i * 3) % 12;
    return {
      userId: `demo-customer-${i + 1}`,
      displayName: `${first} ${last}`,
      emailRedacted: `${first.slice(0, 2).toLowerCase()}****@caremetric.example`,
      ordersCount: orders,
      lifetimeValueCents: orders * 8995,
      lastOrderAt: i % 5 === 0 ? null : daysAgo(i + 1),
      hasActiveSubscription: i % 3 === 0,
      inAppNeedsReply: i % 4 === 0,
    };
  });
  let filtered = all;
  const q = opts.q?.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.emailRedacted.toLowerCase().includes(q),
    );
  }
  if (opts.subscription === "active") {
    filtered = filtered.filter((c) => c.hasActiveSubscription);
  } else if (opts.subscription === "none") {
    filtered = filtered.filter((c) => !c.hasActiveSubscription);
  }
  if (opts.awaitingReply) {
    filtered = filtered.filter((c) => c.inAppNeedsReply);
  }
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return {
    customers: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
  };
}

export function demoCustomerDetail(userId: string) {
  const n = Number.parseInt(userId.replace(/\D/g, ""), 10) || 1;
  const first = FIRST_NAMES[(n - 1) % FIRST_NAMES.length];
  const last = LAST_NAMES[(n - 1) % LAST_NAMES.length];
  const orders = (n * 3) % 12 || 3;
  return {
    customer: {
      userId,
      displayName: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@caremetric.example`,
      stripeCustomerId: `cus_demo${n}`,
      shippingAddress: null,
      defaultPaymentMethod: {
        brand: "visa",
        last4: "4242",
        expMonth: 8,
        expYear: 2030,
      },
      clinicalInfo: {
        cpapDevice: null,
        physicianInfo: null,
        facialMeasurements: null,
      },
      createdAt: daysAgo(140),
      updatedAt: daysAgo(3),
      isGuest: false,
      // Pretend every other demo customer shares a portal login with a
      // patient, so the "View patient record" jump is exercisable.
      linkedPatientId: n % 2 === 0 ? `demo-patient-${n}` : null,
    },
    orders: [],
    subscriptions: [],
    abandonedCart: null,
    reviews: [],
    stats: {
      ordersCount: orders,
      lifetimeValueCents: orders * 8995,
      avgOrderValueCents: 8995,
      lastOrderAt: daysAgo(12),
    },
    inAppConversation: null,
  };
}

type ConvStatus = "open" | "awaiting_patient" | "awaiting_admin" | "closed";
type ConvChannel = "sms" | "voice" | "email" | "in_app";

const CONV_STATUSES: ConvStatus[] = [
  "awaiting_admin",
  "open",
  "awaiting_patient",
  "closed",
];
const CONV_CHANNELS: ConvChannel[] = ["sms", "in_app", "email", "voice"];
const DEMO_CONVERSATION_COUNT = 8;

// Single source of truth for a demo conversation header, keyed on the
// deterministic seed index `i`. The list endpoint maps over this and
// the detail endpoint reconstructs the SAME header from the row id so
// the two views never disagree (a list row that opens to a different
// patient would be a jarring demo bug).
function demoConversationHeader(i: number) {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  return {
    id: `demo-conv-${i + 1}`,
    patientId: i % 2 === 0 ? `demo-patient-${i + 1}` : null,
    patientFirstName: first,
    patientLastName: LAST_NAMES[i % LAST_NAMES.length],
    episodeId: i % 2 === 0 ? `demo-ep-${i + 1}` : null,
    customerId: i % 2 === 0 ? null : `demo-customer-${i + 1}`,
    customerDisplayName: i % 2 === 0 ? null : `${first} ${LAST_NAMES[i]}`,
    customerEmail:
      i % 2 === 0 ? null : `${first.toLowerCase()}@caremetric.example`,
    channel: CONV_CHANNELS[i % CONV_CHANNELS.length],
    status: CONV_STATUSES[i % CONV_STATUSES.length],
    lastMessageAt: hoursAgo(i + 1),
    createdAt: daysAgo(i + 2),
  };
}

export function demoConversations(limit = 25, offset = 0) {
  const all = Array.from({ length: DEMO_CONVERSATION_COUNT }, (_, i) =>
    demoConversationHeader(i),
  );
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, limit, offset };
}

// Recover the seed index from a `demo-conv-<n>` id, clamped into the
// seeded range. Any unrecognized id (a stale deep link, say) resolves
// to the first conversation so the detail page still renders a valid,
// fully-populated thread instead of a half-empty shell.
function demoConversationIndex(id: string): number {
  const m = /^demo-conv-(\d+)$/.exec(id);
  if (!m) return 0;
  const n = Number.parseInt(m[1] ?? "1", 10) - 1;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n % DEMO_CONVERSATION_COUNT;
}

type DemoMessageRole = "patient" | "customer" | "admin" | "agent" | "system";

function demoMessage(
  convId: string,
  seq: number,
  direction: "inbound" | "outbound",
  senderRole: DemoMessageRole,
  body: string,
  ageHours: number,
) {
  const at = hoursAgo(ageHours);
  return {
    id: `${convId}-msg-${seq}`,
    direction,
    senderRole,
    body,
    deliveryStatus: direction === "outbound" ? "delivered" : null,
    sentAt: at,
    deliveredAt: direction === "outbound" ? at : null,
    createdAt: at,
    attachments: [] as never[],
  };
}

// Full conversation detail (header + message timeline) for the
// /resupply-api/conversations/:id endpoint. Without this the demo
// router answers the detail GET with its empty-object fallback, and
// the detail page's `data.messages.length` deref throws into the
// patient-facing ErrorBoundary ("Something went wrong") the moment an
// explorer clicks any inbox row.
export function demoConversationDetail(id: string) {
  const i = demoConversationIndex(id);
  const header = demoConversationHeader(i);
  // Re-key the header to the requested id so an unrecognized id still
  // round-trips the value the UI navigated with.
  header.id = id;
  const inboundRole: DemoMessageRole = header.customerId
    ? "customer"
    : "patient";
  const name = header.patientFirstName;

  const messages =
    header.channel === "voice"
      ? [
          demoMessage(
            id,
            1,
            "outbound",
            "system",
            `Outbound voice call to ${name} — 2m14s. Confirmed resupply of mask cushions and headgear; verified the shipping address on file.`,
            3,
          ),
        ]
      : [
          demoMessage(
            id,
            1,
            "outbound",
            "admin",
            `Hi ${name}, it's the CareMetric Breathe team — your CPAP supplies are due for resupply. Reply YES to confirm and we'll ship today.`,
            6,
          ),
          demoMessage(
            id,
            2,
            "inbound",
            inboundRole,
            "Yes please! Could I also add replacement filters this time?",
            5,
          ),
          demoMessage(
            id,
            3,
            "outbound",
            "admin",
            "Absolutely — I've added a 6-pack of disposable filters to your order. You'll get tracking by email once it ships. Anything else I can help with?",
            4,
          ),
        ];

  return { ...header, messages };
}

type EpisodeStatus =
  | "outreach_pending"
  | "awaiting_response"
  | "confirmed"
  | "declined"
  | "expired"
  | "fulfilled"
  | "canceled";

export function demoEpisodes(limit = 25, offset = 0) {
  const statuses: EpisodeStatus[] = [
    "awaiting_response",
    "outreach_pending",
    "confirmed",
    "fulfilled",
    "expired",
  ];
  const skus = ["63550", "62932", "64162", "36850", "37296"];
  const all = FIRST_NAMES.slice(0, 9).map((first, i) => {
    const overdue = i % 4 === 0 ? i + 1 : 0;
    return {
      id: `demo-ep-${i + 1}`,
      patientId: `demo-patient-${i + 1}`,
      patientFirstName: first,
      patientLastName: LAST_NAMES[i % LAST_NAMES.length],
      prescriptionId: `demo-rx-${i + 1}`,
      itemSku: skus[i % skus.length],
      cadenceDays: 90,
      status: statuses[i % statuses.length],
      dueAt: overdue ? daysAgo(overdue) : daysFromNow(i + 3),
      daysOverdue: overdue,
      expiresAt: daysFromNow(30 - i),
      createdAt: daysAgo(20 + i),
    };
  });
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, limit, offset };
}

export function demoToday() {
  return {
    serverTime: NOW_ISO(),
    conversationsAwaitingReply: [
      {
        id: "demo-conv-1",
        channel: "sms",
        last_message_at: hoursAgo(2),
        patient_id: "demo-patient-1",
        customer_id: null,
        assigned_admin_user_id: null,
      },
      {
        id: "demo-conv-3",
        channel: "in_app",
        last_message_at: hoursAgo(5),
        patient_id: null,
        customer_id: "demo-customer-3",
        assigned_admin_user_id: "demo-admin-1",
      },
    ],
    overdueFollowups: [
      {
        id: "demo-fu-1",
        due_at: daysAgo(1),
        body: "Call to confirm new mask fit and answer sizing questions.",
        patient_id: "demo-patient-2",
        customer_id: null,
      },
    ],
    pendingReturns: [
      {
        id: "demo-ret-1",
        status: "requested",
        reason: "wrong_size",
        customer_id: "demo-customer-5",
        created_at: daysAgo(1),
      },
    ],
    complianceAlerts: [
      {
        id: "demo-ca-1",
        alert_type: "low_usage" as const,
        severity: "warning" as const,
        summary: "Usage dropped below 4 hrs/night for 5 consecutive nights.",
        patient_id: "demo-patient-4",
        status: "open" as const,
        created_at: daysAgo(1),
      },
    ],
    rxRenewalsDue: [
      {
        id: "demo-rx-1",
        patient_id: "demo-patient-6",
        item_sku: "63550",
        hcpcs_code: "A7032",
        valid_until: daysFromNow(12),
      },
    ],
    documentsToReview: [
      {
        id: "demo-doc-1",
        document_type: "prescription",
        patient_id: "demo-patient-7",
        filename: "rx-scan.pdf",
        created_at: hoursAgo(6),
      },
    ],
    inboundFaxes: [
      {
        id: "demo-fax-1",
        provider_fax_id: "FX_demo_1",
        from_e164: "+12155550173",
        num_pages: 3,
        received_at: hoursAgo(8),
      },
    ],
    // TodayResponse grew this key (today-api.ts); the dashboard derefs
    // `.length` on it unconditionally, so omitting it crashes /admin
    // (and /admin/today) into the error boundary in demo mode.
    appointmentsAssignedToMe: [
      {
        id: "demo-appt-1",
        patient_id: "demo-patient-3",
        event_type: "mask_fitting",
        starts_at: daysFromNow(1),
        ends_at: daysFromNow(1),
        location: "Main office",
      },
    ],
  };
}

export function demoWorkItems() {
  const items = [
    {
      kind: "conversation" as const,
      refId: "demo-conv-1",
      overdueHours: null,
      due: null,
      age: 2,
    },
    {
      kind: "followup" as const,
      refId: "demo-fu-1",
      overdueHours: 26,
      due: daysAgo(1),
      age: 28,
    },
    {
      kind: "return" as const,
      refId: "demo-ret-1",
      overdueHours: null,
      due: null,
      age: 24,
    },
    {
      kind: "review" as const,
      refId: "demo-rev-1",
      overdueHours: null,
      due: null,
      age: 30,
    },
    {
      kind: "patient_document" as const,
      refId: "demo-doc-1",
      overdueHours: null,
      due: null,
      age: 6,
    },
    {
      kind: "fax" as const,
      refId: "demo-fax-1",
      overdueHours: null,
      due: null,
      age: 8,
    },
  ];
  return {
    workItems: items.map((it) => ({
      kind: it.kind,
      refId: it.refId,
      createdAt: hoursAgo(it.age),
      dueAt: it.due,
      sortAt: it.due ?? hoursAgo(it.age),
      overdueHours: it.overdueHours,
    })),
    count: items.length,
    serverTime: NOW_ISO(),
  };
}

type LeadStage =
  | "consent"
  | "completed"
  | "campaign_active"
  | "reorder_active"
  | "final_call_pending"
  | "converted"
  | "unsubscribed"
  | "expired";
type LeadSource = "consent" | "sleep_apnea_quiz" | "insurance_quote";

export function demoFitterLeads() {
  const stages: LeadStage[] = [
    "consent",
    "completed",
    "campaign_active",
    "reorder_active",
    "converted",
    "final_call_pending",
  ];
  const sources: LeadSource[] = [
    "consent",
    "sleep_apnea_quiz",
    "insurance_quote",
  ];
  const rows = FIRST_NAMES.slice(0, 10).map((first, i) => ({
    id: `demo-lead-${i + 1}`,
    email: `${first.toLowerCase()}.lead@caremetric.example`,
    phoneE164: i % 2 === 0 ? `+121555501${(10 + i).toString()}` : null,
    smsOptIn: i % 2 === 0,
    marketingOptIn: i % 3 !== 0,
    source: sources[i % sources.length],
    journeyStage: stages[i % stages.length],
    recommendedMaskId: i % 2 === 0 ? "demo-mask-n20" : null,
    recommendedMaskName: i % 2 === 0 ? "ResMed AirFit N20" : null,
    recommendedMaskType: i % 2 === 0 ? "nasal" : null,
    firstName: first,
    campaignTouchCount: i % 5,
    lastCampaignTouchAt: i % 5 ? daysAgo(i) : null,
    nextCampaignTouchAt: daysFromNow(7 - (i % 7)),
    firstOrderId: i % 4 === 0 ? `demo-order-${i + 1}` : null,
    firstOrderPlacedAt: i % 4 === 0 ? daysAgo(i + 1) : null,
    unsubscribedAt: null,
    completedAt: i % 2 === 0 ? daysAgo(i + 2) : null,
    createdAt: daysAgo(i + 3),
    engagementScore: (i * 13) % 100,
    hotLeadAt: i % 6 === 0 ? daysAgo(1) : null,
    clickCount: i % 4,
    csrContactedAt: null,
    csrContactedBy: null,
    lastOpenAt: i % 2 === 0 ? daysAgo(i) : null,
    lastClickAt: i % 3 === 0 ? daysAgo(i) : null,
    csrNotes: null,
    coldSkippedAt: null,
  }));
  const counts = {
    consent: 0,
    completed: 0,
    campaign_active: 0,
    reorder_active: 0,
    final_call_pending: 0,
    converted: 0,
    unsubscribed: 0,
    expired: 0,
  } as Record<LeadStage, number>;
  for (const r of rows) counts[r.journeyStage] += 1;
  return {
    rows,
    counts,
    conversionRate: 0.18,
    hotLeadsActive: 2,
    hotLeadsNeedingContact: 1,
  };
}

export function demoBillingDirectorSummary() {
  return {
    counts: {
      staleDrafts: 3,
      freshDenials: 2,
      stuckSubmittedNoAck: 1,
      partialEras: 0,
      scrubBlocking: 2,
      scrubFixable: 4,
      deniedNeedsAnalysis: 2,
      autoResubmitReady: 3,
      webhooksQueued: 0,
      webhooksExhausted24h: 0,
    },
    dollars: {
      stuckSubmittedCents: 184500,
      deniedFreshCents: 96200,
      patientResponsibilityCents: 423800,
    },
    denialRateTrend: [
      {
        window: "d0_30" as const,
        decisions: 120,
        denials: 14,
        denialRate: 0.117,
      },
      {
        window: "d30_60" as const,
        decisions: 138,
        denials: 12,
        denialRate: 0.087,
      },
      {
        window: "d60_90" as const,
        decisions: 110,
        denials: 9,
        denialRate: 0.082,
      },
    ],
    topPayersByOpenDollars: [
      { payerName: "Independence Blue Cross", openCents: 184500 },
      { payerName: "Aetna", openCents: 96200 },
      { payerName: "Medicare PA", openCents: 73100 },
    ],
    generatedAt: NOW_ISO(),
  };
}

// Mirrors the /admin/system-info response shape consumed by
// admin-settings.tsx (server / database / publicUrls / auth / vendors /
// secrets). The settings page derefs these nested objects directly, so the
// demo sandbox MUST answer this endpoint with a full shape — the router's
// empty-object fallback (`{}`) would make the page crash on
// `data.server.uptimeSeconds`. All values are fictional and benign
// (presence booleans + non-secret metadata), matching the real route's
// privacy posture.
export function demoSystemInfo() {
  return {
    server: {
      now: NOW_ISO(),
      nodeVersion: "v24.0.0",
      pgVersion: "PostgreSQL 15.6 (demo)",
      uptimeSeconds: 192_540, // ~2d 5h
      gitSha: "demo1234",
      nodeEnv: "production",
    },
    database: {
      migrationCount: 180,
      lastMigrationAt: daysAgo(3),
    },
    publicUrls: {
      shop: "https://caremetric.example",
      voice: "https://caremetric.example",
      dashboard: "https://caremetric.example/admin",
    },
    auth: {
      adminAllowlistCount: 2,
      agentAllowlistCount: 4,
      legacyAdminAllowlistCount: 0,
    },
    vendors: {
      sendgrid: { configured: true, fromEmailConfigured: true },
      twilio: {
        accountSidConfigured: true,
        authTokenConfigured: true,
        messagingServiceConfigured: true,
        voicePhoneConfigured: true,
      },
      telnyx: {
        apiKeyConfigured: true,
        faxConnectionConfigured: true,
        faxFromConfigured: false,
        webhookPublicKeyConfigured: true,
      },
      stripe: { secretKeyConfigured: true, webhookSecretConfigured: true },
      objectStorage: { privateBucketConfigured: true },
      openai: { apiKeyConfigured: true },
    },
    secrets: { linkHmacKeyConfigured: true },
  };
}

const DEMO_ADMIN_ORDER_COUNT = 10;

function demoAdminOrderRow(i: number) {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  return {
    id: `demo-aorder-${i + 1}`,
    orderReference: `CMB-DEMO-${2000 + i}`,
    patientFirstName: first,
    patientLastName: LAST_NAMES[i % LAST_NAMES.length],
    patientEmail: `${first.toLowerCase()}@caremetric.example`,
    patientPhone: `+121555502${(10 + i).toString()}`,
    patientDateOfBirth: "1972-03-14",
    maskId: "demo-mask-n20",
    maskName: "ResMed AirFit N20",
    maskManufacturer: "ResMed",
    maskModelNumber: "63500",
    shippingCity: "Philadelphia",
    shippingState: "PA",
    shippingZip: "19107",
    emailStatus: (i % 5 === 0 ? "failed" : "sent") as
      | "pending"
      | "sent"
      | "failed"
      | "skipped",
    emailDeliveredAt: i % 5 === 0 ? null : daysAgo(i),
    emailError: i % 5 === 0 ? "550 mailbox unavailable" : null,
    createdAt: daysAgo(i),
  };
}

export function demoAdminOrders(page = 1, pageSize = 25) {
  const all = Array.from({ length: DEMO_ADMIN_ORDER_COUNT }, (_, i) =>
    demoAdminOrderRow(i),
  );
  const start = (page - 1) * pageSize;
  return {
    orders: all.slice(start, start + pageSize),
    page,
    pageSize,
    total: all.length,
  };
}

// Full order detail (the list row + the `payload` blob the detail page
// derefs as `data.order.payload.{insurance,prescription,…}`) for
// /api/admin/orders/:id. Without it the detail GET hits the empty-object
// fallback and `data.order` is undefined → crash into the ErrorBoundary
// on the click the seeded orders list invites.
export function demoAdminOrderDetail(id: string) {
  const n = Number.parseInt(id.replace(/\D/g, ""), 10) || 1;
  const i = (n - 1 + DEMO_ADMIN_ORDER_COUNT) % DEMO_ADMIN_ORDER_COUNT;
  const row = demoAdminOrderRow(i);
  row.id = id;
  return {
    order: {
      ...row,
      payload: {
        insurance: {
          provider: "Aetna",
          memberId: "W2840173355",
          groupNumber: "PA-00271",
          planName: "Aetna Choice PPO",
          policyholderName: `${row.patientFirstName} ${row.patientLastName}`,
          policyholderRelationship: "self",
        },
        prescription: {
          hasExistingPrescription: true,
          physicianName: "Dr. Alex Rivera",
          physicianPhone: "+1 814 555 0142",
        },
        measurements: {
          noseWidth: 34.2,
          noseHeight: 48.6,
          noseToChin: 61.0,
          mouthWidth: 51.4,
          faceWidthAtCheekbones: 132.5,
          calibrationMethod: "iris",
        },
        shippingAddress: {
          street1: "415 Maple Avenue",
          street2: "Apt 6",
          city: row.shippingCity,
          state: row.shippingState,
          zip: row.shippingZip,
        },
        notes: "Patient prefers afternoon delivery windows.",
      },
    },
  };
}
