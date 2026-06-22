// Automation/frequency "rules" engine, compliance-rule mutations, and a
// couple of top-level public routes (telehealth session lookup) for the
// demo sandbox. The fetch interceptor's empty `{}` fallback makes these
// admin pages crash (they map over `rules`, read nested `plan` fields,
// etc.), so each route below returns fully-shaped sample data matching the
// live API response (see the corresponding
// artifacts/resupply-api/src/routes/*.ts route file).
//
// SCOPE NOTE: the compliance-rules LIST (GET /resupply-api/compliance-rules)
// is already seeded by handlers/settings.ts — it is intentionally NOT
// re-seeded here. This module only adds the compliance-rule MUTATIONS
// (create/update/delete). The "rules" engine here is the *frequency*
// (cadence) rules engine (resupply.frequency_rules) — a separate concern
// from compliance-rules.
//
// DATA RULES: everything here is fictional demo data — obviously-fake
// payer names, demo ids, fresh relative dates. Tenant is Penn Home Medical
// Supply (pennpaps.com) on the CareMetric Breathe platform. NO real PHI.

import { route, type DemoHandler } from "../types";
import { json, noContent } from "../respond";
import { daysAgo, NOW_ISO } from "../fixtures/dates";

// ── Frequency rules (rules/list.ts) ──────────────────────────────────
// GET /resupply-api/rules → { rules: FrequencyRule[] }
// A frequency rule is a (priority / match-predicate / cadence+channel)
// triple: the eligibility engine walks them in (priority asc, createdAt
// asc) order and the first match decides the resupply cadence + channel.
interface DemoFrequencyRule {
  id: string;
  name: string;
  priority: number;
  matchItemSkuPrefix: string | null;
  matchInsurancePayer: string | null;
  minTenureDays: number | null;
  maxTenureDays: number | null;
  cadenceDays: number;
  defaultChannel: "sms" | "email" | "voice" | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const FREQUENCY_RULES: DemoFrequencyRule[] = [
  {
    id: "00000000-0000-4000-8000-0000000090a1",
    name: "Mask resupply — first 90 days",
    priority: 10,
    matchItemSkuPrefix: "MASK-",
    matchInsurancePayer: null,
    minTenureDays: 0,
    maxTenureDays: 90,
    cadenceDays: 30,
    defaultChannel: "sms",
    active: true,
    notes: "Tighter cadence for new setups to lock in early adherence.",
    createdAt: daysAgo(210),
    updatedAt: daysAgo(35),
  },
  {
    id: "00000000-0000-4000-8000-0000000090a2",
    name: "Medicare cushions + filters",
    priority: 20,
    matchItemSkuPrefix: null,
    matchInsurancePayer: "Medicare PA",
    minTenureDays: 90,
    maxTenureDays: null,
    cadenceDays: 90,
    defaultChannel: "email",
    active: true,
    notes: "CMS replacement schedule for established patients.",
    createdAt: daysAgo(210),
    updatedAt: daysAgo(120),
  },
  {
    id: "00000000-0000-4000-8000-0000000090a3",
    name: "Tubing — voice outreach pilot",
    priority: 50,
    matchItemSkuPrefix: "TUBE-",
    matchInsurancePayer: null,
    minTenureDays: null,
    maxTenureDays: null,
    cadenceDays: 180,
    defaultChannel: "voice",
    active: false,
    notes: null,
    createdAt: daysAgo(150),
    updatedAt: daysAgo(150),
  },
  {
    id: "00000000-0000-4000-8000-0000000090a4",
    name: "Default fallback cadence",
    priority: 100,
    matchItemSkuPrefix: null,
    matchInsurancePayer: null,
    minTenureDays: null,
    maxTenureDays: null,
    cadenceDays: 90,
    defaultChannel: null,
    active: true,
    notes: "Applies when no SKU/payer-specific rule matches.",
    createdAt: daysAgo(210),
    updatedAt: daysAgo(210),
  },
];

// A freshly-created frequency rule echoed back in the route's shape.
function createdFrequencyRule(
  body: Partial<DemoFrequencyRule> | undefined,
): DemoFrequencyRule {
  const now = NOW_ISO();
  return {
    id: "00000000-0000-4000-8000-0000000090ff",
    name: body?.name ?? "New cadence rule",
    priority: body?.priority ?? 100,
    matchItemSkuPrefix: body?.matchItemSkuPrefix ?? null,
    matchInsurancePayer: body?.matchInsurancePayer ?? null,
    minTenureDays: body?.minTenureDays ?? null,
    maxTenureDays: body?.maxTenureDays ?? null,
    cadenceDays: body?.cadenceDays ?? 90,
    defaultChannel: body?.defaultChannel ?? null,
    active: body?.active ?? true,
    notes: body?.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

// ── Rule simulator (rules/test.ts) ───────────────────────────────────
// POST /resupply-api/rules/test → { input, plan, evaluated }
// Pure-function "which rule would fire?" simulator. We reproduce the
// resolver's decision against FREQUENCY_RULES so the demo tester shows a
// realistic matched rule + per-rule "why didn't this fire?" reasons.
interface RuleTestInput {
  patient?: {
    tenureDays?: number;
    insurancePayer?: string | null;
    cadenceOverrideDays?: number | null;
    channelPreference?: "sms" | "email" | "voice" | null;
    hasPhone?: boolean;
  };
  prescription?: {
    itemSku?: string;
    cadenceDays?: number;
  };
}

function simulateRuleTest(body: RuleTestInput | undefined) {
  const tenureDays = body?.patient?.tenureDays ?? 120;
  const insurancePayer = body?.patient?.insurancePayer ?? null;
  const cadenceOverrideDays = body?.patient?.cadenceOverrideDays ?? null;
  const channelPreference = body?.patient?.channelPreference ?? null;
  const hasPhone = body?.patient?.hasPhone ?? true;
  const itemSku = body?.prescription?.itemSku ?? "MASK-N20-M";
  const rxCadenceDays = body?.prescription?.cadenceDays ?? 90;

  // Walk active rules in (priority asc, createdAt asc) order; first
  // predicate-clearing rule wins. The list is already authored in order.
  const ordered = [...FREQUENCY_RULES].sort((a, b) => a.priority - b.priority);

  let matchedId: string | null = null;
  const evaluated = ordered.map((r) => {
    const reasons: string[] = [];
    if (!r.active) reasons.push("rule is inactive");
    if (
      r.matchItemSkuPrefix !== null &&
      !itemSku.startsWith(r.matchItemSkuPrefix)
    ) {
      reasons.push(
        `itemSku "${itemSku}" does not start with "${r.matchItemSkuPrefix}"`,
      );
    }
    if (r.matchInsurancePayer !== null) {
      if (insurancePayer === null) {
        reasons.push("rule requires a payer; patient has none on file");
      } else if (insurancePayer !== r.matchInsurancePayer) {
        reasons.push(`payer "${insurancePayer}" ≠ "${r.matchInsurancePayer}"`);
      }
    }
    if (r.minTenureDays !== null && tenureDays < r.minTenureDays) {
      reasons.push(`tenure ${tenureDays}d < minTenureDays ${r.minTenureDays}d`);
    }
    if (r.maxTenureDays !== null && tenureDays > r.maxTenureDays) {
      reasons.push(`tenure ${tenureDays}d > maxTenureDays ${r.maxTenureDays}d`);
    }
    const isMatch = reasons.length === 0 && matchedId === null;
    if (isMatch) matchedId = r.id;
    return {
      id: r.id,
      priority: r.priority,
      cadenceDays: r.cadenceDays,
      defaultChannel: r.defaultChannel,
      matchItemSkuPrefix: r.matchItemSkuPrefix,
      matchInsurancePayer: r.matchInsurancePayer,
      minTenureDays: r.minTenureDays,
      maxTenureDays: r.maxTenureDays,
      active: r.active,
      matched: isMatch,
      reasonsForNoMatch: reasons,
    };
  });

  const matched = ordered.find((r) => r.id === matchedId) ?? null;

  // Resolve cadence: patient override > matched rule > prescription.
  let cadenceDays: number;
  let cadenceSource: "patient_override" | "rule" | "prescription";
  if (cadenceOverrideDays !== null) {
    cadenceDays = cadenceOverrideDays;
    cadenceSource = "patient_override";
  } else if (matched) {
    cadenceDays = matched.cadenceDays;
    cadenceSource = "rule";
  } else {
    cadenceDays = rxCadenceDays;
    cadenceSource = "prescription";
  }

  // Resolve channel: patient pref > matched rule's defaultChannel >
  // sms-if-phone-else-email.
  let channel: "sms" | "email" | "voice";
  let channelSource:
    | "patient_override"
    | "rule"
    | "default_sms"
    | "default_email";
  if (channelPreference !== null) {
    channel = channelPreference;
    channelSource = "patient_override";
  } else if (matched && matched.defaultChannel !== null) {
    channel = matched.defaultChannel;
    channelSource = "rule";
  } else if (hasPhone) {
    channel = "sms";
    channelSource = "default_sms";
  } else {
    channel = "email";
    channelSource = "default_email";
  }

  return {
    input: {
      patient: {
        tenureDays,
        insurancePayer,
        cadenceOverrideDays,
        channelPreference,
        hasPhone,
      },
      prescription: { itemSku, cadenceDays: rxCadenceDays },
      now: NOW_ISO(),
    },
    plan: {
      cadenceDays,
      cadenceSource,
      channel,
      channelSource,
      matchedRuleId: matchedId,
    },
    evaluated,
  };
}

// ── Compliance-rule create (compliance-rules/create.ts) ──────────────
// POST /resupply-api/compliance-rules → created row (201).
// (LIST is already seeded in handlers/settings.ts — do not duplicate.)
interface ComplianceRuleBody {
  name?: string;
  priority?: number;
  matchInsurancePayer?: string | null;
  minMinutes?: number;
  requiredNights?: number;
  windowDays?: number;
  active?: boolean;
  notes?: string | null;
}

function createdComplianceRule(body: ComplianceRuleBody | undefined) {
  const now = NOW_ISO();
  return {
    id: "00000000-0000-4000-8000-0000000070ff",
    name: body?.name ?? "New compliance rule",
    priority: body?.priority ?? 100,
    matchInsurancePayer: body?.matchInsurancePayer ?? null,
    minMinutes: body?.minMinutes ?? 240,
    requiredNights: body?.requiredNights ?? 21,
    windowDays: body?.windowDays ?? 30,
    active: body?.active ?? true,
    notes: body?.notes ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

export const ext16Handlers: DemoHandler[] = [
  // ── Frequency rules: list ───────────────────────────────────────────
  route("GET", "/resupply-api/rules", () => json({ rules: FREQUENCY_RULES })),

  // Frequency rules: create — echoes the created row (route returns 201).
  route("POST", "/resupply-api/rules", (req) =>
    json(createdFrequencyRule(req.json<Partial<DemoFrequencyRule>>()), 201),
  ),

  // Frequency rules: update — route returns { id, changed: string[] }.
  route("PATCH", "/resupply-api/rules/:id", (req, { id }) => {
    const body = req.json<Record<string, unknown>>() ?? {};
    const changed = Object.keys(body).filter((k) => k !== "expectedUpdatedAt");
    return json({ id, changed });
  }),

  // Frequency rules: delete — route returns 204 No Content.
  route("DELETE", "/resupply-api/rules/:id", () => noContent()),

  // Frequency rules: simulator — pure read-only "which rule fires?".
  route("POST", "/resupply-api/rules/test", (req) =>
    json(simulateRuleTest(req.json<RuleTestInput>())),
  ),

  // ── Compliance rules: mutations only (LIST lives in settings.ts) ────
  route("POST", "/resupply-api/compliance-rules", (req) =>
    json(createdComplianceRule(req.json<ComplianceRuleBody>()), 201),
  ),
  route("PATCH", "/resupply-api/compliance-rules/:id", (req, { id }) => {
    const body = req.json<Record<string, unknown>>() ?? {};
    const changed = Object.keys(body).filter((k) => k !== "expectedUpdatedAt");
    return json({ id, changed });
  }),
  route("DELETE", "/resupply-api/compliance-rules/:id", () => noContent()),

  // ── Telehealth session lookup (video-visit-session.ts) ──────────────
  // GET /resupply-api/video-visit/session?token=… → public lobby payload.
  // The patient join page (pages/video-visit.tsx) calls this before
  // entering the WebRTC room. We return a benign "ready" lobby with no
  // ICE servers (the demo never establishes a real peer connection) so
  // the lobby renders the practice name / purpose / time card instead of
  // an error page. No PHI — only practice name, purpose, and time.
  route("GET", "/resupply-api/video-visit/session", () =>
    json({
      state: "ready",
      role: "patient",
      purpose: "follow_up",
      scheduledAt: NOW_ISO(),
      practiceName: "Penn Home Medical Supply",
      wsPath: "/resupply-api/video/signal",
      iceServers: [],
    }),
  ),

  // NOTE: rx-request-document.ts (GET /resupply-api/rx-request/document/:token)
  // streams a rendered PDF (application/pdf), not JSON — SKIPPED per the
  // binary/stream rule. It is a Telnyx-facing fax fetch, not an SPA call.
];
