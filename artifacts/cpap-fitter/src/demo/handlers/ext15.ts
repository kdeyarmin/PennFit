// Extended demo coverage (ext15): conversation, episode, and
// provider-portal endpoints not already seeded by handlers/admin.ts.
//
// admin.ts already seeds these and they are SKIPPED here:
//   GET /resupply-api/conversations            (list)
//   GET /resupply-api/conversations/:id        (detail)
//   GET /resupply-api/episodes                 (list)
//   GET /resupply-api/dashboard/summary
//   GET /resupply-api/admin/today, /work-items
//
// This module seeds the OTHER endpoints on those surfaces:
//   * conversation assignment / priority / escalation / status mutations
//   * conversation reply (SMS/email/in-app append) mutation
//   * episodes bulk-send mutation + episodes/counts read
//   * the referring-provider PORTAL surface (a distinct cookie-auth
//     surface the cpap-fitter SPA renders under /provider/*): provider
//     identity, document-signing queue, MFA status, and RTM ("my
//     patients") roster + detail reads, plus benign-success signing
//     mutations and the provider auth client endpoints.
//
// SKIPPED (binary / stream): the conversation attachment download
//   GET /conversations/:id/messages/:mid/attachments/:aid — it streams
//   object-storage bytes; there is nothing meaningful to fixture.
//
// All data is fictional demo data — no real PHI. Tenant is CareMetric
// Demo DME (demo.example); the platform is CareMetric Breathe.
// Provider NPIs are fake (1-prefixed, the NPI numbering convention).

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  daysAgo,
  daysFromNow,
  hoursAgo,
  dateOnly,
  NOW_ISO,
} from "../fixtures/dates";

// ── helpers ─────────────────────────────────────────────────────────

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
): number {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// A demo conversation-reply id is synthesized so the dashboard's
// optimistic timeline append has a stable key to render against.
function demoReplyId(conversationId: string): string {
  return `${conversationId}-msg-reply-${Date.now()}`;
}

// ── episodes/counts ─────────────────────────────────────────────────
// GET /resupply-api/episodes/counts — per-status strip on the Episodes
// page. Mirrors the live route's flat record shape exactly. The numbers
// are internally consistent (overdue ⊆ outreach_pending+awaiting_response
// and `all` is the sum of the seven status buckets), so the dispatcher
// strip and the seeded list (9 rows in admin.ts) read coherently.
function demoEpisodeCounts() {
  const outreach_pending = 2;
  const awaiting_response = 3;
  const confirmed = 2;
  const declined = 0;
  const expired = 1;
  const fulfilled = 1;
  const canceled = 0;
  const all =
    outreach_pending +
    awaiting_response +
    confirmed +
    declined +
    expired +
    fulfilled +
    canceled;
  return {
    overdue: 2,
    outreach_pending,
    awaiting_response,
    confirmed,
    declined,
    expired,
    fulfilled,
    canceled,
    all,
  };
}

// ── provider portal: identity ───────────────────────────────────────
// GET /api/provider/me — the gate the SPA's ProviderPortalRoute runs.
// `mfaEnrolled: true` so the demo lands on the queue (not the mandatory
// MFA-setup redirect). Fake 1-prefixed NPI; CareMetric Demo DME
// practice name.
const DEMO_PROVIDER = {
  accountId: "demo-prov-acct-1",
  email: "dr.demo@providers.example",
  providerId: "demo-prov-1",
  npi: "1457382906",
  legalName: "Dr. Demo Prescriber, MD",
  practiceName: "CareMetric Demo DME",
};

function demoProviderMe() {
  return {
    account: {
      id: DEMO_PROVIDER.accountId,
      email: DEMO_PROVIDER.email,
      status: "active" as const,
      mfaEnrolled: true,
    },
    provider: {
      id: DEMO_PROVIDER.providerId,
      npi: DEMO_PROVIDER.npi,
      legalName: DEMO_PROVIDER.legalName,
      practiceName: DEMO_PROVIDER.practiceName,
    },
    pendingCount: 2,
  };
}

// ── provider portal: e-signature queue ──────────────────────────────
type ProviderQueueStatus = "pending" | "signed" | "declined";

interface ProviderQueueRow {
  id: string;
  subjectType: string;
  subjectLabel: string;
  subjectId: string | null;
  title: string;
  patientName: string | null;
  detail: Record<string, unknown>;
  status: ProviderQueueStatus;
  createdAt: string;
  expiresAt: string | null;
  signedAt: string | null;
}

const SUBJECT_LABELS: Record<string, string> = {
  swo: "Standard Written Order",
  dwo: "Detailed Written Order",
  cmn: "Certificate of Medical Necessity",
  prescription_packet: "Prescription request",
};

function providerQueueRow(i: number): ProviderQueueRow {
  const subjects = ["swo", "prescription_packet", "dwo", "cmn"];
  const patients = [
    "Jordan Sample",
    "Casey Demo",
    "Morgan Example",
    "Riley Tester",
    "Avery Placeholder",
  ];
  const statuses: ProviderQueueStatus[] = [
    "pending",
    "pending",
    "signed",
    "declined",
    "pending",
  ];
  const status = statuses[i % statuses.length]!;
  const subjectType = subjects[i % subjects.length]!;
  return {
    id: `demo-sigreq-${i + 1}`,
    subjectType,
    subjectLabel: SUBJECT_LABELS[subjectType] ?? subjectType,
    subjectId: `demo-rx-${i + 1}`,
    title: `${SUBJECT_LABELS[subjectType] ?? subjectType} — CPAP resupply`,
    patientName: patients[i % patients.length]!,
    detail: {
      itemSku: "A7034",
      hcpcsCode: "A7034",
      description: "Nasal CPAP mask + headgear, 90-day resupply",
    },
    status,
    createdAt: daysAgo(i + 1),
    expiresAt: daysFromNow(30 - i),
    signedAt: status === "signed" ? daysAgo(i) : null,
  };
}

const DEMO_PROVIDER_QUEUE_COUNT = 5;

function demoProviderQueue(statusFilter: string) {
  const all = Array.from({ length: DEMO_PROVIDER_QUEUE_COUNT }, (_, i) =>
    providerQueueRow(i),
  );
  const requests =
    statusFilter === "all" ? all : all.filter((r) => r.status === statusFilter);
  return { requests };
}

function demoProviderQueueItem(id: string) {
  const m = /^demo-sigreq-(\d+)$/.exec(id);
  const i = m
    ? (Number.parseInt(m[1]!, 10) - 1) % DEMO_PROVIDER_QUEUE_COUNT
    : 0;
  const row = providerQueueRow(Math.max(0, i));
  return {
    ...row,
    id,
    signerName: row.status === "signed" ? DEMO_PROVIDER.legalName : null,
    declineReason:
      row.status === "declined" ? "Patient no longer under my care." : null,
  };
}

// ── provider portal: MFA status ─────────────────────────────────────
function demoProviderMfaStatus() {
  return {
    enrolled: true,
    inProgressEnrollment: false,
    verifiedAt: daysAgo(40),
    lastUsedAt: hoursAgo(3),
    recoveryCodesRemaining: 8,
    mustEnroll: false,
  };
}

// ── provider portal: RTM ("my patients") ────────────────────────────
function rtmRosterPatient(i: number) {
  const names = [
    "Sample, Jordan",
    "Demo, Casey",
    "Example, Morgan",
    "Tester, Riley",
    "Placeholder, Avery",
  ];
  const stale = i % 3 === 0 ? i + 1 : 0;
  const complianceRatePct = 92 - i * 7;
  return {
    patientId: `demo-patient-${i + 1}`,
    patientName: names[i % names.length]!,
    status: "active",
    setupDate: dateOnly(-(120 + i * 10)),
    hasData: true,
    lastNightDate: dateOnly(-(1 + stale)),
    staleDays: stale,
    avgUsageHours: Number((6.4 - i * 0.4).toFixed(1)),
    compliantNights: 24 - i,
    nightsWithData: 28 - i,
    complianceRatePct,
    cmsCompliant: complianceRatePct >= 70,
  };
}

function demoRtmRoster(days: number) {
  const patients = Array.from({ length: 5 }, (_, i) => rtmRosterPatient(i));
  return { windowDays: days, patients };
}

function demoRtmPatientDetail(id: string, days: number) {
  const n = Number.parseInt(id.replace(/\D/g, ""), 10) || 1;
  const i = n - 1;
  const avgUsageHours = Number((6.4 - (i % 5) * 0.4).toFixed(1));
  const complianceRatePct = Math.max(40, 92 - (i % 5) * 7);
  return {
    patientId: id,
    patientName: rtmRosterPatient(i % 5).patientName,
    setupDate: dateOnly(-(120 + i * 10)),
    snapshot: {
      hasData: true,
      windowDays: days,
      nightsWithData: 28,
      windowStartDate: dateOnly(-days),
      windowEndDate: dateOnly(0),
      lastNightDate: dateOnly(-1),
      staleDays: 1,
      avgUsageHours,
      avgAhi: 3.2,
      avgLeakLMin: 18.5,
      compliantNights: 24,
      complianceRatePct,
    },
    cms: {
      qualifies: complianceRatePct >= 70,
      horizonComplete: true,
      window: {
        startDate: dateOnly(-90),
        endDate: dateOnly(-1),
        compliantNights: 24,
        ratioPct: complianceRatePct,
        averageUsageHours: avgUsageHours,
      },
    },
  };
}

// Provider auth-client surface (lib/provider/provider-auth.ts binds the
// in-house auth client to /api/provider/auth). The SPA's sign-out hook
// and CSRF priming hit these; mirror the storefront/admin auth stubs.
function providerAuthMutations(base: string): DemoHandler[] {
  const ok = () => json({ ok: true });
  return [
    route("GET", `${base}/csrf`, () => ok()),
    route("POST", `${base}/sign-in`, () => ok()),
    route("POST", `${base}/sign-in/verify-mfa`, () => ok()),
    route("POST", `${base}/sign-out`, () => ok()),
    route("POST", `${base}/forgot-password`, () => ok()),
    route("POST", `${base}/reset-password`, () => ok()),
    route("POST", `${base}/verify-email`, () => ok()),
    route("POST", `${base}/change-password`, () => ok()),
  ];
}

export const ext15Handlers: DemoHandler[] = [
  // ── conversations: assignment / priority / escalation / status ────
  // All return the live route's benign-success envelopes so the inbox
  // mutations (claim, assign, set priority, escalate, close/reopen)
  // resolve cleanly. slaDueAt is fresh so the SLA chip renders.
  route("POST", "/resupply-api/conversations/:id/claim", () =>
    json({
      ok: true,
      assignedTo: "demo-admin-1",
      slaDueAt: daysFromNow(0).replace(/\.\d+Z$/, "Z"),
    }),
  ),
  route("POST", "/resupply-api/conversations/:id/release", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/conversations/:id/assign", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/conversations/:id/priority", () =>
    json({ ok: true, slaDueAt: daysFromNow(0).replace(/\.\d+Z$/, "Z") }),
  ),
  route("POST", "/resupply-api/conversations/:id/escalate", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/conversations/:id/de-escalate", () =>
    json({ ok: true }),
  ),
  route("POST", "/resupply-api/conversations/:id/status", (req) => {
    const body = req.json<{ status?: string }>() ?? {};
    return json({
      ok: true,
      status: body.status ?? "closed",
      changed: true,
    });
  }),

  // ── conversations: reply (append to the open thread) ──────────────
  // The composer expects a 201 with { messageId, conversationId,
  // vendorRef } across all channels (SMS/email return a vendorRef; the
  // in-app path returns null). Demo always succeeds.
  route("POST", "/resupply-api/conversations/:id/reply", (_req, { id }) =>
    json(
      {
        messageId: demoReplyId(id),
        conversationId: id,
        vendorRef: `demo-vendor-${Date.now()}`,
      },
      201,
    ),
  ),

  // ── episodes: per-status counts strip ─────────────────────────────
  route("GET", "/resupply-api/episodes/counts", () =>
    json(demoEpisodeCounts()),
  ),

  // ── episodes: bulk reminder send ──────────────────────────────────
  // 200 with the { summary, results[] } shape the dispatcher reads for
  // its "N sent / M failed" toast. Every selected episode succeeds in
  // the demo (nothing actually goes out).
  route("POST", "/resupply-api/episodes/bulk-send", (req) => {
    const body =
      req.json<{ episodeIds?: string[]; channel?: "sms" | "email" }>() ?? {};
    const ids = Array.from(new Set(body.episodeIds ?? []));
    const results = ids.map((episodeId) => ({
      episodeId,
      status: "ok" as const,
      conversationId: `demo-conv-${episodeId}`,
      vendorRef: `demo-vendor-${Date.now()}`,
    }));
    return json({
      summary: { total: results.length, sent: results.length, failed: 0 },
      results,
    });
  }),

  // ── provider portal: identity / queue / MFA / RTM (reads) ─────────
  route("GET", "/api/provider/me", () => json(demoProviderMe())),
  route("GET", "/api/provider/queue", (req) =>
    json(demoProviderQueue(req.query.get("status") ?? "pending")),
  ),
  // sign-batch is a static sibling under /queue; declare it before the
  // :id matcher so it is not shadowed by /queue/:id.
  route("POST", "/api/provider/queue/sign-batch", (req) => {
    const body = req.json<{ ids?: string[] }>() ?? {};
    const signed = Array.from(new Set(body.ids ?? []));
    return json({ ok: true, signed, skipped: [] });
  }),
  route("GET", "/api/provider/queue/:id", (_req, { id }) =>
    json(demoProviderQueueItem(id)),
  ),
  route("POST", "/api/provider/queue/:id/sign", () =>
    json({ ok: true, status: "signed", signedAt: NOW_ISO() }),
  ),
  route("POST", "/api/provider/queue/:id/decline", () =>
    json({ ok: true, status: "declined" }),
  ),
  route("GET", "/api/provider/mfa/status", () => json(demoProviderMfaStatus())),
  // RTM roster + detail. :id is a single segment, so /patients (no id)
  // is declared first and never shadowed.
  route("GET", "/api/provider/patients", (req) =>
    json(demoRtmRoster(intParam(req, "days", 30))),
  ),
  route("GET", "/api/provider/patients/:id", (req, { id }) =>
    json(demoRtmPatientDetail(id, intParam(req, "days", 30))),
  ),

  // ── provider auth client (/api/provider/auth/*) ───────────────────
  // The SPA's provider auth hooks (sign-out, CSRF) bind to this base.
  // The /me data gate above (/api/provider/me) is what actually decides
  // access; these are the session-mutation stubs.
  route("GET", "/api/provider/auth/me", () => json(demoProviderMe())),
  ...providerAuthMutations("/api/provider/auth"),

  // ── token-gated public provider portal (/provider-portal/:token) ──
  // The legacy read-only caseload view a CSR-minted link opens. Fake
  // provider + a short caseload of fictional patients.
  route("GET", "/provider-portal/:token", () =>
    json({
      provider: {
        id: DEMO_PROVIDER.providerId,
        npi: DEMO_PROVIDER.npi,
        legalName: DEMO_PROVIDER.legalName,
        practiceName: DEMO_PROVIDER.practiceName,
        taxonomyCode: "207RC0000X",
      },
      prescriptions: [
        {
          id: "demo-rx-1",
          itemSku: "A7034",
          hcpcsCode: "A7034",
          status: "active",
          validFrom: daysAgo(120),
          validUntil: daysFromNow(240),
          patientName: "Jordan Sample",
        },
        {
          id: "demo-rx-2",
          itemSku: "A7035",
          hcpcsCode: "A7035",
          status: "active",
          validFrom: daysAgo(90),
          validUntil: daysFromNow(270),
          patientName: "Casey Demo",
        },
      ],
    }),
  ),
];
