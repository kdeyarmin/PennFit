// Demo-sandbox handlers (extension batch 1) for a slice of the admin
// billing / CSR / bot-playground surfaces. The fetch interceptor's empty
// `{}` fallback would crash these admin pages (they read nested keys and
// map over arrays without optional chaining), so each route below returns
// fully-shaped sample data matching the live API response (see the
// corresponding artifacts/resupply-api/src/routes/admin/*.ts route file
// named in the section header).
//
// DATA RULES: everything here is fictional demo data — obviously-fake
// names ("Demo Patient", "Avery Sample"), demo ids, 555 phone numbers,
// fresh relative dates, and money in cents. Platform identity is
// CareMetric Breathe (noreply@cmbreathe.com); the sandbox tenant is
// CareMetric Demo DME / demo.example (info@demo.example). NO real PHI,
// NO real secrets — clearinghouse credentials use obvious placeholders
// and the route's masked shape (only `realtimePasswordSet`, never a key).

import { route, type DemoHandler, type DemoRequest } from "../types";
import { json } from "../respond";
import { daysAgo, dateOnly, NOW_ISO } from "../fixtures/dates";

// ── billing-reports.ts ────────────────────────────────────────────────
// GET /resupply-api/admin/billing/aging-report
//   { overall, perPayer, totalOpenBilledCents, totalOpenClaimCount,
//     generatedAt }
type AgingBucket = "0_30" | "31_60" | "61_90" | "90_plus";
type Bucket = { claimCount: number; billedCents: number };
type BucketMap = Record<AgingBucket, Bucket>;

function buckets(
  a: number,
  ac: number,
  b: number,
  bc: number,
  c: number,
  cc: number,
  d: number,
  dc: number,
): BucketMap {
  return {
    "0_30": { claimCount: a, billedCents: ac },
    "31_60": { claimCount: b, billedCents: bc },
    "61_90": { claimCount: c, billedCents: cc },
    "90_plus": { claimCount: d, billedCents: dc },
  };
}

function agingReport() {
  const overall = buckets(18, 612_400, 11, 388_900, 6, 214_500, 4, 176_200);
  const perPayer = [
    {
      payerName: "Demo Medicare DME MAC",
      buckets: buckets(9, 318_200, 5, 171_400, 3, 96_300, 1, 42_100),
    },
    {
      payerName: "Demo Medicaid MCO",
      buckets: buckets(5, 184_700, 3, 121_800, 2, 78_200, 2, 91_600),
    },
    {
      payerName: "Demo PPO",
      buckets: buckets(4, 109_500, 3, 95_700, 1, 40_000, 1, 42_500),
    },
  ];
  const sum = (b: BucketMap) =>
    b["0_30"].billedCents +
    b["31_60"].billedCents +
    b["61_90"].billedCents +
    b["90_plus"].billedCents;
  const totalOpenBilledCents = sum(overall);
  return {
    overall,
    perPayer,
    totalOpenBilledCents,
    totalOpenClaimCount: 39,
    generatedAt: NOW_ISO(),
  };
}

// GET /resupply-api/admin/billing/dso-by-payer
//   { payers: [...], windowDays, generatedAt }
function dsoByPayer() {
  return {
    payers: [
      {
        payerName: "Demo Medicare DME MAC",
        claimCount: 84,
        totalPaidCents: 2_184_600,
        averageDaysToPay: 21.4,
      },
      {
        payerName: "Demo PPO",
        claimCount: 41,
        totalPaidCents: 1_092_300,
        averageDaysToPay: 29.8,
      },
      {
        payerName: "Demo Medicaid MCO",
        claimCount: 33,
        totalPaidCents: 712_900,
        averageDaysToPay: 38.2,
      },
    ],
    windowDays: 180,
    generatedAt: NOW_ISO(),
  };
}

// GET /resupply-api/admin/billing/denial-rate
//   { overall, perPayer, windowDays, generatedAt }
function denialRate() {
  const perPayer = [
    { payerName: "Demo Medicaid MCO", decisions: 60, denials: 9 },
    { payerName: "Demo PPO", decisions: 48, denials: 4 },
    { payerName: "Demo Medicare DME MAC", decisions: 102, denials: 5 },
  ].map((p) => ({ ...p, denialRate: p.denials / p.decisions }));
  const decisions = perPayer.reduce((n, p) => n + p.decisions, 0);
  const denials = perPayer.reduce((n, p) => n + p.denials, 0);
  return {
    overall: { decisions, denials, denialRate: denials / decisions },
    perPayer: [...perPayer].sort((a, b) => b.denials - a.denials),
    windowDays: 90,
    generatedAt: NOW_ISO(),
  };
}

// NOTE: the billing-statement-send endpoints (statements/pending,
// statements/mail-queue, statements/:id/send, statements/batch-send,
// statements/mark-mailed) are already seeded by handlers/billing-claims.ts,
// which registers earlier and wins the first-match router. They are
// intentionally NOT duplicated here.

// ── bot-playground.ts (lib/bot-playground/playground.ts) ──────────────
// GET /resupply-api/admin/bot-playground/info
//   { provider, scenarios: PlaygroundScenario[], limits }
function botPlaygroundInfo() {
  return {
    provider: "anthropic" as const,
    scenarios: [
      {
        id: "store-insurance",
        bot: "storefront" as const,
        label: "Insurance & cost",
        description: "Does the bot explain coverage without over-promising?",
        firstUserMessage:
          "Does my insurance cover a new mask, and how much will I pay out of pocket?",
      },
      {
        id: "store-pick-mask",
        bot: "storefront" as const,
        label: "Help me pick a mask",
        description: "Should call recommend_masks with the stated preferences.",
        firstUserMessage:
          "I'm a side sleeper with a beard and I hate having my nose covered. What mask should I get?",
      },
      {
        id: "account-where-order",
        bot: "account" as const,
        label: "Where's my order?",
        description: "Reads the synthetic order context, no real lookup.",
        firstUserMessage: "Has my last order shipped yet?",
      },
      {
        id: "voice-resupply",
        bot: "voice" as const,
        label: "Resupply outreach call",
        description: "How the agent frames a 90-day resupply check-in.",
        firstUserMessage: "Hi, I got a message that I'm due for new supplies?",
      },
    ],
    limits: { maxTurns: 16, maxMessageChars: 2000 },
  };
}

// GET /resupply-api/admin/bot-playground/prompt
//   { bot, systemPrompt, chars, promptVersion? }
function botPlaygroundPrompt(req: DemoRequest) {
  const raw = req.query.get("bot");
  const bot =
    raw === "account" || raw === "voice" || raw === "storefront"
      ? raw
      : "storefront";
  const systemPrompt =
    "[demo] You are the CareMetric Assistant for CareMetric Demo DME. " +
    "Be warm and concise. Never promise specific insurance coverage. " +
    "Hand off to a human for anything order-, account-, or clinical-specific. " +
    `(This is a demo-mode rendering of the "${bot}" bot prompt — the live ` +
    "prompt is much longer and grounded in the full knowledge base.)";
  return {
    bot,
    systemPrompt,
    chars: systemPrompt.length,
    promptVersion: bot === "voice" ? "2026-06-10.v9" : undefined,
  };
}

// POST /resupply-api/admin/bot-playground/run → PlaygroundRunResult
function botPlaygroundRun() {
  return {
    reply:
      "Happy to help! Replacement cushions are due about every 30 days under " +
      "most plans. I can't confirm your exact out-of-pocket here, but our team " +
      "can check your coverage — want me to have someone reach out?",
    toolCalls: [],
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
    rounds: 1,
  };
}

// ── capped-rental-cycles.ts ───────────────────────────────────────────
// GET /resupply-api/admin/capped-rental-cycles → { cycles: Row[] }
const CAPPED_RENTAL_CYCLES = [
  {
    id: "demo-crc-0001-0000-0000-0000-000000000001",
    patient_id: "demo-p-2004",
    hcpcs_code: "E0601",
    payer_profile_id: "demo-payer-1",
    insurance_coverage_id: "demo-cov-1",
    start_date: dateOnly(-95),
    current_month: 4,
    max_months: 13,
    status: "active",
    ownership_transferred_on: null,
    notes: "Standard CPAP capped rental",
    created_at: daysAgo(95),
    updated_at: daysAgo(5),
  },
  {
    id: "demo-crc-0001-0000-0000-0000-000000000002",
    patient_id: "demo-p-3007",
    hcpcs_code: "E0470",
    payer_profile_id: "demo-payer-2",
    insurance_coverage_id: "demo-cov-2",
    start_date: dateOnly(-380),
    current_month: 13,
    max_months: 13,
    status: "transferred",
    ownership_transferred_on: dateOnly(-15),
    notes: "Converted to patient-owned at month 13",
    created_at: daysAgo(380),
    updated_at: daysAgo(15),
  },
  {
    id: "demo-crc-0001-0000-0000-0000-000000000003",
    patient_id: "demo-p-2005",
    hcpcs_code: "E0601",
    payer_profile_id: "demo-payer-1",
    insurance_coverage_id: null,
    start_date: dateOnly(-60),
    current_month: 2,
    max_months: 13,
    status: "paused",
    ownership_transferred_on: null,
    notes: "Paused — patient hospitalized",
    created_at: daysAgo(60),
    updated_at: daysAgo(3),
  },
];

// GET /resupply-api/admin/capped-rental-cycles/:id/preview
function cappedRentalPreview(id: string) {
  const cycle =
    CAPPED_RENTAL_CYCLES.find((c) => c.id === id) ?? CAPPED_RENTAL_CYCLES[0];
  const atCap = cycle.current_month >= cycle.max_months;
  const billedMonth = atCap ? null : cycle.current_month + 1;
  return {
    cycleId: cycle.id,
    hcpcsCode: cycle.hcpcs_code,
    status: cycle.status,
    currentMonth: cycle.current_month,
    maxMonths: cycle.max_months,
    action: atCap ? "noop" : "advance",
    billedMonth,
    nextDueOn: dateOnly(12),
    kxGated: cycle.hcpcs_code === "E0601",
    modifiersIfCompliant: billedMonth == null ? [] : ["KX", "RR"],
    modifiersIfNotCompliant: billedMonth == null ? [] : ["RR"],
  };
}

// ── cases.ts ──────────────────────────────────────────────────────────
// GET /resupply-api/admin/cases → { cases: [...] }
const CASES = [
  {
    id: "demo-case-0001",
    title: "Replacement cushion sizing question",
    status: "open",
    priority: "normal",
    patientId: "demo-p-2004",
    customerId: null,
    assignedToUserId: "demo-user-csr-1",
    openedByEmail: "demo.csr@demo.example",
    summary: "Patient unsure between medium and large nasal cushion.",
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
    resolvedAt: null,
  },
  {
    id: "demo-case-0002",
    title: "Denied claim — needs face-to-face note",
    status: "in_progress",
    priority: "high",
    patientId: "demo-p-3007",
    customerId: null,
    assignedToUserId: "demo-user-rt-1",
    openedByEmail: "demo.csr@demo.example",
    summary: "Chasing the prescriber for the F2F evaluation note.",
    createdAt: daysAgo(5),
    updatedAt: daysAgo(1),
    resolvedAt: null,
  },
  {
    id: "demo-case-0003",
    title: "Late shipment complaint",
    status: "resolved",
    priority: "normal",
    patientId: null,
    customerId: "demo-cust-9001",
    assignedToUserId: "demo-user-csr-1",
    openedByEmail: "demo.csr@demo.example",
    summary: "Reshipped via expedited; customer satisfied.",
    createdAt: daysAgo(14),
    updatedAt: daysAgo(10),
    resolvedAt: daysAgo(10),
  },
];

// GET /resupply-api/admin/cases/:id → { case, links: [...] }
function caseDetail(id: string) {
  const c = CASES.find((x) => x.id === id) ?? CASES[0];
  return {
    case: c,
    links: [
      {
        id: "demo-caselink-0001",
        linkKind: "order",
        refId: "demo-order-7001",
        note: "Order under discussion",
        createdByEmail: "demo.csr@demo.example",
        createdAt: daysAgo(2),
      },
      {
        id: "demo-caselink-0002",
        linkKind: "conversation",
        refId: "demo-conv-5501",
        note: null,
        createdByEmail: "demo.csr@demo.example",
        createdAt: daysAgo(1),
      },
    ],
  };
}

// ── claim-paperwork.ts (lib/billing/bill-hold.ts) ─────────────────────
// holdSummary = { held, outstanding: string[], requirements: Row[] }
function paperworkRequirement(over: {
  id: string;
  claim_id: string | null;
  requirement_type: string;
  label: string;
  status: string;
  sent_via?: string | null;
  ago: number;
}) {
  return {
    id: over.id,
    claim_id: over.claim_id,
    patient_id: "demo-p-2004",
    requirement_type: over.requirement_type,
    label: over.label,
    status: over.status,
    required: true,
    sent_at: over.sent_via ? daysAgo(over.ago) : null,
    sent_via: over.sent_via ?? null,
    expected_return_fax_e164: "+15555550101",
    reminder_count: over.status === "outstanding" ? 1 : 0,
    last_reminded_at: over.status === "outstanding" ? daysAgo(1) : null,
    satisfied_at: over.status === "satisfied" ? daysAgo(over.ago - 1) : null,
    satisfied_via: over.status === "satisfied" ? "fax" : null,
    satisfied_by_email:
      over.status === "satisfied" ? "demo.csr@demo.example" : null,
    satisfied_inbound_fax_id: null,
    satisfied_document_id: null,
    source_manual_document_id: null,
    source_packet_id: null,
    waived_reason: null,
    notes: null,
    created_by_email: "demo.csr@demo.example",
    created_at: daysAgo(over.ago),
    updated_at: daysAgo(1),
  };
}

function claimPaperworkSummary(claimId: string | null) {
  const requirements = [
    paperworkRequirement({
      id: "demo-pwr-0001",
      claim_id: claimId,
      requirement_type: "prescription",
      label: "Signed prescription / Standard Written Order",
      status: "satisfied",
      sent_via: "fax",
      ago: 9,
    }),
    paperworkRequirement({
      id: "demo-pwr-0002",
      claim_id: claimId,
      requirement_type: "face_to_face",
      label: "Face-to-face evaluation note",
      status: "outstanding",
      sent_via: "fax",
      ago: 5,
    }),
    paperworkRequirement({
      id: "demo-pwr-0003",
      claim_id: claimId,
      requirement_type: "proof_of_delivery",
      label: "Signed proof of delivery",
      status: "outstanding",
      ago: 4,
    }),
  ];
  const outstanding = requirements
    .filter((r) => r.required && r.status === "outstanding")
    .map((r) => r.label);
  return { held: outstanding.length > 0, outstanding, requirements };
}

// GET /resupply-api/admin/billing/bill-hold-worklist
//   { items: [...], count, totalHeldCents }
function billHoldWorklist() {
  const items = [
    {
      claimId: "demo-claim-8001",
      patientId: "demo-p-2004",
      patientName: "Avery Sample",
      payerName: "Demo Medicare DME MAC",
      dateOfService: dateOnly(-12),
      totalBilledCents: 28900,
      heldSince: daysAgo(8),
      reason: "Awaiting signed paperwork",
      outstanding: [
        {
          label: "Face-to-face evaluation note",
          requirementType: "face_to_face",
        },
        {
          label: "Signed proof of delivery",
          requirementType: "proof_of_delivery",
        },
      ],
    },
    {
      claimId: "demo-claim-8002",
      patientId: "demo-p-3007",
      patientName: "Demo Patient",
      payerName: "Demo Medicaid MCO",
      dateOfService: dateOnly(-20),
      totalBilledCents: 41200,
      heldSince: daysAgo(15),
      reason: "Awaiting signed paperwork",
      outstanding: [
        { label: "Sleep study report", requirementType: "sleep_study" },
      ],
    },
  ];
  return {
    items,
    count: items.length,
    totalHeldCents: items.reduce((s, i) => s + i.totalBilledCents, 0),
  };
}

// ── claim-templates.ts ────────────────────────────────────────────────
// GET /resupply-api/admin/claim-templates → { templates: [...] }
const CLAIM_TEMPLATES = [
  {
    id: "demo-tmpl-0001-0000-0000-0000-000000000001",
    slug: "cpap_setup",
    displayName: "CPAP new setup (E0601 + supplies)",
    description: "Initial CPAP device + first-month accessories.",
    lines: [
      {
        hcpcsCode: "E0601",
        modifier: "RR,KX",
        description: "CPAP device (rental)",
        quantity: 1,
        chargeCents: 28900,
      },
      {
        hcpcsCode: "A7030",
        modifier: null,
        description: "Full-face mask",
        quantity: 1,
        chargeCents: 12500,
      },
      {
        hcpcsCode: "A7037",
        modifier: null,
        description: "Tubing",
        quantity: 1,
        chargeCents: 2200,
      },
    ],
    defaultDiagnosisCodes: ["G47.33"],
    scopedPayerProfileId: null,
    isActive: true,
    createdAt: daysAgo(120),
    updatedAt: daysAgo(20),
  },
  {
    id: "demo-tmpl-0001-0000-0000-0000-000000000002",
    slug: "resupply_monthly",
    displayName: "Monthly resupply (cushion + filters)",
    description: "Standard 30-day resupply bundle.",
    lines: [
      {
        hcpcsCode: "A7032",
        modifier: null,
        description: "Nasal cushion",
        quantity: 2,
        chargeCents: 3600,
      },
      {
        hcpcsCode: "A7038",
        modifier: null,
        description: "Disposable filters",
        quantity: 2,
        chargeCents: 900,
      },
    ],
    defaultDiagnosisCodes: ["G47.33"],
    scopedPayerProfileId: "demo-payer-1",
    isActive: true,
    createdAt: daysAgo(90),
    updatedAt: daysAgo(7),
  },
];

// ── clearinghouse-credentials.ts ──────────────────────────────────────
// NEVER seed real secrets — only the masked shape (realtimePasswordSet).
function clearinghouseRow(over: {
  id: string;
  slug: string;
  displayName: string;
  usageIndicator: "P" | "T";
  isActive: boolean;
  realtimePasswordSet: boolean;
}) {
  return {
    id: over.id,
    slug: over.slug,
    displayName: over.displayName,
    usageIndicator: over.usageIndicator,
    sftpHost: "sftp.demo-clearinghouse.example",
    sftpPort: 22,
    sftpUsername: "demo_submitter",
    privateKeyPath: "/secrets/demo/office-ally.key",
    knownHostsPath: "/secrets/demo/known_hosts",
    remoteInboxDir: "inbound",
    remoteOutboundDir: "outbound",
    remoteArchiveDir: "archive",
    etin: "DEMO12345",
    submitterOrganizationName: "CareMetric Demo DME",
    contactName: "Demo Biller",
    contactPhoneE164: "+15555550133",
    isActive: over.isActive,
    lastPolledAt: daysAgo(1),
    notes: "Demo clearinghouse configuration — no real credentials.",
    realtimeEnabled: over.realtimePasswordSet,
    realtimeUrl: over.realtimePasswordSet
      ? "https://realtime.demo-clearinghouse.example/edi"
      : null,
    realtimeUsername: over.realtimePasswordSet ? "demo_rt_user" : null,
    realtimeSenderId: over.realtimePasswordSet ? "DEMOSND" : null,
    realtimeReceiverId: over.realtimePasswordSet ? "DEMORCV" : null,
    realtimeTimeoutMs: over.realtimePasswordSet ? 30000 : null,
    // Masked: only whether a password exists, never the value.
    realtimePasswordSet: over.realtimePasswordSet,
    discoveryEnabled: false,
    discoveryUrl: null,
    createdAt: daysAgo(200),
    updatedAt: daysAgo(10),
  };
}

const CLEARINGHOUSES = [
  clearinghouseRow({
    id: "demo-ch-0001-0000-0000-0000-000000000001",
    slug: "office_ally_prod",
    displayName: "Office Ally (Production)",
    usageIndicator: "P",
    isActive: true,
    realtimePasswordSet: true,
  }),
  clearinghouseRow({
    id: "demo-ch-0001-0000-0000-0000-000000000002",
    slug: "office_ally_test",
    displayName: "Office Ally (Test)",
    usageIndicator: "T",
    isActive: false,
    realtimePasswordSet: false,
  }),
];

// GET /resupply-api/admin/clearinghouse-inbound-files → { files: [...] }
const CLEARINGHOUSE_INBOUND_FILES = [
  {
    id: "demo-chf-0001",
    clearinghouseId: "demo-ch-0001-0000-0000-0000-000000000001",
    remotePath: "inbound/DEMO_835_001.txt",
    fileName: "DEMO_835_001.txt",
    fileSha256:
      "demo0000000000000000000000000000000000000000000000000000000835",
    fileSizeBytes: 18420,
    fileKind: "835",
    parseSummary: { claims: 6, totalPaidCents: 184600 },
    dispatchStatus: "dispatched",
    appliedToEraFileId: "demo-era-0001",
    appliedToSubmissionId: null,
    errorMessage: null,
    downloadedAt: daysAgo(1),
    dispatchedAt: daysAgo(1),
  },
  {
    id: "demo-chf-0002",
    clearinghouseId: "demo-ch-0001-0000-0000-0000-000000000001",
    remotePath: "inbound/DEMO_277_002.txt",
    fileName: "DEMO_277_002.txt",
    fileSha256:
      "demo0000000000000000000000000000000000000000000000000000000277",
    fileSizeBytes: 9210,
    fileKind: "277ca",
    parseSummary: { acknowledged: 8, rejected: 1 },
    dispatchStatus: "parsed",
    appliedToEraFileId: null,
    appliedToSubmissionId: "demo-sub-0002",
    errorMessage: null,
    downloadedAt: daysAgo(2),
    dispatchedAt: null,
  },
];

// ── click-to-dial.ts ──────────────────────────────────────────────────
// POST /resupply-api/admin/patients/call-dispositions
//   { dispositions: [...], count }
function callDispositions() {
  const dispositions = [
    {
      id: "demo-disp-0001",
      outcome: "reached",
      note: "Confirmed resupply order; happy with current mask.",
      agentEmail: "demo.csr@demo.example",
      createdAt: daysAgo(1),
    },
    {
      id: "demo-disp-0002",
      outcome: "voicemail",
      note: "Left message re: prescription renewal.",
      agentEmail: "demo.csr@demo.example",
      createdAt: daysAgo(4),
    },
    {
      id: "demo-disp-0003",
      outcome: "callback_requested",
      note: "Patient asked to call back after 5pm.",
      agentEmail: "demo.rt@demo.example",
      createdAt: daysAgo(9),
    },
  ];
  return { dispositions, count: dispositions.length };
}

export const ext1Handlers: DemoHandler[] = [
  // ── billing-reports.ts ──────────────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/aging-report", () =>
    json(agingReport()),
  ),
  route("GET", "/resupply-api/admin/billing/dso-by-payer", () =>
    json(dsoByPayer()),
  ),
  route("GET", "/resupply-api/admin/billing/denial-rate", () =>
    json(denialRate()),
  ),

  // billing-statement-send.ts endpoints are seeded by billing-claims.ts
  // (see note above) — not duplicated here.

  // ── bot-playground.ts ───────────────────────────────────────────────
  route("GET", "/resupply-api/admin/bot-playground/info", () =>
    json(botPlaygroundInfo()),
  ),
  route("GET", "/resupply-api/admin/bot-playground/prompt", (req) =>
    json(botPlaygroundPrompt(req)),
  ),
  route("POST", "/resupply-api/admin/bot-playground/run", () =>
    json(botPlaygroundRun()),
  ),
  // Live voice test call is disabled in demo mode (no telephony).
  route("POST", "/resupply-api/admin/bot-playground/voice-call", () =>
    json(
      {
        error: "voice_not_configured",
        message: "Live voice test calls are unavailable in the demo sandbox.",
      },
      503,
    ),
  ),

  // ── capped-rental-cycles.ts ─────────────────────────────────────────
  route("GET", "/resupply-api/admin/capped-rental-cycles", (req) => {
    const status = req.query.get("status");
    const cycles = status
      ? CAPPED_RENTAL_CYCLES.filter((c) => c.status === status)
      : CAPPED_RENTAL_CYCLES;
    return json({ cycles });
  }),
  route(
    "GET",
    "/resupply-api/admin/capped-rental-cycles/:id/preview",
    (_req, params) => json(cappedRentalPreview(params.id)),
  ),
  route("POST", "/resupply-api/admin/capped-rental-cycles", () =>
    json({ id: "demo-crc-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/capped-rental-cycles/:id", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/admin/capped-rental-cycles/advance-now", () =>
    json({
      ok: true,
      stats: { examined: 3, advanced: 1, transferred: 0, skipped: 2 },
    }),
  ),

  // ── carrier-labels.ts ───────────────────────────────────────────────
  // Vendor is unconfigured in demo — mirror the live 503 the UI handles.
  route("POST", "/resupply-api/admin/shop/returns/:returnId/label", () =>
    json(
      {
        error: "vendor_not_configured",
        message: "Configure CARRIER_LABEL_VENDOR to enable label generation.",
      },
      503,
    ),
  ),

  // ── cases.ts ────────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/cases", (req) => {
    const status = req.query.get("status");
    const cases =
      !status || status === "all"
        ? status === "all"
          ? CASES
          : CASES.filter((c) => c.status === "open")
        : CASES.filter((c) => c.status === status);
    return json({ cases });
  }),
  route("GET", "/resupply-api/admin/cases/:id", (_req, params) =>
    json(caseDetail(params.id)),
  ),
  route("POST", "/resupply-api/admin/cases", () =>
    json({ id: "demo-case-00ff", createdAt: NOW_ISO() }, 201),
  ),
  route("PATCH", "/resupply-api/admin/cases/:id", (req, params) => {
    const body = req.json<{ status?: string }>();
    return json({ id: params.id, status: body?.status ?? "open" });
  }),
  route("POST", "/resupply-api/admin/cases/:id/links", () =>
    json({ linked: true }, 201),
  ),

  // ── catalog-seed.ts ─────────────────────────────────────────────────
  route("POST", "/resupply-api/admin/shop/catalog/seed", () =>
    json({ created: 26, updated: 0, pricesCreated: 26, total: 26 }),
  ),

  // ── claim-paperwork.ts ──────────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/admin/claims/:claimId/paperwork",
    (_req, params) => json(claimPaperworkSummary(params.claimId)),
  ),
  route("POST", "/resupply-api/admin/patients/paperwork/query", () =>
    json(claimPaperworkSummary("demo-claim-8001")),
  ),
  route("GET", "/resupply-api/admin/billing/bill-hold-worklist", () =>
    json(billHoldWorklist()),
  ),
  route(
    "POST",
    "/resupply-api/admin/claims/:claimId/paperwork/seed-defaults",
    () => json({ created: 3 }),
  ),
  route("POST", "/resupply-api/admin/claims/:claimId/paperwork", () =>
    json(
      {
        id: "demo-pwr-00ff",
        billHold: {
          claimId: "demo-claim-8001",
          held: true,
          changed: false,
          outstandingCount: 3,
        },
      },
      201,
    ),
  ),
  route("PATCH", "/resupply-api/admin/claim-paperwork/:id", () =>
    json({
      ok: true,
      billHold: {
        claimId: "demo-claim-8001",
        held: true,
        changed: false,
        outstandingCount: 2,
      },
    }),
  ),
  route("POST", "/resupply-api/admin/claim-paperwork/:id/satisfy", (_r, p) =>
    json({
      requirement: paperworkRequirement({
        id: p.id,
        claim_id: "demo-claim-8001",
        requirement_type: "proof_of_delivery",
        label: "Signed proof of delivery",
        status: "satisfied",
        sent_via: "fax",
        ago: 4,
      }),
      billHold: {
        claimId: "demo-claim-8001",
        held: true,
        changed: false,
        outstandingCount: 1,
      },
    }),
  ),
  route("POST", "/resupply-api/admin/claim-paperwork/:id/remind", () =>
    json({ ok: true, reminderCount: 2 }),
  ),
  route(
    "POST",
    "/resupply-api/admin/inbound-faxes/:faxId/link-paperwork",
    (_r, p) =>
      json({
        requirement: paperworkRequirement({
          id: "demo-pwr-0002",
          claim_id: "demo-claim-8001",
          requirement_type: "face_to_face",
          label: "Face-to-face evaluation note",
          status: "satisfied",
          sent_via: "fax",
          ago: 5,
        }),
        billHold: {
          claimId: "demo-claim-8001",
          held: false,
          changed: true,
          outstandingCount: 0,
        },
        faxId: p.faxId,
      }),
  ),

  // ── claim-templates.ts ──────────────────────────────────────────────
  route("GET", "/resupply-api/admin/claim-templates", () =>
    json({ templates: CLAIM_TEMPLATES }),
  ),
  route("POST", "/resupply-api/admin/claim-templates", () =>
    json({ id: "demo-tmpl-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/claim-templates/:id", () =>
    json({ ok: true }),
  ),
  route(
    "POST",
    "/resupply-api/admin/patients/:id/insurance-claims/:claimId/apply-template",
    () => json({ ok: true, linesAdded: 3, newTotalCents: 43600 }, 201),
  ),

  // ── clearinghouse-credentials.ts (masked — no secrets) ──────────────
  route("GET", "/resupply-api/admin/clearinghouse-credentials", () =>
    json({ clearinghouses: CLEARINGHOUSES }),
  ),
  route("GET", "/resupply-api/admin/clearinghouse-credentials/:id", (_r, p) => {
    const ch = CLEARINGHOUSES.find((c) => c.id === p.id);
    return ch ? json({ clearinghouse: ch }) : json({ error: "not_found" }, 404);
  }),
  route("POST", "/resupply-api/admin/clearinghouse-credentials", () =>
    json({ id: "demo-ch-0001-0000-0000-0000-0000000000ff" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/clearinghouse-credentials/:id", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/admin/clearinghouse-credentials/:id/test", () =>
    json({ ok: true, fileCount: 4 }),
  ),
  route("POST", "/resupply-api/admin/office-ally/poll-now", () =>
    json({
      ok: true,
      stats: { downloaded: 2, parsed: 2, dispatched: 1, skipped: 0 },
    }),
  ),
  route("GET", "/resupply-api/admin/clearinghouse-inbound-files", () =>
    json({ files: CLEARINGHOUSE_INBOUND_FILES }),
  ),

  // ── click-to-dial.ts ────────────────────────────────────────────────
  route("POST", "/resupply-api/admin/patients/call-dispositions", () =>
    json(callDispositions()),
  ),
  // Outbound calling is unavailable in demo — mirror the live 503.
  route("POST", "/resupply-api/admin/patients/:patientId/click-to-dial", () =>
    json(
      {
        error: "voice_outbound_not_configured",
        message: "Outbound calling is unavailable in the demo sandbox.",
      },
      503,
    ),
  ),
  route("POST", "/resupply-api/admin/call-dispositions/:id", (req, params) => {
    const body = req.json<{ outcome?: string }>();
    return json({ id: params.id, outcome: body?.outcome ?? "reached" });
  }),

  // ── cms-fee-schedule-import.ts ──────────────────────────────────────
  route("POST", "/resupply-api/admin/payer-fee-schedules/import-cms", () =>
    json({ accepted: 142, replaced: 138, warnings: [] }, 201),
  ),
];
