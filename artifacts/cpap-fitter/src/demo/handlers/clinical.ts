// Clinical / respiratory-therapist worklist handlers for the demo
// sandbox. The fetch interceptor's empty `{}` fallback makes these
// admin pages crash (they read nested fields / map over arrays without
// optional chaining), so each route below returns fully-shaped sample
// data matching the live API response (see the corresponding
// artifacts/resupply-api/src/routes/admin/*.ts route file).
//
// DATA RULES: everything here is fictional demo data — obviously-fake
// patient names ("Demo Patient", "Avery Sample"), demo ids, fresh
// relative dates. Realistic-but-synthetic clinical values (AHI, usage
// hours, mask-fit notes). NO real PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, daysFromNow, dateOnly, NOW_ISO } from "../fixtures/dates";

// ── Mask-fit worklist (mask-fit-worklist.ts) ──────────────────────────
// GET /resupply-api/admin/clinical/mask-fit/worklist
//   { items: MaskFitWorkItem[], count, counts: { uncomfortable, leaking } }
const MASK_FIT_ITEMS = [
  {
    id: "demo-mf-0001-0000-0000-0000-000000000001",
    order_id: "demo-order-7001",
    fit_outcome: "uncomfortable" as const,
    comment: "Forehead pad digging in; pressure points after 1 hr",
    status: "new" as const,
    created_at: daysAgo(1),
    patientId: "demo-p-2004",
  },
  {
    id: "demo-mf-0001-0000-0000-0000-000000000002",
    order_id: "demo-order-7002",
    fit_outcome: "leaking" as const,
    comment: "Top-of-mask leak waking patient; cushion may be too large",
    status: "new" as const,
    created_at: daysAgo(2),
    patientId: "demo-p-2001",
  },
  {
    id: "demo-mf-0001-0000-0000-0000-000000000003",
    order_id: "demo-order-7003",
    fit_outcome: "leaking" as const,
    comment: "Side leak when turning; trying a different headgear tension",
    status: "reviewed" as const,
    created_at: daysAgo(4),
    patientId: "demo-p-2006",
  },
  {
    id: "demo-mf-0001-0000-0000-0000-000000000004",
    order_id: "demo-order-7004",
    fit_outcome: "uncomfortable" as const,
    comment: "Claustrophobic with full-face; wants nasal-pillow swap",
    status: "new" as const,
    created_at: daysAgo(6),
    patientId: null,
  },
];

// ── Clinical encounters (clinical-encounters.ts) ──────────────────────
// POST /resupply-api/admin/patients/clinical-encounters/query
//   { encounters: [...] }
function clinicalEncounters() {
  return {
    encounters: [
      {
        id: "demo-enc-0001",
        encounterType: "mask_fit",
        reason: "New setup mask fitting",
        assessment: "Good seal achieved with medium nasal cushion",
        intervention: "Demonstrated mask-on/mask-off and headgear adjustment",
        plan: "Follow up at day 7 to confirm comfort",
        followUpAt: daysFromNow(7),
        note: "Patient comfortable, no immediate concerns",
        linkedAlertId: null,
        linkedEpisodeId: null,
        authorEmail: "demo.rt@caremetric.example",
        createdAt: daysAgo(2),
      },
      {
        id: "demo-enc-0002",
        encounterType: "adherence_intervention",
        reason: "Usage dropped below 4h on 5 of last 7 nights",
        assessment: "Reports nasal congestion and dry mouth",
        intervention: "Added heated humidification, reviewed ramp comfort",
        plan: "Re-check usage in 14 days",
        followUpAt: daysFromNow(14),
        note: null,
        linkedAlertId: "demo-alert-3",
        linkedEpisodeId: null,
        authorEmail: "demo.rt@caremetric.example",
        createdAt: daysAgo(9),
      },
      {
        id: "demo-enc-0003",
        encounterType: "phone",
        reason: "Check-in call",
        assessment: null,
        intervention: "Reassured patient, answered cleaning questions",
        plan: null,
        followUpAt: null,
        note: "Patient doing well, no follow-up needed",
        linkedAlertId: null,
        linkedEpisodeId: null,
        authorEmail: "demo.csr@caremetric.example",
        createdAt: daysAgo(18),
      },
    ],
  };
}

// ── Interventions worklist (interventions.ts) ─────────────────────────
// GET /resupply-api/admin/clinical/interventions
//   { interventions: InterventionItem[], count, openCount }
const INTERVENTIONS = [
  {
    id: "demo-iv-0001",
    patientId: "demo-p-2004",
    assessmentCategory: "mask_leak",
    outcomeStatus: "pending",
    reason: "High leak trending up; usage falling",
    plan: "Refit to nasal pillows + headgear coaching",
    followUpAt: daysFromNow(-1),
    authorEmail: "demo.rt@caremetric.example",
    createdAt: daysAgo(10),
    open: true,
  },
  {
    id: "demo-iv-0002",
    patientId: "demo-p-3007",
    assessmentCategory: "pressure_intolerance",
    outcomeStatus: "pending",
    reason: "Patient finds pressure too strong on exhale",
    plan: "Enable EPR, lower ramp start pressure",
    followUpAt: daysFromNow(5),
    authorEmail: "demo.rt@caremetric.example",
    createdAt: daysAgo(6),
    open: true,
  },
  {
    id: "demo-iv-0003",
    patientId: "demo-p-2003",
    assessmentCategory: "motivation",
    outcomeStatus: "improved",
    reason: "Inconsistent nightly use, low engagement",
    plan: "Weekly coaching texts + adherence app setup",
    followUpAt: daysFromNow(-12),
    authorEmail: "demo.csr@caremetric.example",
    createdAt: daysAgo(30),
    open: false,
  },
];

// ── Setup checklist (setup-checklist.ts) ──────────────────────────────
// POST /resupply-api/admin/patients/setup-checklist/query  → { steps: [...] }
function setupChecklist() {
  const done = (note: string | null, ago: number) => ({
    status: "done" as const,
    note,
    completedByEmail: "demo.rt@caremetric.example",
    completedAt: daysAgo(ago),
    updatedAt: daysAgo(ago),
  });
  const pending = {
    status: "pending" as const,
    note: null,
    completedByEmail: null,
    completedAt: null,
    updatedAt: null,
  };
  const merge = (
    stepKey: string,
    label: string,
    rec: ReturnType<typeof done> | typeof pending,
  ) => ({ stepKey, label, ...rec });
  return {
    steps: [
      merge(
        "mask_fit_seal",
        "Mask fit + seal check",
        done("Medium nasal cushion, good seal", 2),
      ),
      merge("humidifier", "Humidifier set + filled", done(null, 2)),
      merge(
        "ramp",
        "Ramp / pressure comfort explained",
        done("Ramp 20 min, start 5 cmH2O", 2),
      ),
      merge("cleaning", "Cleaning + maintenance routine", pending),
      merge("data_app", "Companion app / data tracking set up", pending),
      merge("followup_scheduled", "First follow-up scheduled", pending),
    ],
  };
}

// ── RT outcomes (rt-outcomes.ts) ──────────────────────────────────────
// GET /resupply-api/admin/analytics/rt-outcomes
function rtOutcomes(windowDays: number) {
  const emptyByType = () => ({
    mask_fit: 0,
    troubleshoot: 0,
    setup_education: 0,
    adherence_intervention: 0,
    phone: 0,
    other: 0,
  });
  const rows = [
    {
      authorEmail: "demo.rt@caremetric.example",
      authorUserId: "demo-user-rt-1",
      encountersTotal: 42,
      patientsManaged: 31,
      followUpsCommitted: 18,
      interventions: 9,
      byType: {
        ...emptyByType(),
        mask_fit: 14,
        adherence_intervention: 9,
        setup_education: 11,
        phone: 6,
        troubleshoot: 2,
      },
      lastActiveAt: daysAgo(1),
    },
    {
      authorEmail: "demo.rt2@caremetric.example",
      authorUserId: "demo-user-rt-2",
      encountersTotal: 27,
      patientsManaged: 22,
      followUpsCommitted: 10,
      interventions: 5,
      byType: {
        ...emptyByType(),
        mask_fit: 8,
        adherence_intervention: 5,
        setup_education: 7,
        phone: 5,
        other: 2,
      },
      lastActiveAt: daysAgo(2),
    },
    {
      authorEmail: "demo.csr@caremetric.example",
      authorUserId: "demo-user-csr-1",
      encountersTotal: 15,
      patientsManaged: 14,
      followUpsCommitted: 4,
      interventions: 1,
      byType: {
        ...emptyByType(),
        phone: 9,
        troubleshoot: 4,
        adherence_intervention: 1,
        other: 1,
      },
      lastActiveAt: daysAgo(3),
    },
  ];
  return {
    windowDays,
    rows,
    totals: {
      encounters: rows.reduce((n, r) => n + r.encountersTotal, 0),
      rts: rows.length,
      patientsManaged: 58,
      followUpsCommitted: rows.reduce((n, r) => n + r.followUpsCommitted, 0),
      interventions: rows.reduce((n, r) => n + r.interventions, 0),
    },
  };
}

// ── RT overview (rt-overview.ts) ──────────────────────────────────────
// GET /resupply-api/admin/rt-overview
function rtOverview(days: number) {
  const rows = [
    {
      patientId: "demo-p-2004",
      pacwareId: "PW-10004",
      firstName: "Avery",
      lastName: "Sample",
      nightsInWindow: days >= 7 ? 6 : Math.min(days, 6),
      lastNightDate: dateOnly(-1),
      staleDays: 1,
      ahiAvg: 6.2,
      leakAvg: 38,
      usageMinutesAvg: 214,
      activeAlerts: [
        {
          id: "demo-ste-1",
          kind: "high_leak",
          label: "High leak",
          detectedAt: daysAgo(1),
        },
      ],
      therapyLinks: [
        {
          source: "resmed_airview",
          status: "active",
          lastSyncedAt: daysAgo(1),
          lastSyncStatus: "ok",
        },
      ],
    },
    {
      patientId: "demo-p-3007",
      pacwareId: "PW-13007",
      firstName: "Demo",
      lastName: "Patient",
      nightsInWindow: days >= 7 ? 5 : Math.min(days, 5),
      lastNightDate: dateOnly(-1),
      staleDays: 1,
      ahiAvg: 12.6,
      leakAvg: 19,
      usageMinutesAvg: 188,
      activeAlerts: [
        {
          id: "demo-ste-2",
          kind: "high_ahi",
          label: "High AHI",
          detectedAt: daysAgo(2),
        },
      ],
      therapyLinks: [
        {
          source: "philips_care_orchestrator",
          status: "active",
          lastSyncedAt: daysAgo(1),
          lastSyncStatus: "ok",
        },
      ],
    },
    {
      patientId: "demo-p-3008",
      pacwareId: "PW-13008",
      firstName: "Jordan",
      lastName: "Fixture",
      nightsInWindow: 0,
      lastNightDate: dateOnly(-21),
      staleDays: 21,
      ahiAvg: null,
      leakAvg: null,
      usageMinutesAvg: null,
      activeAlerts: [],
      therapyLinks: [
        {
          source: "react_health",
          status: "active",
          lastSyncedAt: daysAgo(21),
          lastSyncStatus: "stale",
        },
      ],
    },
    {
      patientId: "demo-p-2005",
      pacwareId: "PW-12005",
      firstName: "Quinn",
      lastName: "Mockton",
      nightsInWindow: days >= 7 ? 7 : days,
      lastNightDate: dateOnly(-1),
      staleDays: 1,
      ahiAvg: 3.0,
      leakAvg: 11,
      usageMinutesAvg: 392,
      activeAlerts: [],
      therapyLinks: [
        {
          source: "resmed_airview",
          status: "active",
          lastSyncedAt: daysAgo(1),
          lastSyncStatus: "ok",
        },
      ],
    },
  ];
  return {
    asOf: NOW_ISO(),
    windowDays: days,
    summary: { totalActive: 4, totalAlerting: 2, totalStale: 1 },
    rows,
  };
}

// ── Coaching plans (coaching-plans.ts) ────────────────────────────────
// GET /resupply-api/admin/coaching-plans → { plans: [...] }
function coachingPlans(showClosed: boolean) {
  const open = [
    {
      id: "demo-cp-0001-0000-0000-0000-000000000001",
      patientId: "demo-p-2004",
      sourceAlertId: "demo-alert-1",
      openedByUserId: "demo-user-rt-1",
      status: "open",
      targetCompliancePct: 70,
      latestCompliancePct: "48",
      targetDate: daysFromNow(21),
      latestOutreachAt: daysAgo(2),
      resolutionNote: null,
      openedAt: daysAgo(8),
      closedAt: null,
    },
    {
      id: "demo-cp-0001-0000-0000-0000-000000000002",
      patientId: "demo-p-3007",
      sourceAlertId: null,
      openedByUserId: "demo-user-rt-2",
      status: "outreach_made",
      targetCompliancePct: 70,
      latestCompliancePct: "55",
      targetDate: daysFromNow(30),
      latestOutreachAt: daysAgo(1),
      resolutionNote: null,
      openedAt: daysAgo(5),
      closedAt: null,
    },
  ];
  const closed = [
    {
      id: "demo-cp-0001-0000-0000-0000-000000000003",
      patientId: "demo-p-2003",
      sourceAlertId: null,
      openedByUserId: "demo-user-csr-1",
      status: "resolved",
      targetCompliancePct: 70,
      latestCompliancePct: "82",
      targetDate: daysAgo(10),
      latestOutreachAt: daysAgo(14),
      resolutionNote: "Patient back above CMS threshold; closed.",
      openedAt: daysAgo(45),
      closedAt: daysAgo(12),
    },
  ];
  return { plans: showClosed ? [...open, ...closed] : open };
}

// ── Clinical outreach eligible (clinical-outreach.ts) ──────────────────
// GET /resupply-api/admin/clinical/outreach/eligible → { eligible, count }
function clinicalOutreachEligible() {
  const eligible = [
    {
      patientId: "demo-p-2004",
      interventionId: "demo-iv-0001",
      category: "mask_leak",
    },
    {
      patientId: "demo-p-3007",
      interventionId: "demo-iv-0002",
      category: "pressure_intolerance",
    },
  ];
  return { eligible, count: eligible.length };
}

// ── Customer followups (customer-followups.ts) ────────────────────────
// GET /resupply-api/admin/shop/customers/:userId/followups → { followups }
function customerFollowups(includeCompleted: boolean) {
  const open = [
    {
      id: "demo-cf-0001-0000-0000-0000-000000000001",
      body: "Call back re: replacement cushion sizing",
      dueAt: daysFromNow(-1),
      completedAt: null,
      completedByEmail: null,
      createdByEmail: "demo.csr@caremetric.example",
      createdAt: daysAgo(3),
    },
    {
      id: "demo-cf-0001-0000-0000-0000-000000000002",
      body: "Confirm insurance updated before next resupply",
      dueAt: daysFromNow(2),
      completedAt: null,
      completedByEmail: null,
      createdByEmail: "demo.csr@caremetric.example",
      createdAt: daysAgo(1),
    },
  ];
  const completed = [
    {
      id: "demo-cf-0001-0000-0000-0000-000000000003",
      body: "Walk through humidifier cleaning",
      dueAt: daysAgo(7),
      completedAt: daysAgo(6),
      completedByEmail: "demo.rt@caremetric.example",
      createdByEmail: "demo.csr@caremetric.example",
      createdAt: daysAgo(10),
    },
  ];
  return { followups: includeCompleted ? [...open, ...completed] : open };
}

// ── Cross-flow followups list (followups-list.ts) ─────────────────────
// GET /resupply-api/admin/followups → { followups: [...] }
function followupsList() {
  return {
    followups: [
      {
        kind: "patient" as const,
        id: "demo-pf-0001",
        subjectId: "demo-p-2004",
        subjectDisplayName: "Avery Sample",
        subjectEmail: null,
        body: "Refit follow-up — confirm leak resolved",
        dueAt: daysFromNow(-1),
        createdByEmail: "demo.rt@caremetric.example",
        createdAt: daysAgo(3),
      },
      {
        kind: "shop_customer" as const,
        id: "demo-cf-0001-0000-0000-0000-000000000001",
        subjectId: "demo-cust-9001",
        subjectDisplayName: "Demo Patient",
        subjectEmail: "demo.patient@example.com",
        body: "Call back re: replacement cushion sizing",
        dueAt: daysFromNow(1),
        createdByEmail: "demo.csr@caremetric.example",
        createdAt: daysAgo(2),
      },
      {
        kind: "patient" as const,
        id: "demo-pf-0002",
        subjectId: "demo-p-3007",
        subjectDisplayName: "Jordan Fixture",
        subjectEmail: null,
        body: "Re-check usage after EPR change",
        dueAt: daysFromNow(5),
        createdByEmail: "demo.rt@caremetric.example",
        createdAt: daysAgo(1),
      },
    ],
  };
}

// ── Prescription renewals dispatcher (prescription-renewals.ts) ───────
// POST /resupply-api/admin/prescriptions/send-renewal-due → counts
function rxRenewalSendDue(channel: "email" | "sms") {
  return {
    attempted: 6,
    sent: 5,
    failed: 0,
    ...(channel === "email" ? { skippedNoEmail: 1 } : { skippedNoPhone: 1 }),
    skippedNoContact: 1,
    remaining: 0,
    windowDays: 30,
    channel,
  };
}

// ── Prescription requests needs-signature (prescription-requests.ts) ──
// GET /resupply-api/admin/prescription-requests/needs-signature
function needsSignature(target: {
  providerId?: string;
  practiceName?: string;
}) {
  const packets = [
    {
      id: "demo-rxr-0001",
      patientId: "demo-p-2004",
      patientName: "Sample, Avery",
      providerId: "demo-prov-1",
      providerName: "Dr. Demo Prescriber",
      providerNpi: "1234567893",
      practiceName: "Demo Sleep Clinic",
      status: "sent_fax",
      returnFaxE164: "+15555550101",
      sentAt: daysAgo(3),
      createdAt: daysAgo(4),
    },
    {
      id: "demo-rxr-0002",
      patientId: "demo-p-3007",
      patientName: "Patient, Demo",
      providerId: "demo-prov-1",
      providerName: "Dr. Demo Prescriber",
      providerNpi: "1234567893",
      practiceName: "Demo Sleep Clinic",
      status: "failed",
      returnFaxE164: "+15555550101",
      sentAt: daysAgo(2),
      createdAt: daysAgo(5),
    },
  ];
  const kind = target.providerId ? "provider" : "practice";
  const label = target.providerId
    ? "Dr. Demo Prescriber (Demo Sleep Clinic)"
    : (target.practiceName ?? "Demo Sleep Clinic");
  return {
    target: target.providerId
      ? { kind, providerId: target.providerId }
      : { kind, practiceName: target.practiceName ?? "Demo Sleep Clinic" },
    label,
    count: packets.length,
    packets,
  };
}

// ── Prior-auth queue (prior-auth-queue.ts) ────────────────────────────
// GET /resupply-api/admin/billing/prior-auth-queue
function priorAuthQueue(expiringWithinDays: number) {
  const baseRow = (
    over: Partial<Record<string, unknown>>,
  ): Record<string, unknown> => ({
    id: "demo-pa-0000",
    patientId: "demo-p-0000",
    payerName: "Demo Health Plan",
    hcpcsCode: "E0601",
    status: "submitted",
    authNumber: null,
    submittedAt: daysAgo(10),
    decisionAt: null,
    approvedThrough: null,
    mcoSlaStatus: null,
    mcoSlaTargetDate: null,
    daysToTarget: null,
    daysToExpiry: null,
    expiryState: "ok",
    expirySeverity: null,
    expiryWindow: null,
    createdAt: daysAgo(12),
    updatedAt: daysAgo(2),
    ...over,
  });
  const atRisk = [
    baseRow({
      id: "demo-pa-atrisk-1",
      patientId: "demo-p-2004",
      payerName: "Demo Medicaid MCO",
      hcpcsCode: "E0601",
      status: "submitted",
      mcoSlaStatus: "at_risk",
      mcoSlaTargetDate: dateOnly(2),
      daysToTarget: 2,
      submittedAt: daysAgo(12),
    }),
  ];
  const missed = [
    baseRow({
      id: "demo-pa-missed-1",
      patientId: "demo-p-3007",
      payerName: "Demo Advantage",
      hcpcsCode: "E0470",
      status: "submitted",
      mcoSlaStatus: "missed",
      mcoSlaTargetDate: dateOnly(-3),
      daysToTarget: -3,
      submittedAt: daysAgo(20),
    }),
  ];
  const awaiting = [
    baseRow({
      id: "demo-pa-await-1",
      patientId: "demo-p-2005",
      payerName: "Demo Health Plan",
      hcpcsCode: "A7038",
      status: "submitted",
      submittedAt: daysAgo(5),
    }),
  ];
  const expiringSoon = [
    baseRow({
      id: "demo-pa-exp-1",
      patientId: "demo-p-2006",
      payerName: "Demo PPO",
      hcpcsCode: "E0601",
      status: "approved",
      authNumber: "DEMOAUTH-7781",
      approvedThrough: dateOnly(18),
      decisionAt: daysAgo(160),
      daysToExpiry: 18,
      expiryState: "expiring",
      expirySeverity: "warning",
      expiryWindow: 30,
      submittedAt: daysAgo(170),
    }),
  ];
  const drafts = [
    baseRow({
      id: "demo-pa-draft-1",
      patientId: "demo-p-2003",
      payerName: "Demo Health Plan",
      hcpcsCode: "E0562",
      status: "draft",
      submittedAt: null,
    }),
  ];
  return {
    atRisk,
    missed,
    awaiting,
    expiringSoon,
    drafts,
    counts: {
      atRisk: atRisk.length,
      missed: missed.length,
      awaiting: awaiting.length,
      expiringSoon: expiringSoon.length,
      drafts: drafts.length,
    },
    expiringWithinDays,
    generatedAt: NOW_ISO(),
  };
}

// ── Therapy compliance (therapy-compliance.ts) ────────────────────────
// GET /resupply-api/admin/therapy-compliance/summary  → { summary }
// GET /resupply-api/admin/therapy-compliance/setups   → { count, setups }
function therapyComplianceSummary() {
  return {
    summary: {
      patientsInWindow: 34,
      qualified: 19,
      onTrack: 9,
      atRisk: 6,
    },
  };
}

function therapyComplianceSetups(status?: string) {
  const setups = [
    {
      patientId: "demo-p-2004",
      patientName: "Avery Sample",
      firstNightDate: dateOnly(-22),
      daysElapsed: 22,
      daysRemaining: 68,
      nightsInWindow: 20,
      nightsOver4h: 11,
      best30dayCount: 11,
      nightsNeeded: 10,
      status: "at_risk" as const,
    },
    {
      patientId: "demo-p-2005",
      patientName: "Quinn Mockton",
      firstNightDate: dateOnly(-40),
      daysElapsed: 40,
      daysRemaining: 50,
      nightsInWindow: 38,
      nightsOver4h: 24,
      best30dayCount: 22,
      nightsNeeded: 0,
      status: "qualified" as const,
    },
    {
      patientId: "demo-p-3007",
      patientName: "Demo Patient",
      firstNightDate: dateOnly(-15),
      daysElapsed: 15,
      daysRemaining: 75,
      nightsInWindow: 14,
      nightsOver4h: 10,
      best30dayCount: 10,
      nightsNeeded: 11,
      status: "on_track" as const,
    },
  ];
  const filtered = status ? setups.filter((s) => s.status === status) : setups;
  return { count: filtered.length, setups: filtered };
}

// ── Therapy usage report (therapy-usage-report.ts) ────────────────────
// GET /resupply-api/admin/reports/therapy-usage
function therapyUsageReport(
  groupBy: "provider" | "patient" | "manufacturer",
  days: number,
) {
  const groupsByAxis = {
    provider: [
      {
        key: "demo-prov-1",
        label: "Dr. Demo Prescriber",
        sublabel: "NPI 1234567893 · Demo Sleep Clinic",
        patientCount: 18,
        nightsWithData: 486,
        avgUsageHours: 6.1,
        avgAhi: 4.2,
        avgLeakRateLMin: 14,
        adherentNightRate: 0.78,
        cmsCompliantPatients: 13,
        cmsComplianceRate: 0.7222,
      },
      {
        key: "demo-prov-2",
        label: "Dr. Sample Physician",
        sublabel: "NPI 1987654320 · Fixture Pulmonary",
        patientCount: 9,
        nightsWithData: 233,
        avgUsageHours: 5.4,
        avgAhi: 5.8,
        avgLeakRateLMin: 17,
        adherentNightRate: 0.69,
        cmsCompliantPatients: 5,
        cmsComplianceRate: 0.5556,
      },
    ],
    manufacturer: [
      {
        key: "ResMed",
        label: "ResMed",
        sublabel: null,
        patientCount: 16,
        nightsWithData: 441,
        avgUsageHours: 6.3,
        avgAhi: 3.9,
        avgLeakRateLMin: 13,
        adherentNightRate: 0.81,
        cmsCompliantPatients: 12,
        cmsComplianceRate: 0.75,
      },
      {
        key: "Philips",
        label: "Philips",
        sublabel: null,
        patientCount: 8,
        nightsWithData: 198,
        avgUsageHours: 5.2,
        avgAhi: 6.1,
        avgLeakRateLMin: 18,
        adherentNightRate: 0.66,
        cmsCompliantPatients: 4,
        cmsComplianceRate: 0.5,
      },
    ],
    patient: [
      {
        key: "demo-p-2004",
        label: "Patient DEMO-P-2",
        sublabel: null,
        patientCount: 1,
        nightsWithData: 22,
        avgUsageHours: 3.6,
        avgAhi: 6.2,
        avgLeakRateLMin: 38,
        adherentNightRate: 0.5,
        cmsCompliantPatients: 0,
        cmsComplianceRate: 0,
      },
      {
        key: "demo-p-2005",
        label: "Patient DEMO-P-2",
        sublabel: null,
        patientCount: 1,
        nightsWithData: 38,
        avgUsageHours: 6.5,
        avgAhi: 3.0,
        avgLeakRateLMin: 11,
        adherentNightRate: 0.92,
        cmsCompliantPatients: 1,
        cmsComplianceRate: 1,
      },
    ],
  };
  const groups = groupsByAxis[groupBy];
  return {
    windowDays: days,
    generatedAt: NOW_ISO(),
    grouping: groupBy,
    summary: {
      patientCount: 27,
      nightsWithData: 719,
      avgUsageHours: 5.9,
      avgAhi: 4.7,
      avgLeakRateLMin: 15,
      adherentNightRate: 0.75,
      cmsCompliantPatients: 18,
      cmsComplianceRate: 0.6667,
    },
    groups,
  };
}

// ── Adherence predictions at-risk (adherence-predictions.ts) ──────────
// GET /resupply-api/admin/adherence/at-risk → { predictions: [...] }
function adherenceAtRisk() {
  return {
    predictions: [
      {
        patient_id: "demo-p-2004",
        probability_compliant: 0.31,
        days_of_therapy: 22,
        scored_at: daysAgo(1),
      },
      {
        patient_id: "demo-p-3007",
        probability_compliant: 0.42,
        days_of_therapy: 15,
        scored_at: daysAgo(1),
      },
      {
        patient_id: "demo-p-2003",
        probability_compliant: 0.46,
        days_of_therapy: 48,
        scored_at: daysAgo(2),
      },
    ],
  };
}

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
): number {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const clinicalHandlers: DemoHandler[] = [
  // ── Mask-fit worklist ───────────────────────────────────────────────
  route("GET", "/resupply-api/admin/clinical/mask-fit/worklist", () =>
    json({
      items: MASK_FIT_ITEMS,
      count: MASK_FIT_ITEMS.length,
      counts: {
        uncomfortable: MASK_FIT_ITEMS.filter(
          (i) => i.fit_outcome === "uncomfortable",
        ).length,
        leaking: MASK_FIT_ITEMS.filter((i) => i.fit_outcome === "leaking")
          .length,
      },
    }),
  ),
  // Triage a mask-fit outcome — benign success in the route's shape.
  route("POST", "/resupply-api/admin/clinical/mask-fit/:id/triage", (req) => {
    const body = req.json<{ status?: string }>();
    return json({ ok: true, status: body?.status ?? "reviewed" });
  }),

  // ── Clinical encounters (query is a POST) ───────────────────────────
  route("POST", "/resupply-api/admin/patients/clinical-encounters/query", () =>
    json(clinicalEncounters()),
  ),

  // ── Interventions worklist ──────────────────────────────────────────
  route("GET", "/resupply-api/admin/clinical/interventions", () =>
    json({
      interventions: INTERVENTIONS,
      count: INTERVENTIONS.length,
      openCount: INTERVENTIONS.filter((i) => i.open).length,
    }),
  ),

  // ── Setup checklist (query is a POST) ───────────────────────────────
  route("POST", "/resupply-api/admin/patients/setup-checklist/query", () =>
    json(setupChecklist()),
  ),

  // ── RT outcomes ─────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/analytics/rt-outcomes", (req) =>
    json(rtOutcomes(intParam(req, "windowDays", 90))),
  ),

  // ── RT overview ─────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/rt-overview", (req) =>
    json(rtOverview(intParam(req, "days", 7))),
  ),

  // ── Coaching plans ──────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/coaching-plans", (req) =>
    json(coachingPlans(req.query.get("include") === "closed")),
  ),
  route("POST", "/resupply-api/admin/coaching-plans", () =>
    json({ id: "demo-cp-0001-0000-0000-0000-0000000000ff" }, 201),
  ),

  // ── Clinical outreach ───────────────────────────────────────────────
  route("GET", "/resupply-api/admin/clinical/outreach/eligible", () =>
    json(clinicalOutreachEligible()),
  ),
  route("POST", "/resupply-api/admin/clinical/outreach/run", () =>
    json({
      summary: { eligible: 2, attempted: 2, sent: 2, skipped: 0, failed: 0 },
    }),
  ),

  // ── Customer followups (per shop customer) ──────────────────────────
  route("GET", "/resupply-api/admin/shop/customers/:userId/followups", (req) =>
    json(customerFollowups(req.query.get("include") === "completed")),
  ),

  // ── Cross-flow followups list ───────────────────────────────────────
  route("GET", "/resupply-api/admin/followups", () => json(followupsList())),

  // ── Prescription renewals dispatcher ────────────────────────────────
  route("POST", "/resupply-api/admin/prescriptions/send-renewal-due", (req) => {
    const channel = req.query.get("channel") === "sms" ? "sms" : "email";
    return json(rxRenewalSendDue(channel));
  }),

  // ── Prescription requests needs-signature ───────────────────────────
  route(
    "GET",
    "/resupply-api/admin/prescription-requests/needs-signature",
    (req) =>
      json(
        needsSignature({
          providerId: req.query.get("providerId") ?? undefined,
          practiceName: req.query.get("practiceName") ?? undefined,
        }),
      ),
  ),

  // ── Prior-auth queue ────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/prior-auth-queue", (req) =>
    json(priorAuthQueue(intParam(req, "expiringWithinDays", 30))),
  ),

  // ── Therapy compliance ──────────────────────────────────────────────
  route("GET", "/resupply-api/admin/therapy-compliance/summary", () =>
    json(therapyComplianceSummary()),
  ),
  route("GET", "/resupply-api/admin/therapy-compliance/setups", (req) =>
    json(therapyComplianceSetups(req.query.get("status") ?? undefined)),
  ),

  // ── Therapy usage report ────────────────────────────────────────────
  route("GET", "/resupply-api/admin/reports/therapy-usage", (req) => {
    const raw = req.query.get("groupBy");
    const groupBy =
      raw === "patient" || raw === "manufacturer" ? raw : "provider";
    return json(therapyUsageReport(groupBy, intParam(req, "days", 30)));
  }),

  // ── Adherence predictions at-risk ───────────────────────────────────
  route("GET", "/resupply-api/admin/adherence/at-risk", () =>
    json(adherenceAtRisk()),
  ),
];
