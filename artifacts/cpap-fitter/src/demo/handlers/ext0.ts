// Extension batch 0 of demo handlers. Seeds a cluster of admin route
// files (abandoned-cart nudges, the account-setup launch checklist,
// CSR availability, tenant agreements, per-patient alert overrides,
// asset-recovery worklist, and the billing dashboard / batch flows) so
// those admin pages render realistic sample data instead of the
// interceptor's empty `{}` fallback. Each handler matches the EXACT
// `res.json({...})` shape of its live route under
// artifacts/resupply-api/src/routes/admin/*.ts.
//
// DATA RULES: everything below is fictional demo data — obviously-fake
// names ("Demo Patient", "Avery Sample", "Jordan Quinn"), demo ids
// ("demo-..."), 555-range phones, money in integer cents. Platform brand
// is CareMetric Breathe (noreply@cmbreathe.com); the seed storefront
// tenant is Penn Home Medical Supply / pennpaps.com. NO real PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, hoursAgo, NOW_ISO } from "../fixtures/dates";

// ── Abandoned carts (abandoned-carts.ts) ──────────────────────────────
// GET  /resupply-api/admin/shop/abandoned-carts → { rows: [...] }
// POST /resupply-api/admin/shop/abandoned-carts/send-due → CartAbandonmentStats
function abandonedCartRows() {
  return {
    rows: [
      {
        id: "demo-cart-0001",
        customerId: "demo-cust-9001",
        emailRedacted: "de******@example.com",
        itemCount: 2,
        subtotalCents: 8990,
        currency: "usd",
        updatedAt: hoursAgo(30),
        remindedAt: null,
        recoveredAt: null,
        clearedAt: null,
        createdAt: daysAgo(2),
      },
      {
        id: "demo-cart-0002",
        customerId: "demo-cust-9002",
        emailRedacted: "av****@example.com",
        itemCount: 1,
        subtotalCents: 3499,
        currency: "usd",
        updatedAt: hoursAgo(50),
        remindedAt: hoursAgo(20),
        recoveredAt: null,
        clearedAt: null,
        createdAt: daysAgo(3),
      },
      {
        id: "demo-cart-0003",
        customerId: null,
        emailRedacted: "jo***@example.com",
        itemCount: 3,
        subtotalCents: 14250,
        currency: "usd",
        updatedAt: hoursAgo(72),
        remindedAt: hoursAgo(40),
        recoveredAt: hoursAgo(36),
        clearedAt: null,
        createdAt: daysAgo(4),
      },
    ],
  };
}

function cartAbandonmentSendDue() {
  return {
    scanned: 2,
    sent: 2,
    skippedNoConfig: 0,
    skippedFailed: 0,
    skippedOptOut: 1,
    sendgridConfigured: true,
  };
}

// ── Account setup checklist (account-setup.ts) ────────────────────────
// GET /resupply-api/platform/account-setup
//   { generatedAt, environment, items: AccountSetupItem[] }
function accountSetupChecklist() {
  type Item = {
    id: string;
    tab: "required" | "optional";
    group: string;
    title: string;
    description: string;
    status: "complete" | "incomplete" | "manual" | "unknown";
    detail: string | null;
    docHref: string | null;
    command: string | null;
  };
  const items: Item[] = [
    {
      id: "env-database-url",
      tab: "required",
      group: "Required environment",
      title: "Database connection",
      description:
        "DATABASE_URL — Postgres connection used by the migrator and the legacy worker paths.",
      status: "complete",
      detail: "Set.",
      docHref: null,
      command: null,
    },
    {
      id: "env-supabase",
      tab: "required",
      group: "Required environment",
      title: "Supabase runtime data path",
      description:
        "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — the runtime read/write path (PostgREST).",
      status: "complete",
      detail: "Both set.",
      docHref: null,
      command: null,
    },
    {
      id: "env-link-hmac",
      tab: "required",
      group: "Required environment",
      title: "Patient-link signing key",
      description:
        "RESUPPLY_LINK_HMAC_KEY — 32+ random bytes that sign the short-lived patient links.",
      status: "complete",
      detail: "Set.",
      docHref: null,
      command: null,
    },
    {
      id: "env-cors",
      tab: "required",
      group: "Required environment",
      title: "CORS allowlist",
      description:
        "RESUPPLY_ALLOWED_ORIGINS or RAILWAY_PUBLIC_DOMAIN — in production the API throws at boot if both are empty.",
      status: "complete",
      detail: "RAILWAY_PUBLIC_DOMAIN is set.",
      docHref: null,
      command: null,
    },
    {
      id: "db-migrations",
      tab: "required",
      group: "Database",
      title: "Apply database migrations",
      description:
        "Production's migration ledger is adopted and RUN_DB_MIGRATIONS is on, so every deploy auto-applies the pending tail.",
      status: "manual",
      detail:
        "Adopted — auto-runs on deploy. A manual run is a no-op when current.",
      docHref: null,
      command: "pnpm --filter @workspace/resupply-db run migrate",
    },
    {
      id: "first-admin",
      tab: "required",
      group: "Access",
      title: "Bootstrap the first admin",
      description:
        "Seed the first admin row and email a 1-hour password-reset link.",
      status: "complete",
      detail: "2 active admin accounts on file.",
      docHref: null,
      command: null,
    },
    {
      id: "vendor-stripe",
      tab: "optional",
      group: "Payments",
      title: "Stripe",
      description: "Cash-pay storefront checkout and refunds.",
      status: "complete",
      detail: "Configured (secret key + webhook signing secret).",
      docHref: null,
      command: null,
    },
    {
      id: "vendor-sendgrid",
      tab: "optional",
      group: "Email",
      title: "SendGrid",
      description:
        "Outbound email — receipts, reminders, review requests, password resets.",
      status: "complete",
      detail: "Configured.",
      docHref: null,
      command: null,
    },
    {
      id: "vendor-anthropic",
      tab: "optional",
      group: "AI",
      title: "Anthropic (Claude)",
      description:
        "Preferred text-LLM provider — storefront chatbot, sleep coach, SMS classifier.",
      status: "complete",
      detail: "Configured.",
      docHref: null,
      command: null,
    },
    {
      id: "vendor-twilio-sms",
      tab: "optional",
      group: "Messaging",
      title: "Twilio SMS",
      description: "Outbound + inbound resupply SMS and MMS attachments.",
      status: "incomplete",
      detail:
        "Not set up — set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_MESSAGING_SERVICE_SID.",
      docHref: null,
      command: null,
    },
    {
      id: "vendor-office-ally",
      tab: "optional",
      group: "Billing & claims",
      title: "Office Ally clearinghouse",
      description: "837P claim submission over SFTP.",
      status: "incomplete",
      detail:
        "Not set up — set the OFFICE_ALLY_* SFTP + billing-identity vars (or OFFICE_ALLY_STUB=1).",
      docHref: null,
      command: null,
    },
  ];
  return {
    generatedAt: NOW_ISO(),
    environment: "production",
    items,
  };
}

// ── Agent availability (agent-availability.ts) ────────────────────────
// GET   /resupply-api/admin/agent-availability        → { agents: [...] }
// GET   /resupply-api/admin/agent-availability/me      → { adminUserId, ... }
// PUT   /resupply-api/admin/agent-availability/me/phone → { adminUserId, ... }
// PATCH /resupply-api/admin/agent-availability/me       → { adminUserId, availability }
function agentAvailabilityBoard() {
  return {
    agents: [
      {
        adminUserId: "demo-user-rt-1",
        email: "avery.rt@pennpaps.com",
        displayName: "Avery Sample, RT",
        role: "agent",
        availability: "available",
      },
      {
        adminUserId: "demo-user-rt-2",
        email: "jordan.rt@pennpaps.com",
        displayName: "Jordan Quinn, RT",
        role: "agent",
        availability: "away",
      },
      {
        adminUserId: "demo-user-csr-1",
        email: "demo.csr@pennpaps.com",
        displayName: "Demo CSR",
        role: "agent",
        availability: "do_not_assign",
      },
      {
        adminUserId: "demo-user-admin-1",
        email: "owner@pennpaps.com",
        displayName: "Demo Owner",
        role: "admin",
        availability: "available",
      },
    ],
  };
}

// ── Tenant agreements (agreements.ts) ─────────────────────────────────
// GET  /resupply-api/admin/agreements        → { agreements: AgreementStatus[] }
// POST /resupply-api/admin/agreements/accept → { ok, pending, allSigned }
function agreementStatus() {
  return {
    agreements: [
      {
        type: "platform_terms",
        version: "2026-06-16",
        title: "CareMetric Breathe Master Services Agreement",
        body: "MASTER SERVICES AGREEMENT / TERMS OF SERVICE\n\nThese terms govern your organization's access to and use of the CareMetric Breathe platform. (Demo copy — not legal advice.)",
        accepted: true,
        acceptedAt: daysAgo(40),
      },
      {
        type: "baa",
        version: "2026-06-16",
        title: "HIPAA Business Associate Agreement",
        body: "BUSINESS ASSOCIATE AGREEMENT\n\nThis BAA supplements the Master Services Agreement and governs the handling of Protected Health Information under HIPAA. (Demo copy — not legal advice.)",
        accepted: true,
        acceptedAt: daysAgo(40),
      },
    ],
  };
}

// ── Per-patient alert message overrides (alert-message-overrides.ts) ──
// POST /resupply-api/admin/patients/alert-message-overrides/list
//   → { overrides: OverrideView[] }
// POST /resupply-api/admin/patients/:patientId/alert-message-overrides
//   → { override }
// PATCH/DELETE …/:id → { override }
function alertMessageOverrides() {
  return {
    overrides: [
      {
        id: "demo-amo-0001",
        patientId: "demo-p-2004",
        alertKey: "resupply_due",
        channel: "sms",
        subject: null,
        bodyHtml: null,
        bodyText:
          "Hi {{first_name}}, your CPAP supplies are due. Reply YES to ship. - Penn Home Medical Supply",
        isActive: true,
        note: "Patient prefers a shorter, plainer SMS than the default.",
        createdAt: daysAgo(20),
        createdBy: "demo-user-csr-1",
        updatedAt: daysAgo(20),
        updatedBy: "demo-user-csr-1",
      },
      {
        id: "demo-amo-0002",
        patientId: "demo-p-2004",
        alertKey: "high_leak",
        channel: "email",
        subject: "Let's fine-tune your mask fit, {{first_name}}",
        bodyHtml:
          "<p>Hi {{first_name}}, we noticed some mask leak overnight. Let's get you refit.</p>",
        bodyText:
          "Hi {{first_name}}, we noticed some mask leak overnight. Let's get you refit.",
        isActive: true,
        note: "Custom refit invite for a leak-prone patient.",
        createdAt: daysAgo(12),
        createdBy: "demo-user-rt-1",
        updatedAt: daysAgo(5),
        updatedBy: "demo-user-rt-1",
      },
    ],
  };
}

function alertOverrideEcho(
  patientId: string,
  body: {
    alertKey?: string;
    channel?: string;
    subject?: string | null;
    bodyHtml?: string | null;
    bodyText?: string | null;
    isActive?: boolean;
    note?: string;
  },
) {
  return {
    override: {
      id: "demo-amo-00ff",
      patientId,
      alertKey: body.alertKey ?? "resupply_due",
      channel: body.channel ?? "sms",
      subject: body.subject ?? null,
      bodyHtml: body.bodyHtml ?? null,
      bodyText: body.bodyText ?? null,
      isActive: body.isActive ?? true,
      note: body.note ?? "Demo override.",
      createdAt: NOW_ISO(),
      createdBy: "demo-user-csr-1",
      updatedAt: NOW_ISO(),
      updatedBy: "demo-user-csr-1",
    },
  };
}

// ── Asset-recovery worklist (asset-recovery.ts) ───────────────────────
// GET   /resupply-api/admin/asset-recovery        → { cases: CaseDto[], counts }
// POST  /resupply-api/admin/asset-recovery        → { case }
// PATCH /resupply-api/admin/asset-recovery/:id     → { case }
type AssetCaseDto = {
  id: string;
  patientId: string | null;
  patientLabel: string | null;
  deviceLabel: string | null;
  deviceSerial: string | null;
  status: string;
  reason: string;
  trackingNumber: string | null;
  returnLabelUrl: string | null;
  notes: string | null;
  createdByEmail: string | null;
  updatedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

const ASSET_RECOVERY_CASES: AssetCaseDto[] = [
  {
    id: "demo-ar-0001",
    patientId: "demo-p-3008",
    patientLabel: "Jordan Quinn",
    deviceLabel: "ResMed AirSense 11",
    deviceSerial: "DEMO-SN-110045",
    status: "identified",
    reason: "discontinued",
    trackingNumber: null,
    returnLabelUrl: null,
    notes: "No data in 21 days; left two voicemails.",
    createdByEmail: "demo.csr@pennpaps.com",
    updatedByEmail: "demo.csr@pennpaps.com",
    createdAt: daysAgo(8),
    updatedAt: daysAgo(2),
  },
  {
    id: "demo-ar-0002",
    patientId: "demo-p-2003",
    patientLabel: "Demo Patient",
    deviceLabel: "Philips DreamStation 2",
    deviceSerial: "DEMO-SN-220117",
    status: "label_sent",
    reason: "non_compliant",
    trackingNumber: "DEMO1Z999AA10123456784",
    returnLabelUrl: null,
    notes: "Return label emailed; awaiting drop-off.",
    createdByEmail: "demo.csr@pennpaps.com",
    updatedByEmail: "demo.csr@pennpaps.com",
    createdAt: daysAgo(15),
    updatedAt: daysAgo(3),
  },
  {
    id: "demo-ar-0003",
    patientId: null,
    patientLabel: "Avery Sample",
    deviceLabel: "ResMed AirCurve 10",
    deviceSerial: "DEMO-SN-100992",
    status: "received",
    reason: "upgraded",
    trackingNumber: "DEMO1Z999AA10987654321",
    returnLabelUrl: null,
    notes: "Device back in warehouse; queued for refurb.",
    createdByEmail: "demo.rt@pennpaps.com",
    updatedByEmail: "demo.rt@pennpaps.com",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(6),
  },
];

function assetRecoveryList(status?: string) {
  const cases = status
    ? ASSET_RECOVERY_CASES.filter((c) => c.status === status)
    : ASSET_RECOVERY_CASES;
  const counts: Record<string, number> = {};
  for (const c of ASSET_RECOVERY_CASES) {
    counts[c.status] = (counts[c.status] ?? 0) + 1;
  }
  return { cases, counts };
}

// ── Billing dashboard (billing-dashboard.ts) ──────────────────────────
// GET /resupply-api/admin/billing/dashboard
function billingDashboard() {
  const draftClaims = [
    {
      id: "demo-claim-0001",
      patientId: "demo-p-2004",
      payerName: "Demo Health Plan",
      totalBilledCents: 18250,
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
    },
    {
      id: "demo-claim-0002",
      patientId: "demo-p-2005",
      payerName: "Demo Medicaid MCO",
      totalBilledCents: 9400,
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
    },
  ];
  const deniedClaims = [
    {
      id: "demo-claim-0010",
      patientId: "demo-p-2003",
      payerName: "Demo Advantage",
      totalBilledCents: 12600,
      denialReason: "CO-16: Missing/incomplete documentation",
      decisionAt: daysAgo(4),
    },
  ];
  const submittedNoAck = [
    {
      id: "demo-claim-0020",
      patientId: "demo-p-2006",
      payerName: "Demo PPO",
      totalBilledCents: 21000,
      submittedAt: daysAgo(3),
      officeAllySubmissionId: "demo-oa-sub-7781",
    },
  ];
  const unmatchedEras = [
    {
      id: "demo-era-0001",
      fileName: "DEMO_ERA_835_20260615.txt",
      claimsPaid: 8,
      claimsDenied: 1,
      rejectionReason: null,
      ingestedAt: daysAgo(5),
    },
  ];
  const fulfillmentsToBill = [
    {
      id: "demo-ful-0001",
      patientId: "demo-p-2004",
      itemSku: "RESUP-CUSHION-N20-M",
      quantity: 1,
      shippedAt: daysAgo(2),
    },
    {
      id: "demo-ful-0002",
      patientId: "demo-p-2005",
      itemSku: "RESUP-FILTER-AS11",
      quantity: 2,
      shippedAt: daysAgo(4),
    },
  ];
  const sum = (rows: Array<{ totalBilledCents: number }>) =>
    rows.reduce((s, r) => s + r.totalBilledCents, 0);
  return {
    draftClaims,
    deniedClaims,
    submittedNoAck,
    unmatchedEras,
    fulfillmentsToBill,
    counts: {
      draftStale: draftClaims.length,
      denied: deniedClaims.length,
      submittedNoAck: submittedNoAck.length,
      partialEras: unmatchedEras.length,
      fulfillmentsToBill: fulfillmentsToBill.length,
    },
    dollars: {
      draftStaleBilledCents: sum(draftClaims),
      deniedBilledCents: sum(deniedClaims),
      submittedStuckBilledCents: sum(submittedNoAck),
    },
    thresholds: {
      draftStaleHours: 24,
      submittedStuckHours: 48,
      recentDenialDays: 14,
      fulfillmentToBillDays: 7,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── Batch create claims (billing-batch-create-claims.ts) ──────────────
// POST /resupply-api/admin/billing/fulfillments/batch-create-claims
//   → { summary, results }
function batchCreateClaims(fulfillmentIds: string[]) {
  const ids = Array.from(new Set(fulfillmentIds));
  const results = ids.map((fulfillmentId, i) => {
    // Make the demo output realistic: most create, one already billed.
    if (i === 1) {
      return {
        fulfillmentId,
        status: "claim_exists" as const,
        claimId: "demo-claim-existing",
        existingStatus: "submitted",
      };
    }
    return {
      fulfillmentId,
      status: "created" as const,
      claimId: `demo-claim-new-${i + 1}`,
      lineCount: 1,
    };
  });
  return {
    summary: {
      requested: ids.length,
      created: results.filter((r) => r.status === "created").length,
      claimExists: results.filter((r) => r.status === "claim_exists").length,
      notFound: 0,
      errored: 0,
    },
    results,
  };
}

// ── Batch submit Office Ally (billing-batch-submit.ts) ────────────────
// POST /resupply-api/admin/billing/batch-submit-office-ally → 201 { ok, ... }
function batchSubmitOfficeAlly(claimIds: string[]) {
  const count = Math.max(1, claimIds.length);
  return {
    ok: true,
    submissionId: "demo-oa-sub-90021",
    claimCount: count,
    isaControlNumber: "000000123",
    gsControlNumber: "123",
    fileSizeBytes: 4096 + count * 512,
    transport: "stub" as const,
    uploadError: null,
  };
}

function strArr(
  body: { fulfillmentIds?: unknown; claimIds?: unknown } | undefined,
  key: "fulfillmentIds" | "claimIds",
): string[] {
  const raw = body?.[key];
  return Array.isArray(raw)
    ? (raw.filter((x) => typeof x === "string") as string[])
    : [];
}

export const ext0Handlers: DemoHandler[] = [
  // ── Abandoned carts ─────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/shop/abandoned-carts", () =>
    json(abandonedCartRows()),
  ),
  route("POST", "/resupply-api/admin/shop/abandoned-carts/send-due", () =>
    json(cartAbandonmentSendDue()),
  ),

  // ── Account-setup launch checklist ──────────────────────────────────
  route("GET", "/resupply-api/platform/account-setup", () =>
    json(accountSetupChecklist()),
  ),

  // ── Agent availability ──────────────────────────────────────────────
  route("GET", "/resupply-api/admin/agent-availability", () =>
    json(agentAvailabilityBoard()),
  ),
  route("GET", "/resupply-api/admin/agent-availability/me", () =>
    json({
      adminUserId: "demo-user-admin-1",
      availability: "available",
      phoneLast4: "0142",
      hasPhone: true,
    }),
  ),
  route("PUT", "/resupply-api/admin/agent-availability/me/phone", (req) => {
    const body = req.json<{ phoneE164?: string }>();
    const phone = body?.phoneE164 ?? "";
    return json({
      adminUserId: "demo-user-admin-1",
      hasPhone: phone !== "",
      phoneLast4: phone !== "" ? phone.slice(-4) : null,
    });
  }),
  route("PATCH", "/resupply-api/admin/agent-availability/me", (req) => {
    const body = req.json<{ availability?: string }>();
    return json({
      adminUserId: "demo-user-admin-1",
      availability: body?.availability ?? "available",
    });
  }),

  // ── Tenant agreements ───────────────────────────────────────────────
  route("GET", "/resupply-api/admin/agreements", () => json(agreementStatus())),
  route("POST", "/resupply-api/admin/agreements/accept", () =>
    json({ ok: true, pending: [], allSigned: true }),
  ),

  // ── Per-patient alert message overrides ─────────────────────────────
  route(
    "POST",
    "/resupply-api/admin/patients/alert-message-overrides/list",
    () => json(alertMessageOverrides()),
  ),
  route(
    "POST",
    "/resupply-api/admin/patients/:patientId/alert-message-overrides",
    (req, params) =>
      json(alertOverrideEcho(params.patientId, req.json() ?? {}), 201),
  ),
  route(
    "PATCH",
    "/resupply-api/admin/patients/:patientId/alert-message-overrides/:id",
    (req, params) =>
      json(alertOverrideEcho(params.patientId, req.json() ?? {})),
  ),
  route(
    "DELETE",
    "/resupply-api/admin/patients/:patientId/alert-message-overrides/:id",
    (_req, params) =>
      json(alertOverrideEcho(params.patientId, { isActive: false })),
  ),

  // ── Asset-recovery worklist ─────────────────────────────────────────
  route("GET", "/resupply-api/admin/asset-recovery", (req) =>
    json(assetRecoveryList(req.query.get("status") ?? undefined)),
  ),
  route("POST", "/resupply-api/admin/asset-recovery", (req) => {
    const body = req.json<{
      patientId?: string;
      patientLabel?: string;
      deviceLabel?: string;
      deviceSerial?: string;
      reason?: string;
      notes?: string;
    }>();
    return json(
      {
        case: {
          id: "demo-ar-00ff",
          patientId: body?.patientId ?? null,
          patientLabel: body?.patientLabel ?? "Demo Patient",
          deviceLabel: body?.deviceLabel ?? null,
          deviceSerial: body?.deviceSerial ?? null,
          status: "identified",
          reason: body?.reason ?? "discontinued",
          trackingNumber: null,
          returnLabelUrl: null,
          notes: body?.notes ?? null,
          createdByEmail: "demo.csr@pennpaps.com",
          updatedByEmail: "demo.csr@pennpaps.com",
          createdAt: NOW_ISO(),
          updatedAt: NOW_ISO(),
        },
      },
      201,
    );
  }),
  route("PATCH", "/resupply-api/admin/asset-recovery/:id", (req, params) => {
    const body = req.json<Record<string, unknown>>() ?? {};
    const base =
      ASSET_RECOVERY_CASES.find((c) => c.id === params.id) ??
      ASSET_RECOVERY_CASES[0]!;
    return json({
      case: {
        ...base,
        id: params.id,
        status: (body.status as string) ?? base.status,
        reason: (body.reason as string) ?? base.reason,
        deviceLabel: (body.deviceLabel as string) ?? base.deviceLabel,
        deviceSerial: (body.deviceSerial as string) ?? base.deviceSerial,
        trackingNumber: (body.trackingNumber as string) ?? base.trackingNumber,
        returnLabelUrl: (body.returnLabelUrl as string) ?? base.returnLabelUrl,
        notes: (body.notes as string) ?? base.notes,
        updatedByEmail: "demo.csr@pennpaps.com",
        updatedAt: NOW_ISO(),
      },
    });
  }),

  // ── Billing dashboard ───────────────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/dashboard", () =>
    json(billingDashboard()),
  ),

  // ── Batch create claims ─────────────────────────────────────────────
  route(
    "POST",
    "/resupply-api/admin/billing/fulfillments/batch-create-claims",
    (req) => {
      const ids = strArr(
        req.json<{ fulfillmentIds?: unknown }>(),
        "fulfillmentIds",
      );
      const useIds = ids.length > 0 ? ids : ["demo-ful-0001", "demo-ful-0002"];
      return json(batchCreateClaims(useIds));
    },
  ),

  // ── Batch submit Office Ally ────────────────────────────────────────
  route(
    "POST",
    "/resupply-api/admin/billing/batch-submit-office-ally",
    (req) => {
      const ids = strArr(req.json<{ claimIds?: unknown }>(), "claimIds");
      const useIds = ids.length > 0 ? ids : ["demo-claim-0001"];
      return json(batchSubmitOfficeAlly(useIds), 201);
    },
  ),
];
