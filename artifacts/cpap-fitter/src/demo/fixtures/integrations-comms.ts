// Seed data for the INTEGRATIONS, FHIR, and MULTI-CHANNEL COMMS admin
// surfaces. All names / numbers / ids are obviously fictional — this is a
// demonstration sandbox, never real PHI. Phone + fax numbers are in the
// reserved 555 range. Therapy-cloud vendors are the real product names
// (ResMed AirView, Philips Care Orchestrator, 3B / React Health); the
// platform brand is CareMetric Breathe and the sandbox tenant is
// CareMetric Demo DME.

import { daysAgo, hoursAgo, daysFromNow, dateOnly, NOW_ISO } from "./dates";

// ── shared demo people ──────────────────────────────────────────────────
// Deterministic fictional roster reused across these surfaces so a fax that
// references "Jordan Sample" lines up with the same name elsewhere.
const PEOPLE = [
  { first: "Jordan", last: "Sample" },
  { first: "Casey", last: "Demo" },
  { first: "Morgan", last: "Example" },
  { first: "Riley", last: "Tester" },
  { first: "Avery", last: "Placeholder" },
  { first: "Quinn", last: "Mockford" },
  { first: "Harper", last: "Sandbox" },
  { first: "Rowan", last: "Preview" },
] as const;

// ════════════════════════════════════════════════════════════════════════
// INTEGRATIONS
// ════════════════════════════════════════════════════════════════════════

type IntegrationSource = "resmed_airview" | "philips_care" | "react_health";

// GET /admin/integrations/status
export function demoIntegrationsStatus() {
  return {
    lookbackDays: 7,
    adapters: [
      {
        source: "resmed_airview" as IntegrationSource,
        availability: { status: "configured" as const },
        recentSnapshots: { ok: 142, error: 3 },
        errorSamples: [
          { error: "rate_limited", count: 2 },
          { error: "partner_timeout", count: 1 },
        ],
        lastFetchedAt: hoursAgo(2),
      },
      {
        source: "philips_care" as IntegrationSource,
        availability: { status: "configured" as const },
        recentSnapshots: { ok: 88, error: 1 },
        errorSamples: [{ error: "partner_timeout", count: 1 }],
        lastFetchedAt: hoursAgo(6),
      },
      {
        source: "react_health" as IntegrationSource,
        availability: {
          status: "stub" as const,
          reason: "no_credentials" as const,
        },
        recentSnapshots: { ok: 0, error: 0 },
        errorSamples: [],
        lastFetchedAt: null,
      },
    ],
  };
}

// GET /admin/integrations/errors
export function demoIntegrationsErrors() {
  return {
    errors: [
      {
        id: "demo-snap-err-1",
        patientId: "demo-patient-4",
        source: "resmed_airview",
        partnerPatientId: "AV-DEMO-88421",
        fetchError: "rate_limited",
        fetchedAt: hoursAgo(3),
      },
      {
        id: "demo-snap-err-2",
        patientId: "demo-patient-7",
        source: "resmed_airview",
        partnerPatientId: "AV-DEMO-88512",
        fetchError: "partner_timeout",
        fetchedAt: hoursAgo(9),
      },
      {
        id: "demo-snap-err-3",
        patientId: "demo-patient-2",
        source: "philips_care",
        partnerPatientId: "CO-DEMO-30199",
        fetchError: "partner_timeout",
        fetchedAt: daysAgo(1),
      },
    ],
  };
}

// POST /admin/integrations/errors/retry
export function demoIntegrationsRetry(snapshotIds: string[]) {
  const retried = snapshotIds.length;
  return {
    retried,
    succeeded: Math.max(0, retried - 1),
    failed: retried > 0 ? 1 : 0,
  };
}

// POST /admin/integrations/nightly-sync
export function demoNightlySyncResult() {
  return {
    scanned: 36,
    refreshed: 33,
    failed: 3,
    nightsPersisted: 412,
  };
}

// GET /admin/patients/:id/integrations  (unified Device data view)
export function demoPatientIntegrations(patientId: string) {
  const recentNights = Array.from({ length: 14 }, (_, i) => ({
    nightDate: dateOnly(-(i + 1)),
    usageMinutes: 360 + ((i * 17) % 120),
    ahi: Math.round((2 + (i % 5) * 0.4) * 10) / 10,
    leakRateLMin: 8 + (i % 6),
    pressureP95Cmh2o: Math.round((9 + (i % 3) * 0.5) * 10) / 10,
  }));
  return {
    patientId,
    sources: [
      {
        source: "resmed_airview" as IntegrationSource,
        availability: { status: "configured" as const },
        link: {
          id: "demo-link-1",
          partnerPatientId: "AV-DEMO-88421",
          deviceSerial: "23191234567",
          status: "active",
          lastSyncedAt: hoursAgo(8),
          lastSyncStatus: "ok",
          lastSyncError: null,
        },
        snapshot: {
          id: "demo-snap-1",
          fetchStatus: "ok",
          fetchError: null,
          fetchedAt: hoursAgo(8),
          payload: {
            source: "resmed_airview" as IntegrationSource,
            partnerPatientId: "AV-DEMO-88421",
            settings: {
              deviceModel: "AirSense 11 AutoSet",
              deviceSerial: "23191234567",
              therapyMode: "AutoSet",
              pressureMinCmh2o: 6,
              pressureMaxCmh2o: 14,
              rampMinutes: 20,
              humidifierLevel: 4,
              maskType: "nasal",
            },
            compliance: {
              windowDays: 30,
              daysWithData: 28,
              daysOver4Hours: 24,
              averageUsageMinutes: 392,
              averageAhi: 3.1,
              meetsCmsCompliance: true,
            },
            recentNights,
            supplies: [
              {
                category: "mask" as const,
                description: "AirFit N20 nasal mask",
                lastReplacedDate: dateOnly(-150),
                nextEligibleDate: dateOnly(30),
              },
              {
                category: "cushion" as const,
                description: "N20 cushion (medium)",
                lastReplacedDate: dateOnly(-35),
                nextEligibleDate: dateOnly(-5),
              },
              {
                category: "filter" as const,
                description: "Disposable filter",
                lastReplacedDate: dateOnly(-40),
                nextEligibleDate: dateOnly(-10),
              },
            ],
          },
        },
      },
      {
        source: "philips_care" as IntegrationSource,
        availability: { status: "configured" as const },
        link: null,
        snapshot: null,
      },
      {
        source: "react_health" as IntegrationSource,
        availability: {
          status: "stub" as const,
          reason: "no_credentials" as const,
        },
        link: null,
        snapshot: null,
      },
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════
// WEBHOOKS
// ════════════════════════════════════════════════════════════════════════

// GET /admin/webhook-subscriptions
export function demoWebhookSubscriptions() {
  return {
    subscriptions: [
      {
        id: "demo-wh-sub-1",
        name: "Billing data warehouse",
        target_url: "https://hooks.example.com/caremetric/billing",
        event_types: ["claim.paid", "claim.denied", "era.ingested"],
        is_active: true,
        max_retries: 5,
        last_delivery_at: hoursAgo(1),
        last_delivery_status: "delivered",
        notes: "Nightly ETL into the analytics warehouse.",
        created_at: daysAgo(60),
        updated_at: daysAgo(2),
      },
      {
        id: "demo-wh-sub-2",
        name: "Ops Slack relay",
        target_url: "https://hooks.example.com/caremetric/slack",
        event_types: ["dispense_readiness.reviewed", "claim.submitted"],
        is_active: true,
        max_retries: 3,
        last_delivery_at: daysAgo(1),
        last_delivery_status: "delivered",
        notes: null,
        created_at: daysAgo(30),
        updated_at: daysAgo(1),
      },
      {
        id: "demo-wh-sub-3",
        name: "Legacy partner (paused)",
        target_url: "https://hooks.example.com/partner/legacy",
        event_types: ["*"],
        is_active: false,
        max_retries: 5,
        last_delivery_at: daysAgo(20),
        last_delivery_status: "exhausted",
        notes: "Disabled while partner migrates endpoints.",
        created_at: daysAgo(120),
        updated_at: daysAgo(20),
      },
    ],
  };
}

// GET /admin/webhook-deliveries
export function demoWebhookDeliveries(subscriptionId?: string | null) {
  const all = [
    {
      id: "demo-wh-del-1",
      subscription_id: "demo-wh-sub-1",
      event_type: "claim.paid",
      status: "delivered",
      attempt_count: 1,
      last_http_status: 200,
      last_error: null,
      next_attempt_at: null,
      delivered_at: hoursAgo(1),
      created_at: hoursAgo(1),
    },
    {
      id: "demo-wh-del-2",
      subscription_id: "demo-wh-sub-1",
      event_type: "era.ingested",
      status: "delivered",
      attempt_count: 2,
      last_http_status: 200,
      last_error: null,
      next_attempt_at: null,
      delivered_at: hoursAgo(5),
      created_at: hoursAgo(5),
    },
    {
      id: "demo-wh-del-3",
      subscription_id: "demo-wh-sub-2",
      event_type: "dispense_readiness.reviewed",
      status: "failed",
      attempt_count: 3,
      last_http_status: 503,
      last_error: "subscriber returned 503",
      next_attempt_at: hoursAgo(-1),
      delivered_at: null,
      created_at: daysAgo(1),
    },
    {
      id: "demo-wh-del-4",
      subscription_id: "demo-wh-sub-3",
      event_type: "claim.submitted",
      status: "exhausted",
      attempt_count: 5,
      last_http_status: 0,
      last_error: "connection refused",
      next_attempt_at: null,
      delivered_at: null,
      created_at: daysAgo(20),
    },
  ];
  const deliveries = subscriptionId
    ? all.filter((d) => d.subscription_id === subscriptionId)
    : all;
  return { deliveries };
}

// GET /admin/webhook-event-catalog
// Mirror of lib/webhooks/event-catalog.ts (a stable subset is plenty for the
// demo picker / docs page to render).
export function demoWebhookEventCatalog() {
  return {
    events: [
      {
        type: "claim.submitted",
        description:
          "Insurance claim transitioned to submitted (sent to clearinghouse).",
        publisher: "routes/patients/insurance-claims.ts PATCH",
        payloadFields: {
          claim_id: "uuid",
          patient_id: "uuid",
          from_status: "string",
          to_status: "string",
        },
        carriesPatientId: true,
      },
      {
        type: "claim.paid",
        description: "Claim moved to paid status (full or partial pay).",
        publisher: "routes/patients/insurance-claims.ts PATCH",
        payloadFields: { claim_id: "uuid", patient_id: "uuid" },
        carriesPatientId: true,
      },
      {
        type: "claim.denied",
        description: "Claim denied by payer (line-level or claim-level).",
        publisher: "routes/patients/insurance-claims.ts PATCH",
        payloadFields: { claim_id: "uuid", patient_id: "uuid" },
        carriesPatientId: true,
      },
      {
        type: "era.ingested",
        description:
          "An 835 ERA was ingested + reconciled. Carries total paid + per-disposition counts.",
        publisher: "routes/admin/era-ingest.ts",
        payloadFields: {
          era_file_id: "uuid",
          file_name: "string",
          total_paid_cents: "number",
          claims_paid: "number",
          claims_denied: "number",
          lines_updated: "number",
        },
        carriesPatientId: false,
      },
      {
        type: "billing_statement.generated",
        description: "A patient billing statement PDF was generated.",
        publisher: "routes/admin/billing-statements.ts",
        payloadFields: {
          statement_id: "uuid",
          patient_id: "uuid",
          total_cents: "number",
          claim_count: "number",
        },
        carriesPatientId: true,
      },
      {
        type: "dispense_readiness.reviewed",
        description: "AI-augmented dispense-readiness review completed.",
        publisher: "routes/admin/dispense-readiness.ts",
        payloadFields: {
          review_id: "uuid",
          patient_id: "uuid",
          verdict: "string",
          checks_failed: "number",
        },
        carriesPatientId: true,
      },
      {
        type: "eligibility.completed",
        description:
          "A 270/271 eligibility round-trip resolved — the parsed 271 landed on the eligibility_checks row.",
        publisher: "worker/jobs/office-ally-inbound-poll.ts dispatch271",
        payloadFields: {
          eligibility_check_id: "uuid",
          patient_id: "uuid",
          insurance_coverage_id: "uuid",
          is_active: "boolean",
          requires_prior_auth: "boolean",
        },
        carriesPatientId: true,
      },
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════
// VOICE
// ════════════════════════════════════════════════════════════════════════

// GET /admin/voice/metrics
export function demoVoiceMetrics(days: number) {
  return {
    windowDays: days,
    totalCalls: 248,
    answeredCalls: 213,
    answerRate: 0.8589,
    byStatus: {
      completed: 201,
      "no-answer": 22,
      busy: 9,
      failed: 4,
      "in-progress": 2,
      queued: 10,
    },
    byDirection: { inbound: 144, outbound: 104, other: 0 },
    avgHandleSeconds: 167,
    medianHandleSeconds: 142,
    avgRingSeconds: 9,
    medianRingSeconds: 7,
  };
}

// ════════════════════════════════════════════════════════════════════════
// VIDEO VISITS
// ════════════════════════════════════════════════════════════════════════

// GET /admin/video-visits
export function demoVideoVisits() {
  return {
    visits: [
      {
        id: "demo-vv-1",
        patientId: "demo-patient-1",
        patientName: "Jordan Sample",
        isGuest: false,
        purpose: "setup",
        notes: "Walk through humidifier + mask fit on the AirSense 11.",
        status: "scheduled",
        scheduledAt: daysFromNow(1),
        createdByEmail: "demo.admin@caremetric.example",
        inviteChannel: "sms",
        inviteDelivered: true,
        inviteDeliveryStatus: "delivered",
        inviteDeliveryErrorCode: null,
        staffJoinedAt: null,
        patientJoinedAt: null,
        startedAt: null,
        endedAt: null,
        createdAt: hoursAgo(4),
      },
      {
        id: "demo-vv-2",
        patientId: "demo-patient-3",
        patientName: "Morgan Example",
        isGuest: false,
        purpose: "troubleshooting",
        notes: "Mask leak follow-up.",
        status: "in_progress",
        scheduledAt: hoursAgo(1),
        createdByEmail: "demo.admin@caremetric.example",
        inviteChannel: "email",
        inviteDelivered: true,
        inviteDeliveryStatus: null,
        inviteDeliveryErrorCode: null,
        staffJoinedAt: minutesIso(20),
        patientJoinedAt: minutesIso(18),
        startedAt: minutesIso(18),
        endedAt: null,
        createdAt: daysAgo(1),
      },
      {
        id: "demo-vv-3",
        patientId: null,
        patientName: "Casey Demo (guest)",
        isGuest: true,
        purpose: "follow_up",
        notes: "Prospect — pre-purchase fitting questions.",
        status: "scheduled",
        scheduledAt: daysFromNow(3),
        createdByEmail: "demo.admin@caremetric.example",
        inviteChannel: "sms",
        inviteDelivered: false,
        inviteDeliveryStatus: "queued",
        inviteDeliveryErrorCode: null,
        staffJoinedAt: null,
        patientJoinedAt: null,
        startedAt: null,
        endedAt: null,
        createdAt: hoursAgo(2),
      },
    ],
  };
}

function minutesIso(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

// POST /admin/patients/:id/video-visits  and POST /admin/video-visits
export function demoCreateVideoVisit(id: string) {
  const joinUrl =
    "https://cmbreathe.com/video-visit?token=demo-video-token-" + id;
  return {
    visit: {
      id,
      patientId: "demo-patient-1",
      patientName: "Jordan Sample",
      isGuest: false,
      purpose: "setup",
      notes: null,
      status: "scheduled",
      scheduledAt: null,
      createdByEmail: "demo.admin@caremetric.example",
      inviteChannel: "sms",
      inviteDelivered: true,
      inviteDeliveryStatus: null,
      inviteDeliveryErrorCode: null,
      staffJoinedAt: null,
      patientJoinedAt: null,
      startedAt: null,
      endedAt: null,
      createdAt: NOW_ISO(),
    },
    joinUrl,
    delivered: true,
    deliveryError: null,
  };
}

// ════════════════════════════════════════════════════════════════════════
// INBOUND FAXES
// ════════════════════════════════════════════════════════════════════════

// GET /admin/inbound-faxes
export function demoInboundFaxes() {
  return {
    faxes: [
      {
        id: "demo-ifax-1",
        providerFaxId: "FX_demo_aaa111",
        fromE164: "+12155550173",
        toE164: "+12155550100",
        receivedAt: hoursAgo(3),
        numPages: 3,
        hasMedia: true,
        mediaContentType: "application/pdf",
        mediaSizeBytes: 184_320,
        status: "new",
        attachedPatientId: null,
        attachedProviderId: null,
        attachedPrescriptionId: null,
        attachedDocumentType: null,
        notes: null,
        createdAt: hoursAgo(3),
        triagedAt: null,
        trackingCodeDetected: null,
        autoFileStatus: null,
        autoFiledAt: null,
        signatureTrackingId: null,
        chartDocumentId: null,
        referralReviewId: null,
        referralReviewStatus: null,
      },
      {
        id: "demo-ifax-2",
        providerFaxId: "FX_demo_bbb222",
        fromE164: "+12155550148",
        toE164: "+12155550100",
        receivedAt: hoursAgo(20),
        numPages: 2,
        hasMedia: true,
        mediaContentType: "application/pdf",
        mediaSizeBytes: 96_000,
        status: "triaged",
        attachedPatientId: null,
        attachedProviderId: null,
        attachedPrescriptionId: null,
        attachedDocumentType: "prescription",
        notes: "Looks like a renewal Rx from Dr. Rivera's office.",
        createdAt: hoursAgo(20),
        triagedAt: hoursAgo(18),
        trackingCodeDetected: null,
        autoFileStatus: null,
        autoFiledAt: null,
        signatureTrackingId: null,
        chartDocumentId: null,
        referralReviewId: null,
        referralReviewStatus: null,
      },
      {
        id: "demo-ifax-3",
        providerFaxId: "FX_demo_ccc333",
        fromE164: "+18145550142",
        toE164: "+12155550100",
        receivedAt: daysAgo(2),
        numPages: 1,
        hasMedia: true,
        mediaContentType: "application/pdf",
        mediaSizeBytes: 51_200,
        status: "attached",
        attachedPatientId: "demo-patient-2",
        attachedProviderId: "demo-provider-1",
        attachedPrescriptionId: null,
        attachedDocumentType: "sleep_study",
        notes: null,
        createdAt: daysAgo(2),
        triagedAt: daysAgo(2),
        trackingCodeDetected: "PF-SIG-00417",
        autoFileStatus: "filed",
        autoFiledAt: daysAgo(2),
        signatureTrackingId: "demo-sig-1",
        chartDocumentId: "demo-chartdoc-1",
        referralReviewId: "demo-refrev-1",
        referralReviewStatus: "accepted",
      },
    ],
  };
}

// GET /admin/inbound-faxes/:id
export function demoInboundFaxDetail(id: string) {
  return {
    id,
    providerFaxId: "FX_demo_aaa111",
    fromE164: "+12155550173",
    toE164: "+12155550100",
    receivedAt: hoursAgo(3),
    numPages: 3,
    hasMedia: true,
    mediaContentType: "application/pdf",
    mediaSizeBytes: 184_320,
    status: "new",
    attachedPatientId: null,
    attachedProviderId: null,
    attachedPrescriptionId: null,
    attachedDocumentType: null,
    notes: null,
    createdAt: hoursAgo(3),
    triagedAt: null,
    triagedByUserId: null,
    assignedAdminUserId: null,
    ocrStatus: "extracted",
    ocrExtraction: {
      patientName: "Jordan Sample",
      dateOfBirth: "1972-03-14",
      physicianName: "Dr. Alex Rivera",
      documentType: "prescription",
    },
    ocrExtractedAt: hoursAgo(2),
    trackingCodeDetected: null,
    autoFileStatus: null,
    autoFiledAt: null,
    signatureTrackingId: null,
    chartDocumentId: null,
    referralReviewId: null,
    referralReviewStatus: null,
  };
}

// ════════════════════════════════════════════════════════════════════════
// FAX SETTINGS (tenant's own fax number)
// ════════════════════════════════════════════════════════════════════════

// GET /admin/organization/fax-settings
export function demoFaxSettings() {
  return {
    faxNumber: "+12155550199",
    telnyxOrderId: "demo-telnyx-order-1",
    provisionedAt: daysAgo(45),
    canProvision: true,
  };
}

// ════════════════════════════════════════════════════════════════════════
// OUTBOUND MESSAGES (SMS / email send log)
// ════════════════════════════════════════════════════════════════════════

type ResultBucket = "delivered" | "sent" | "failed" | "pending";

// GET /admin/outbound-messages
export function demoOutboundMessages(opts: {
  channel?: string | null;
  result?: string | null;
  sinceDays: number;
  limit: number;
  offset: number;
}) {
  const buckets: ResultBucket[] = [
    "delivered",
    "delivered",
    "sent",
    "failed",
    "pending",
    "delivered",
    "sent",
    "delivered",
  ];
  const all = PEOPLE.map((p, i) => {
    const channel = i % 2 === 0 ? "sms" : "email";
    const result = buckets[i % buckets.length]!;
    const status =
      result === "failed"
        ? channel === "sms"
          ? "undelivered"
          : "bounced"
        : result === "pending"
          ? null
          : result;
    return {
      id: `demo-outmsg-${i + 1}`,
      occurredAt: hoursAgo(i + 1),
      channel,
      senderRole: "admin",
      deliveryStatus: status,
      deliveryError:
        result === "failed"
          ? channel === "sms"
            ? "Carrier marked the number undeliverable"
            : "550 mailbox unavailable"
          : null,
      deliveredAt: result === "delivered" ? hoursAgo(i + 1) : null,
      result,
      conversationId: `demo-conv-${i + 1}`,
      patientId: `demo-patient-${i + 1}`,
      patientName: `${p.first} ${p.last}`,
    };
  });

  let items = all;
  if (opts.channel) items = items.filter((m) => m.channel === opts.channel);
  if (opts.result) items = items.filter((m) => m.result === opts.result);

  const counts = {
    delivered: all.filter((m) => m.result === "delivered").length,
    sent: all.filter((m) => m.result === "sent").length,
    failed: all.filter((m) => m.result === "failed").length,
    pending: all.filter((m) => m.result === "pending").length,
  };

  const total = items.length;
  const page = items.slice(opts.offset, opts.offset + opts.limit);
  return {
    sinceDays: opts.sinceDays,
    channel: opts.channel ?? "all",
    result: opts.result ?? "all",
    limit: opts.limit,
    offset: opts.offset,
    total,
    counts,
    items: page,
  };
}

// ════════════════════════════════════════════════════════════════════════
// EMAIL INBOX
// ════════════════════════════════════════════════════════════════════════

// GET /admin/email-inbox
export function demoEmailInbox(opts: {
  mailbox: "needs_response" | "responded";
  limit: number;
  offset: number;
}) {
  const needs = [
    {
      id: "demo-email-conv-1",
      patientId: "demo-patient-1",
      patientFirstName: "Jordan",
      patientLastName: "Sample",
      patientEmail: "jordan@caremetric.example",
      episodeId: "demo-ep-1",
      status: "awaiting_admin",
      subject: "Question about my next resupply shipment",
      lastMessageAt: hoursAgo(2),
      createdAt: daysAgo(1),
      lastMessagePreview:
        "Hi — I wanted to check whether my mask cushions shipped yet?",
      lastMessageDirection: "inbound",
      lastMessageSenderRole: "patient",
      lastMessageAutoReply: false,
    },
    {
      id: "demo-email-conv-2",
      patientId: "demo-patient-4",
      patientFirstName: "Riley",
      patientLastName: "Tester",
      patientEmail: "riley@caremetric.example",
      episodeId: null,
      status: "awaiting_admin",
      subject: "Insurance coverage for replacement headgear",
      lastMessageAt: hoursAgo(6),
      createdAt: daysAgo(2),
      lastMessagePreview:
        "Does my plan cover new headgear, and how often can I reorder?",
      lastMessageDirection: "inbound",
      lastMessageSenderRole: "patient",
      lastMessageAutoReply: false,
    },
  ];
  const responded = [
    {
      id: "demo-email-conv-3",
      patientId: "demo-patient-2",
      patientFirstName: "Casey",
      patientLastName: "Demo",
      patientEmail: "casey@caremetric.example",
      episodeId: "demo-ep-2",
      status: "awaiting_patient",
      subject: "Re: When is my filter due?",
      lastMessageAt: hoursAgo(10),
      createdAt: daysAgo(3),
      lastMessagePreview:
        "Your disposable filters are due now — I've queued a resupply order for you.",
      lastMessageDirection: "outbound",
      lastMessageSenderRole: "agent",
      lastMessageAutoReply: true,
    },
    {
      id: "demo-email-conv-4",
      patientId: "demo-patient-5",
      patientFirstName: "Avery",
      patientLastName: "Placeholder",
      patientEmail: "avery@caremetric.example",
      episodeId: null,
      status: "closed",
      subject: "Re: Thank you!",
      lastMessageAt: daysAgo(2),
      createdAt: daysAgo(4),
      lastMessagePreview:
        "Glad we could help — reach out any time you need supplies.",
      lastMessageDirection: "outbound",
      lastMessageSenderRole: "admin",
      lastMessageAutoReply: false,
    },
  ];
  const items = opts.mailbox === "needs_response" ? needs : responded;
  return {
    mailbox: opts.mailbox,
    items: items.slice(opts.offset, opts.offset + opts.limit),
    total: items.length,
    limit: opts.limit,
    offset: opts.offset,
    counts: {
      needsResponse: needs.length,
      responded: responded.length,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// STAFFING (live CSR workload)
// ════════════════════════════════════════════════════════════════════════

// GET /admin/staffing/live
export function demoStaffingLive() {
  const agents = [
    {
      adminUserId: "demo-admin-1",
      email: "demo.admin@caremetric.example",
      displayName: "Demo Admin",
      role: "admin",
      availability: "available",
      onShift: true,
      openConversations: 7,
    },
    {
      adminUserId: "demo-agent-1",
      email: "casey.csr@caremetric.example",
      displayName: "Casey (CSR)",
      role: "agent",
      availability: "available",
      onShift: true,
      openConversations: 5,
    },
    {
      adminUserId: "demo-agent-2",
      email: "morgan.csr@caremetric.example",
      displayName: "Morgan (CSR)",
      role: "agent",
      availability: "away",
      onShift: true,
      openConversations: 2,
    },
    {
      adminUserId: "demo-agent-3",
      email: "riley.csr@caremetric.example",
      displayName: "Riley (CSR)",
      role: "agent",
      availability: "do_not_assign",
      onShift: false,
      openConversations: 0,
    },
  ];
  const assignedToKnown = agents.reduce((s, a) => s + a.openConversations, 0);
  const unassigned = 6;
  return {
    agents,
    unassignedOpenConversations: unassigned,
    totalOpenConversations: assignedToKnown + unassigned,
    activeAgents: agents.length,
    onShiftAgents: agents.filter((a) => a.onShift).length,
  };
}

// ════════════════════════════════════════════════════════════════════════
// OFFICE HOURS
// ════════════════════════════════════════════════════════════════════════

// GET /admin/office-hours
export function demoOfficeHours() {
  // Mon–Fri 13:00–22:00 UTC (≈ 9a–6p ET); Sat half day.
  const weekday = (dayOfWeek: number, idx: number) => ({
    id: `demo-oh-${idx}`,
    dayOfWeek,
    openTimeUtc: "13:00:00",
    closeTimeUtc: "22:00:00",
    active: true,
  });
  return {
    windows: [
      weekday(1, 1),
      weekday(2, 2),
      weekday(3, 3),
      weekday(4, 4),
      weekday(5, 5),
      {
        id: "demo-oh-6",
        dayOfWeek: 6,
        openTimeUtc: "14:00:00",
        closeTimeUtc: "18:00:00",
        active: true,
      },
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════
// SUPPORT TICKETS
// ════════════════════════════════════════════════════════════════════════

// GET /admin/support/tickets
export function demoSupportTickets() {
  return {
    tickets: [
      {
        id: "demo-ticket-1",
        subject: "How do I add a second fax number?",
        status: "awaiting_tenant",
        botAnswered: true,
        botConfidence: 0.91,
        createdByEmail: "demo.admin@caremetric.example",
        createdAt: daysAgo(2),
        updatedAt: daysAgo(2),
        lastActivityAt: daysAgo(2),
      },
      {
        id: "demo-ticket-2",
        subject: "Stripe payout schedule question",
        status: "awaiting_platform",
        botAnswered: false,
        botConfidence: null,
        createdByEmail: "demo.admin@caremetric.example",
        createdAt: daysAgo(5),
        updatedAt: daysAgo(1),
        lastActivityAt: daysAgo(1),
      },
      {
        id: "demo-ticket-3",
        subject: "Resolved: branding logo upload",
        status: "resolved",
        botAnswered: true,
        botConfidence: 0.84,
        createdByEmail: "demo.admin@caremetric.example",
        createdAt: daysAgo(12),
        updatedAt: daysAgo(10),
        lastActivityAt: daysAgo(10),
      },
    ],
  };
}

// GET /admin/support/tickets/:id
export function demoSupportTicketDetail(id: string) {
  return {
    ticket: {
      id,
      subject: "How do I add a second fax number?",
      status: "awaiting_tenant",
      botAnswered: true,
      botConfidence: 0.91,
      createdByEmail: "demo.admin@caremetric.example",
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
      lastActivityAt: daysAgo(2),
    },
    messages: [
      {
        id: `${id}-msg-1`,
        authorRole: "tenant",
        authorEmail: "demo.admin@caremetric.example",
        body: "We want a dedicated fax line for our second location — how do I set that up?",
        createdAt: daysAgo(2),
      },
      {
        id: `${id}-msg-2`,
        authorRole: "bot",
        authorEmail: null,
        body: "You can provision a fax number under System Configuration → Fax settings (/admin/organization/fax-settings). Click Provision to order a Telnyx DID, or paste an existing ported number. (Demo answer — nothing is provisioned in the sandbox.)",
        createdAt: daysAgo(2),
      },
    ],
  };
}

// ════════════════════════════════════════════════════════════════════════
// OPS STATUS (operations center)
// ════════════════════════════════════════════════════════════════════════

// GET /admin/ops-status
export function demoOpsStatus() {
  return {
    vendors: {
      sendgrid: true,
      twilioVoice: true,
      twilioSms: true,
      telnyxFax: true,
      stripe: true,
      objectStorage: true,
    },
    vendorsPendingRestart: {
      sendgrid: false,
      twilioVoice: false,
      twilioSms: false,
      telnyxFax: false,
      stripe: false,
      objectStorage: false,
    },
    dispatchers: {
      abandonedCart: { eligibleNow: 4 },
      reviewRequest: { eligibleNow: 7 },
      rxRenewal: { eligibleNow: 3 },
      smartTrigger: { eligibleNow: 5 },
      pendingFax: { eligibleNow: 2 },
    },
    team: {
      activeAdmins: 1,
      activeAgents: 3,
      pendingInvites: 1,
    },
    voiceHandoffs: {
      open: 2,
      urgent: 1,
    },
    serverTime: NOW_ISO(),
  };
}

// ════════════════════════════════════════════════════════════════════════
// FHIR R4
// ════════════════════════════════════════════════════════════════════════

const FHIR_SOFTWARE_NAME = "CareMetric Breathe DME Platform";

// GET /fhir/r4/metadata
export function demoFhirCapabilityStatement() {
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: NOW_ISO(),
    publisher: FHIR_SOFTWARE_NAME,
    kind: "instance",
    software: { name: FHIR_SOFTWARE_NAME, version: "0.1" },
    fhirVersion: "4.0.1",
    format: ["application/fhir+json"],
    rest: [
      {
        mode: "server",
        security: { service: [{ text: "OAuth2 (planned)" }] },
        resource: [
          {
            type: "Patient",
            interaction: [{ code: "read" }],
            operation: [
              { name: "everything", definition: "Patient-$everything" },
            ],
          },
          { type: "Coverage", interaction: [{ code: "read" }] },
          { type: "Condition", interaction: [{ code: "read" }] },
          { type: "MedicationRequest", interaction: [{ code: "read" }] },
          { type: "Device", interaction: [{ code: "read" }] },
        ],
      },
    ],
  };
}

function demoFhirPatientResource(id: string) {
  return {
    resourceType: "Patient",
    id,
    name: [{ family: "Sample", given: ["Jordan"] }],
    telecom: [
      { system: "phone", value: "+12155550101", use: "home" },
      { system: "email", value: "jordan@caremetric.example" },
    ],
    birthDate: "1972-03-14",
    address: [
      {
        use: "home",
        line: ["415 Maple Avenue"],
        city: "Philadelphia",
        state: "PA",
        postalCode: "19107",
        country: "US",
      },
    ],
  };
}

// GET /fhir/r4/Patient/:id
export function demoFhirPatient(id: string) {
  return demoFhirPatientResource(id);
}

// GET /fhir/r4/Patient/:id/$everything
export function demoFhirEverything(id: string) {
  const entries: Array<{ fullUrl: string; resource: Record<string, unknown> }> =
    [
      { fullUrl: `Patient/${id}`, resource: demoFhirPatientResource(id) },
      {
        fullUrl: "Coverage/demo-cov-1",
        resource: {
          resourceType: "Coverage",
          id: "demo-cov-1",
          status: "active",
          subscriberId: "W2840173355",
          beneficiary: { reference: `Patient/${id}` },
          period: { start: "2025-01-01" },
          payor: [{ display: "Aetna Choice PPO" }],
          order: 1,
          class: [{ type: { text: "plan" }, value: "Aetna Choice PPO" }],
        },
      },
      {
        fullUrl: "Condition/demo-cond-1",
        resource: {
          resourceType: "Condition",
          id: "demo-cond-1",
          subject: { reference: `Patient/${id}` },
          code: {
            coding: [
              {
                system: "http://hl7.org/fhir/sid/icd-10-cm",
                code: "G47.33",
              },
            ],
          },
          recordedDate: dateOnly(-200),
        },
      },
      {
        fullUrl: "MedicationRequest/demo-rx-1",
        resource: {
          resourceType: "MedicationRequest",
          id: "demo-rx-1",
          status: "active",
          intent: "order",
          subject: { reference: `Patient/${id}` },
          requester: { reference: "Practitioner/demo-provider-1" },
          medicationCodeableConcept: {
            coding: [
              {
                system:
                  "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
                code: "A7034",
              },
            ],
          },
          authoredOn: dateOnly(-200),
          dispenseRequest: {
            validityPeriod: { start: dateOnly(-200), end: dateOnly(160) },
          },
        },
      },
      {
        fullUrl: "Device/demo-device-1",
        resource: {
          resourceType: "Device",
          id: "demo-device-1",
          patient: { reference: `Patient/${id}` },
          type: { text: "PAP device" },
          serialNumber: "23191234567",
          modelNumber: "AirSense 11 AutoSet",
          manufacturer: "ResMed",
          note: [{ text: `Dispensed: ${dateOnly(-210)}` }],
        },
      },
    ];
  return {
    resourceType: "Bundle",
    type: "searchset",
    total: entries.length,
    entry: entries,
  };
}
