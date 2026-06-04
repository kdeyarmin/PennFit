// Seed data for the admin console. All names/records are obviously
// fictional — this is a demonstration sandbox, never real PHI.

import type { AdminIdentity } from "@workspace/api-client-react/admin";
import { daysAgo, hoursAgo, daysFromNow, NOW_ISO } from "./dates";

export const DEMO_ADMIN_AUTH = {
  id: "demo-admin-1",
  email: "demo.admin@pennfit.example",
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
    // Grant a broad permission set so every nav entry is explorable.
    permissions: [
      "admin.tools.manage",
      "admin.patients.read",
      "admin.patients.write",
      "admin.billing.read",
      "admin.billing.write",
      "admin.shop.read",
      "admin.shop.write",
      "admin.reports.read",
      "admin.team.manage",
      "admin.settings.manage",
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

export function demoPatients(limit = 25, offset = 0) {
  const all = FIRST_NAMES.map((first, i) => {
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
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, limit, offset };
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
      emailRedacted: `${first.slice(0, 2).toLowerCase()}****@pennfit.example`,
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
      email: `${first.toLowerCase()}.${last.toLowerCase()}@pennfit.example`,
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

export function demoConversations(limit = 25, offset = 0) {
  const statuses: ConvStatus[] = [
    "awaiting_admin",
    "open",
    "awaiting_patient",
    "closed",
  ];
  const channels: ConvChannel[] = ["sms", "in_app", "email", "voice"];
  const all = FIRST_NAMES.slice(0, 8).map((first, i) => ({
    id: `demo-conv-${i + 1}`,
    patientId: i % 2 === 0 ? `demo-patient-${i + 1}` : null,
    patientFirstName: first,
    patientLastName: LAST_NAMES[i % LAST_NAMES.length],
    episodeId: i % 2 === 0 ? `demo-ep-${i + 1}` : null,
    customerId: i % 2 === 0 ? null : `demo-customer-${i + 1}`,
    customerDisplayName: i % 2 === 0 ? null : `${first} ${LAST_NAMES[i]}`,
    customerEmail:
      i % 2 === 0 ? null : `${first.toLowerCase()}@pennfit.example`,
    channel: channels[i % channels.length],
    status: statuses[i % statuses.length],
    lastMessageAt: hoursAgo(i + 1),
    createdAt: daysAgo(i + 2),
  }));
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, limit, offset };
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
        summary: "Usage dropped below 4 hrs/night for 5 consecutive nights.",
        patient_id: "demo-patient-4",
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
        twilio_fax_sid: "FX_demo_1",
        from_e164: "+12155550173",
        num_pages: 3,
        received_at: hoursAgo(8),
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
    email: `${first.toLowerCase()}.lead@pennfit.example`,
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

export function demoAdminOrders(page = 1, pageSize = 25) {
  const all = FIRST_NAMES.slice(0, 10).map((first, i) => ({
    id: `demo-aorder-${i + 1}`,
    orderReference: `PENN-DEMO-${2000 + i}`,
    patientFirstName: first,
    patientLastName: LAST_NAMES[i % LAST_NAMES.length],
    patientEmail: `${first.toLowerCase()}@pennfit.example`,
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
  }));
  const start = (page - 1) * pageSize;
  return {
    orders: all.slice(start, start + pageSize),
    page,
    pageSize,
    total: all.length,
  };
}
