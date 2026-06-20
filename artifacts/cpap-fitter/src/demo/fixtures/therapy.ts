// Demo fixtures for the Therapy Fleet + Resupply Opportunities admin pages.
// Without these the fetch interceptor falls back to an empty `{}` for these
// GETs, and the pages read nested fields (e.g. summary.byCategory.mask,
// summary.byKind.pressure_at_max) off undefined and crash. Typed against the
// real API interfaces so the shapes can't drift.

import type {
  ResupplySummary,
  ResupplyOpportunity,
  ResupplyDraft,
} from "@/lib/admin/therapy-resupply-api";
import type {
  FleetOverview,
  FleetTrendPoint,
  FleetAlert,
  WorklistEntry,
  ClinicalInsightReport,
  ClinicalInsightEntry,
} from "@/lib/admin/therapy-fleet-api";

import { daysAgo, dateOnly } from "./dates";

// ── Resupply Opportunities ───────────────────────────────────────────

export function demoResupplySummary(dueWithinDays: number): {
  dueWithinDays: number;
  summary: ResupplySummary;
} {
  return {
    dueWithinDays,
    summary: {
      patientsWithDue: 38,
      itemsDue: 112,
      itemsOverdue: 27,
      byCategory: { mask: 14, cushion: 41, tubing: 22, filter: 35 },
      highLeakRefit: 6,
    },
  };
}

const RESUPPLY_OPPS: ResupplyOpportunity[] = [
  {
    patientId: "demo-p-2001",
    patientName: "Casey Demo",
    source: "Replacement schedule",
    category: "cushion",
    description: "Mask cushion · last replaced 96 days ago",
    lastReplacedDate: dateOnly(-96),
    nextEligibleDate: dateOnly(-12),
    daysUntilEligible: -12,
    highLeak: true,
    fetchedAt: daysAgo(1),
  },
  {
    patientId: "demo-p-2002",
    patientName: "Morgan Example",
    source: "Replacement schedule",
    category: "filter",
    description: "Disposable filters · last replaced 34 days ago",
    lastReplacedDate: dateOnly(-34),
    nextEligibleDate: dateOnly(-4),
    daysUntilEligible: -4,
    highLeak: false,
    fetchedAt: daysAgo(1),
  },
  {
    patientId: "demo-p-2004",
    patientName: "Avery Placeholder",
    source: "ResMed AirView",
    category: "mask",
    description: "Full mask refit suggested · leak trending high",
    lastReplacedDate: dateOnly(-188),
    nextEligibleDate: dateOnly(-2),
    daysUntilEligible: -2,
    highLeak: true,
    fetchedAt: daysAgo(1),
  },
  {
    patientId: "demo-p-2003",
    patientName: "Riley Tester",
    source: "Replacement schedule",
    category: "tubing",
    description: "Standard tubing · last replaced 80 days ago",
    lastReplacedDate: dateOnly(-80),
    nextEligibleDate: dateOnly(1),
    daysUntilEligible: 1,
    highLeak: false,
    fetchedAt: daysAgo(2),
  },
  {
    patientId: "demo-p-2005",
    patientName: "Quinn Fictional",
    source: "Replacement schedule",
    category: "cushion",
    description: "Nasal cushion · last replaced 28 days ago",
    lastReplacedDate: dateOnly(-28),
    nextEligibleDate: dateOnly(2),
    daysUntilEligible: 2,
    highLeak: false,
    fetchedAt: daysAgo(2),
  },
  {
    patientId: "demo-p-2006",
    patientName: "Harper Mockford",
    source: "Replacement schedule",
    category: "filter",
    description: "Disposable filters · last replaced 31 days ago",
    lastReplacedDate: dateOnly(-31),
    nextEligibleDate: dateOnly(3),
    daysUntilEligible: 3,
    highLeak: false,
    fetchedAt: daysAgo(2),
  },
];

export function demoResupplyOpportunities(params: {
  dueWithinDays: number;
  category?: string;
}): {
  dueWithinDays: number;
  count: number;
  opportunities: ResupplyOpportunity[];
} {
  const opportunities = params.category
    ? RESUPPLY_OPPS.filter((o) => o.category === params.category)
    : RESUPPLY_OPPS;
  return {
    dueWithinDays: params.dueWithinDays,
    count: opportunities.length,
    opportunities,
  };
}

const RESUPPLY_DRAFTS: ResupplyDraft[] = [
  {
    id: "demo-draft-1",
    patientId: "demo-p-2001",
    patientName: "Casey Demo",
    category: "cushion",
    source: "Replacement schedule",
    sourceDescription: "Mask cushion · last replaced 96 days ago",
    nextEligibleDate: dateOnly(-12),
    suggestedProductId: null,
    suggestedQuantity: 1,
    status: "proposed",
    origin: "auto",
    createdAt: daysAgo(1),
  },
  {
    id: "demo-draft-2",
    patientId: "demo-p-2004",
    patientName: "Avery Placeholder",
    category: "mask",
    source: "ResMed AirView",
    sourceDescription: "Full mask refit suggested · leak trending high",
    nextEligibleDate: dateOnly(-2),
    suggestedProductId: null,
    suggestedQuantity: 1,
    status: "proposed",
    origin: "auto",
    createdAt: daysAgo(1),
  },
];

export function demoResupplyDrafts(status: string): {
  status: string;
  count: number;
  drafts: ResupplyDraft[];
} {
  const drafts = status === "proposed" ? RESUPPLY_DRAFTS : [];
  return { status, count: drafts.length, drafts };
}

// ── Therapy Fleet ────────────────────────────────────────────────────

export function demoFleetOverview(windowDays: number): {
  windowDays: number;
  overview: FleetOverview;
} {
  return {
    windowDays,
    overview: {
      patientsWithData: 214,
      cohorts: {
        compliant: 156,
        atRisk: 31,
        nonCompliant: 18,
        noRecentData: 9,
      },
      clinicalFlags: { highAhi: 7, highLeak: 12, lowUsage: 21 },
      averages: { usageMinutes: 376, ahi: 3.4, leakLMin: 14 },
      totalNights: 5840,
    },
  };
}

export function demoFleetTrend(days: number): {
  days: number;
  count: number;
  points: FleetTrendPoint[];
} {
  const n = Math.min(Math.max(days, 14), 30);
  const points: FleetTrendPoint[] = Array.from({ length: n }).map((_, i) => {
    const back = n - 1 - i;
    const wobble = ((i % 5) - 2) * 2;
    return {
      date: dateOnly(-back),
      patientsWithData: 198 + (i % 7) + wobble,
      compliant: 150 + (i % 6) + wobble,
      atRisk: 30 - (i % 4),
      nonCompliant: 18 + (i % 3),
      highLeak: 11 + (i % 4),
      resupplyItemsDue: 90 + (i % 9) * 3,
      setupsInWindow: 12 + (i % 4),
      setupsAtRisk: 2 + (i % 3),
      clinicalSignalsOpen: 14 + (i % 5),
      clinicalSignalsHigh: 3 + (i % 2),
      clinicalSignalsMedium: 9 + (i % 4),
    };
  });
  return { days, count: points.length, points };
}

const FLEET_ALERTS: FleetAlert[] = [
  {
    id: "demo-alert-1",
    patientId: "demo-p-2004",
    patientName: "Avery Placeholder",
    alertType: "high_leak",
    severity: "high",
    detail: { avgLeakLMin: 38 },
    outreachSentAt: null,
    createdAt: daysAgo(1),
  },
  {
    id: "demo-alert-2",
    patientId: "demo-p-3007",
    patientName: "Sam Specimen",
    alertType: "high_ahi",
    severity: "high",
    detail: { avgAhi: 12.6 },
    outreachSentAt: null,
    createdAt: daysAgo(2),
  },
  {
    id: "demo-alert-3",
    patientId: "demo-p-2003",
    patientName: "Riley Tester",
    alertType: "usage_decline",
    severity: "medium",
    detail: { avgUsageMinutes: 168, priorAvgUsageMinutes: 352 },
    outreachSentAt: daysAgo(1),
    createdAt: daysAgo(3),
  },
];

export function demoFleetAlerts(): { count: number; alerts: FleetAlert[] } {
  return { count: FLEET_ALERTS.length, alerts: FLEET_ALERTS };
}

const FLEET_WORKLIST: WorklistEntry[] = [
  {
    patientId: "demo-p-2004",
    patientName: "Avery Placeholder",
    nightsWithData: 26,
    nightsOver4h: 11,
    avgUsageMinutes: 214,
    avgAhi: 6.2,
    avgLeakLMin: 38,
    priorAvgUsageMinutes: 333,
    lastNightDate: dateOnly(-1),
    daysSinceLastNight: 1,
    reasons: ["high_leak", "usage_decline"],
    priority: 92,
    action: null,
  },
  {
    patientId: "demo-p-3007",
    patientName: "Sam Specimen",
    nightsWithData: 24,
    nightsOver4h: 9,
    avgUsageMinutes: 188,
    avgAhi: 12.6,
    avgLeakLMin: 19,
    priorAvgUsageMinutes: 240,
    lastNightDate: dateOnly(-1),
    daysSinceLastNight: 1,
    reasons: ["high_ahi", "compliance_risk"],
    priority: 88,
    action: null,
  },
  {
    patientId: "demo-p-2003",
    patientName: "Riley Tester",
    nightsWithData: 18,
    nightsOver4h: 7,
    avgUsageMinutes: 168,
    avgAhi: 4.1,
    avgLeakLMin: 12,
    priorAvgUsageMinutes: 352,
    lastNightDate: dateOnly(-2),
    daysSinceLastNight: 2,
    reasons: ["usage_decline", "compliance_risk"],
    priority: 74,
    action: {
      status: "contacted",
      snoozeUntil: null,
      note: "Left voicemail re: comfort settings",
      updatedByEmail: "demo.admin@pennfit.example",
      updatedAt: daysAgo(1),
    },
  },
  {
    patientId: "demo-p-3008",
    patientName: "Drew Dummy",
    nightsWithData: 0,
    nightsOver4h: 0,
    avgUsageMinutes: null,
    avgAhi: null,
    avgLeakLMin: null,
    priorAvgUsageMinutes: 318,
    lastNightDate: dateOnly(-21),
    daysSinceLastNight: 21,
    reasons: ["no_recent_data"],
    priority: 61,
    action: null,
  },
  {
    patientId: "demo-p-2006",
    patientName: "Harper Mockford",
    nightsWithData: 27,
    nightsOver4h: 14,
    avgUsageMinutes: 256,
    avgAhi: 9.4,
    avgLeakLMin: 16,
    priorAvgUsageMinutes: 268,
    lastNightDate: dateOnly(-1),
    daysSinceLastNight: 1,
    reasons: ["high_ahi"],
    priority: 55,
    action: null,
  },
];

export function demoFleetWorklist(params: {
  windowDays: number;
  reason?: string;
}): { windowDays: number; count: number; entries: WorklistEntry[] } {
  const entries = params.reason
    ? FLEET_WORKLIST.filter((e) =>
        e.reasons.includes(params.reason as WorklistEntry["reasons"][number]),
      )
    : FLEET_WORKLIST;
  return { windowDays: params.windowDays, count: entries.length, entries };
}

const CLINICAL_ENTRIES: ClinicalInsightEntry[] = [
  {
    id: "demo-ci-1",
    patientId: "demo-p-3007",
    patientName: "Sam Specimen",
    kind: "ahi_elevated",
    severity: "high",
    detectedAt: daysAgo(1),
    windowStartDate: dateOnly(-30),
    windowEndDate: dateOnly(-1),
    metrics: {
      nightsInWindow: 24,
      lastNightDate: dateOnly(-1),
      avgAhi: 12.6,
      avgLeakLMin: 19,
      avgPressureP95: 13.8,
      avgUsageMinutes: 188,
      deviceMaxPressure: 16,
    },
  },
  {
    id: "demo-ci-2",
    patientId: "demo-p-2004",
    patientName: "Avery Placeholder",
    kind: "pressure_at_max",
    severity: "high",
    detectedAt: daysAgo(2),
    windowStartDate: dateOnly(-30),
    windowEndDate: dateOnly(-1),
    metrics: {
      nightsInWindow: 26,
      lastNightDate: dateOnly(-1),
      avgAhi: 6.2,
      avgLeakLMin: 38,
      avgPressureP95: 19.6,
      avgUsageMinutes: 214,
      deviceMaxPressure: 20,
    },
  },
  {
    id: "demo-ci-3",
    patientId: "demo-p-2003",
    patientName: "Riley Tester",
    kind: "non_adherent_30d",
    severity: "medium",
    detectedAt: daysAgo(3),
    windowStartDate: dateOnly(-30),
    windowEndDate: dateOnly(-2),
    metrics: {
      nightsInWindow: 18,
      lastNightDate: dateOnly(-2),
      avgAhi: 4.1,
      avgLeakLMin: 12,
      avgPressureP95: 10.2,
      avgUsageMinutes: 168,
      deviceMaxPressure: 14,
    },
  },
  {
    id: "demo-ci-4",
    patientId: "demo-p-2006",
    patientName: "Harper Mockford",
    kind: "ahi_rising",
    severity: "medium",
    detectedAt: daysAgo(4),
    windowStartDate: dateOnly(-30),
    windowEndDate: dateOnly(-1),
    metrics: {
      nightsInWindow: 27,
      lastNightDate: dateOnly(-1),
      avgAhi: 9.4,
      avgLeakLMin: 16,
      avgPressureP95: 12.1,
      avgUsageMinutes: 256,
      deviceMaxPressure: 15,
    },
  },
  {
    id: "demo-ci-5",
    patientId: "demo-p-2005",
    patientName: "Quinn Fictional",
    kind: "usage_erratic",
    severity: "medium",
    detectedAt: daysAgo(5),
    windowStartDate: dateOnly(-30),
    windowEndDate: dateOnly(-1),
    metrics: {
      nightsInWindow: 21,
      lastNightDate: dateOnly(-1),
      avgAhi: 3.0,
      avgLeakLMin: 11,
      avgPressureP95: 9.4,
      avgUsageMinutes: 232,
      deviceMaxPressure: 13,
    },
  },
];

export function demoClinicalInsights(kind?: string): ClinicalInsightReport {
  const entries = kind
    ? CLINICAL_ENTRIES.filter((e) => e.kind === kind)
    : CLINICAL_ENTRIES;
  const byKind = {
    pressure_at_max: 0,
    ahi_elevated: 0,
    non_adherent_30d: 0,
    ahi_rising: 0,
    usage_erratic: 0,
  };
  for (const e of CLINICAL_ENTRIES) byKind[e.kind] += 1;
  const high = CLINICAL_ENTRIES.filter((e) => e.severity === "high").length;
  return {
    count: entries.length,
    summary: {
      total: CLINICAL_ENTRIES.length,
      patients: new Set(CLINICAL_ENTRIES.map((e) => e.patientId)).size,
      byKind,
      bySeverity: { high, medium: CLINICAL_ENTRIES.length - high },
    },
    entries,
  };
}
