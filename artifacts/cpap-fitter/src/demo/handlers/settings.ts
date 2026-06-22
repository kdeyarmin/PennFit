// Settings / Control-Center / Compliance admin handlers. Seeds the
// configuration-surface endpoints (feature flags, alert library,
// message templates, bulk campaigns, team, branding, MFA, smart
// triggers, KPI metric alerts + thresholds, compliance rules, CSR
// compliance alerts, the audit trail, tenant System Configuration,
// and the tenant email/phone sender settings) with realistic,
// fully-shaped fictional data.
//
// Every body here is matched to the live route's response JSON so the
// SPA derefs land. For the prominent toggle mutations (flip a feature
// flag, acknowledge a metric alert, patch the email/phone sender) the
// handler echoes the new state in the correct shape so the control
// appears to work in the demo. No real PHI — all ids/names are
// obviously fictional demo placeholders.
//
// Wiring: this module exports `settingsHandlers`; router.ts pulls it in
// alongside `adminHandlers`. Platform brand is "CareMetric Breathe";
// the seed tenant is Penn Home Medical Supply (pennpaps.com), which
// keeps its "PennBot"/"PennPilot" assistant names and its
// info@pennpaps.com storefront From address.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, hoursAgo, NOW_ISO } from "../fixtures/dates";

// ── Feature flags (Control Center) ─────────────────────────────────
// Mirrors GET /admin/feature-flags → { flags: FeatureFlag[] } and
// PATCH /admin/feature-flags/:key → { flag: FeatureFlag }.

interface DemoFeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  category: string;
  manageable: boolean;
  updatedByEmail: string | null;
  updatedAt: string;
}

const DEMO_OPERATOR_EMAIL = "demo.admin@pennfit.example";

// A realistic spread across categories with a believable on/off mix.
const FEATURE_FLAG_SEED: Array<
  Pick<DemoFeatureFlag, "key" | "enabled" | "description" | "category">
> = [
  {
    key: "sms.reminders",
    enabled: true,
    description: "Send resupply reminders by SMS.",
    category: "Messaging",
  },
  {
    key: "email.reminders",
    enabled: true,
    description: "Send resupply reminders by email.",
    category: "Messaging",
  },
  {
    key: "email.auto_reply",
    enabled: false,
    description:
      "Let the assistant auto-answer high-confidence inbound patient email.",
    category: "Messaging",
  },
  {
    key: "voice.agent",
    enabled: true,
    description: "Outbound AI voice agent for resupply confirmation calls.",
    category: "Voice",
  },
  {
    key: "telehealth.video",
    enabled: false,
    description: "Video visits for remote mask fittings.",
    category: "Clinical",
  },
  {
    key: "storefront.chatbot",
    enabled: true,
    description: "Storefront chatbot (PennBot) on the public shop.",
    category: "Storefront",
  },
  {
    key: "admin.assistant",
    enabled: true,
    description: "In-app admin assistant (PennPilot) widget.",
    category: "Admin",
  },
  {
    key: "storefront.checkout",
    enabled: true,
    description: "Online checkout on the storefront.",
    category: "Storefront",
  },
  {
    key: "storefront.reviews_collection",
    enabled: true,
    description: "Request product reviews after delivery.",
    category: "Storefront",
  },
  {
    key: "bulk_campaigns.send",
    enabled: true,
    description: "Allow bulk SMS/email campaigns to start and send.",
    category: "Campaigns",
  },
  {
    key: "smart_triggers.dispatcher",
    enabled: true,
    description: "Data-driven reorder triggers from therapy usage.",
    category: "Resupply",
  },
  {
    key: "resupply.auto_order_drafts",
    enabled: false,
    description: "Auto-create order drafts when a resupply is due.",
    category: "Resupply",
  },
  {
    key: "billing.auto_submit_claims",
    enabled: true,
    description: "Automatically submit clean 837P claims.",
    category: "Billing",
  },
  {
    key: "billing.eligibility_precheck",
    enabled: true,
    description: "Run a 270/271 eligibility check before fulfillment.",
    category: "Billing",
  },
  {
    key: "ai_billing.suggestions",
    enabled: true,
    description: "AI code/edit suggestions on the denials worklist.",
    category: "Billing",
  },
  {
    key: "pacware.auto_sync",
    enabled: false,
    description: "Surface a 'ready to sync to PacWare' notice (manual push).",
    category: "Integrations",
  },
  {
    key: "provider.portal_enabled",
    enabled: false,
    description: "Referring-provider portal access.",
    category: "Integrations",
  },
  {
    key: "support.tickets",
    enabled: true,
    description: "In-app support ticketing.",
    category: "Admin",
  },
];

function demoFeatureFlag(
  seed: (typeof FEATURE_FLAG_SEED)[number],
  i: number,
): DemoFeatureFlag {
  return {
    key: seed.key,
    enabled: seed.enabled,
    description: seed.description,
    category: seed.category,
    manageable: true,
    updatedByEmail: i % 3 === 0 ? DEMO_OPERATOR_EMAIL : null,
    updatedAt: daysAgo(i + 1),
  };
}

function demoFeatureFlags(): { flags: DemoFeatureFlag[] } {
  return { flags: FEATURE_FLAG_SEED.map(demoFeatureFlag) };
}

function demoToggleFlag(
  key: string,
  enabled: boolean,
): { flag: DemoFeatureFlag } {
  const idx = FEATURE_FLAG_SEED.findIndex((f) => f.key === key);
  const seed =
    idx >= 0
      ? FEATURE_FLAG_SEED[idx]!
      : {
          key,
          enabled,
          description: "Demo feature flag.",
          category: "Admin",
        };
  return {
    flag: {
      key: seed.key,
      enabled,
      description: seed.description,
      category: seed.category,
      manageable: true,
      updatedByEmail: DEMO_OPERATOR_EMAIL,
      updatedAt: NOW_ISO(),
    },
  };
}

function demoFeatureFlagActivity() {
  const events = FEATURE_FLAG_SEED.slice(0, 6).map((f, i) => ({
    occurredAt: hoursAgo(i * 5 + 1),
    operatorEmail: DEMO_OPERATOR_EMAIL,
    key: f.key,
    from: !f.enabled,
    to: f.enabled,
  }));
  return { activity: events };
}

// ── Alert library ──────────────────────────────────────────────────
// GET /admin/alerts → { alerts: AlertDefinitionView[] } where each
// definition carries its per-channel messages.

function demoAlertMessage(
  channel: "email" | "sms" | "voice",
  subject: string | null,
  bodyText: string,
) {
  return {
    channel,
    subject,
    bodyHtml: channel === "email" ? `<p>${bodyText}</p>` : null,
    bodyText,
    isActive: true,
    updatedAt: daysAgo(7),
    updatedBy: null,
  };
}

function demoAlerts() {
  return {
    alerts: [
      {
        key: "resupply_due",
        name: "Resupply due",
        description:
          "Notify a patient that their CPAP supplies are due for resupply.",
        category: "Resupply",
        severity: "info",
        channels: ["email", "sms", "voice"],
        allowedVariables: ["first_name", "due_date", "confirm_link"],
        isActive: true,
        messages: [
          demoAlertMessage(
            "email",
            "Your CPAP supplies are due, {{first_name}}",
            "Hi {{first_name}}, your CPAP supplies are due for resupply. Confirm here: {{confirm_link}}",
          ),
          demoAlertMessage(
            "sms",
            null,
            "Hi {{first_name}}, your CPAP supplies are due. Reply YES to confirm or visit {{confirm_link}}",
          ),
          demoAlertMessage(
            "voice",
            null,
            "Hi {{first_name}}, this is Penn Home Medical Supply calling about your CPAP resupply.",
          ),
        ],
      },
      {
        key: "low_usage",
        name: "Low therapy usage",
        description:
          "Outreach when nightly usage drops below the adherence target.",
        category: "Clinical",
        severity: "warning",
        channels: ["email", "sms"],
        allowedVariables: ["first_name", "nights"],
        isActive: true,
        messages: [
          demoAlertMessage(
            "email",
            "Let's get your therapy back on track, {{first_name}}",
            "Hi {{first_name}}, we noticed lower usage over the last {{nights}} nights. We're here to help.",
          ),
          demoAlertMessage(
            "sms",
            null,
            "Hi {{first_name}}, we noticed lower CPAP usage lately. Reply HELP and we'll give you a call.",
          ),
        ],
      },
      {
        key: "order_shipped",
        name: "Order shipped",
        description: "Confirmation that a resupply order has shipped.",
        category: "Fulfillment",
        severity: "info",
        channels: ["email", "sms"],
        allowedVariables: ["first_name", "tracking_url"],
        isActive: true,
        messages: [
          demoAlertMessage(
            "email",
            "Your order is on its way, {{first_name}}",
            "Good news {{first_name}} — your supplies shipped. Track them: {{tracking_url}}",
          ),
          demoAlertMessage(
            "sms",
            null,
            "Your Penn Home Medical Supply order shipped! Track: {{tracking_url}}",
          ),
        ],
      },
    ],
  };
}

// ── Message templates ──────────────────────────────────────────────
// GET /admin/message-templates → { templates: MessageTemplateView[] }.

let templateSeq = 0;
function demoTemplate(
  templateKey: string,
  channel: "email" | "sms" | "voice" | "push",
  subject: string | null,
  bodyText: string,
  allowedVariables: string[],
) {
  templateSeq += 1;
  const n = templateSeq;
  return {
    id: `00000000-0000-4000-8000-0000000010${String(n).padStart(2, "0")}`,
    templateKey,
    channel,
    subject,
    bodyHtml: channel === "email" ? `<p>${bodyText}</p>` : null,
    bodyText,
    allowedVariables,
    isActive: true,
    updatedAt: daysAgo(n + 2),
    updatedBy: null,
    createdAt: daysAgo(120),
    createdBy: null,
  };
}

function demoMessageTemplates() {
  return {
    templates: [
      demoTemplate(
        "resupply.reminder",
        "email",
        "Time to reorder your CPAP supplies, {{first_name}}",
        "Hi {{first_name}}, your resupply is due on {{due_date}}. Confirm: {{confirm_link}}",
        ["first_name", "due_date", "confirm_link"],
      ),
      demoTemplate(
        "resupply.reminder",
        "sms",
        null,
        "Hi {{first_name}}, your CPAP resupply is due {{due_date}}. Reply YES to confirm.",
        ["first_name", "due_date"],
      ),
      demoTemplate(
        "welcome.onboarding",
        "email",
        "Welcome to Penn Home Medical Supply",
        "Welcome {{first_name}}! Here's everything you need to get started with your therapy.",
        ["first_name"],
      ),
      demoTemplate(
        "order.shipped",
        "sms",
        null,
        "{{first_name}}, your order shipped — track it at {{tracking_url}}.",
        ["first_name", "tracking_url"],
      ),
    ],
  };
}

// ── Bulk campaigns ─────────────────────────────────────────────────
// GET /admin/bulk-campaigns → { campaigns: [...] }.

function demoBulkCampaigns() {
  return {
    campaigns: [
      {
        id: "00000000-0000-4000-8000-0000000020a1",
        name: "Spring mask cushion reorder",
        description: "Remind active patients to reorder cushions.",
        audienceKind: "all_active_patients",
        audiencePayer: null,
        audienceFilterSummary: null,
        channel: "email",
        category: "service",
        templateKey: "resupply.reminder",
        throttlePerMinute: 120,
        status: "completed",
        totalRecipients: 842,
        pendingRecipients: 0,
        suppressedCount: 37,
        sentCount: 805,
        failedCount: 0,
        createdAt: daysAgo(14),
        startedAt: daysAgo(14),
        completedAt: daysAgo(13),
        cancelledAt: null,
      },
      {
        id: "00000000-0000-4000-8000-0000000020a2",
        name: "Aetna PPO eligibility refresh",
        description: "Service notice to Aetna PPO patients.",
        audienceKind: "by_patient_payer",
        audiencePayer: "Aetna PPO",
        audienceFilterSummary: null,
        channel: "sms",
        category: "service",
        templateKey: "resupply.reminder",
        throttlePerMinute: 60,
        status: "draft",
        totalRecipients: 211,
        pendingRecipients: 198,
        suppressedCount: 13,
        sentCount: 0,
        failedCount: 0,
        createdAt: daysAgo(2),
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
      {
        id: "00000000-0000-4000-8000-0000000020a3",
        name: "Low-usage check-in",
        description: "Compliance outreach to at-risk patients.",
        audienceKind: "by_therapy_cohort",
        audiencePayer: "low_adherence",
        audienceFilterSummary: null,
        channel: "email",
        category: "compliance",
        templateKey: "welcome.onboarding",
        throttlePerMinute: 120,
        status: "sending",
        totalRecipients: 64,
        pendingRecipients: 22,
        suppressedCount: 2,
        sentCount: 40,
        failedCount: 0,
        createdAt: hoursAgo(6),
        startedAt: hoursAgo(5),
        completedAt: null,
        cancelledAt: null,
      },
    ],
  };
}

// ── Team ───────────────────────────────────────────────────────────
// GET /admin/team → { members: [...] }.

function demoTeam() {
  return {
    members: [
      {
        id: "00000000-0000-4000-8000-0000000030a1",
        email: "demo.admin@pennfit.example",
        authUserId: "demo-auth-1",
        role: "admin",
        status: "active",
        displayName: "Demo Admin",
        notes: null,
        invitedBy: null,
        invitedAt: daysAgo(180),
        acceptedAt: daysAgo(179),
        revokedAt: null,
        revokedBy: null,
        lastLoginAt: hoursAgo(3),
        locationId: null,
        expiryReminderSentAt: null,
        expiredNoticeSentAt: null,
      },
      {
        id: "00000000-0000-4000-8000-0000000030a2",
        email: "casey.csr@pennfit.example",
        authUserId: "demo-auth-2",
        role: "csr",
        status: "active",
        displayName: "Casey Sample",
        notes: "Handles inbound resupply confirmations.",
        invitedBy: "demo-auth-1",
        invitedAt: daysAgo(90),
        acceptedAt: daysAgo(89),
        revokedAt: null,
        revokedBy: null,
        lastLoginAt: hoursAgo(20),
        locationId: null,
        expiryReminderSentAt: null,
        expiredNoticeSentAt: null,
      },
      {
        id: "00000000-0000-4000-8000-0000000030a3",
        email: "morgan.rt@pennfit.example",
        authUserId: "demo-auth-3",
        role: "supervisor",
        status: "active",
        displayName: "Morgan Demo",
        notes: null,
        invitedBy: "demo-auth-1",
        invitedAt: daysAgo(60),
        acceptedAt: daysAgo(58),
        revokedAt: null,
        revokedBy: null,
        lastLoginAt: daysAgo(2),
        locationId: null,
        expiryReminderSentAt: null,
        expiredNoticeSentAt: null,
      },
      {
        id: "00000000-0000-4000-8000-0000000030a4",
        email: "riley.fitter@pennfit.example",
        authUserId: null,
        role: "fitter",
        status: "pending",
        displayName: "Riley Example",
        notes: null,
        invitedBy: "demo-auth-1",
        invitedAt: daysAgo(3),
        acceptedAt: null,
        revokedAt: null,
        revokedBy: null,
        lastLoginAt: null,
        locationId: null,
        expiryReminderSentAt: null,
        expiredNoticeSentAt: null,
      },
    ],
  };
}

// ── Storefront branding ────────────────────────────────────────────
// GET /admin/storefront-branding → viewOf() shape (tenant = PennPaps).

function demoStorefrontBranding() {
  return {
    storefrontName: "PennPaps",
    legalName: "Penn Home Medical Supply",
    tagline: "CPAP supplies, delivered on your schedule.",
    logoUrl: null,
    domain: {
      host: "pennpaps.com",
      status: "verified" as const,
      verifiedAt: daysAgo(45),
      instructions: null,
    },
  };
}

// ── MFA status ─────────────────────────────────────────────────────
// GET /admin/mfa/status → enrollment metadata (no secrets).

function demoMfaStatus() {
  return {
    enrolled: true,
    inProgressEnrollment: false,
    verifiedAt: daysAgo(120),
    lastUsedAt: hoursAgo(3),
    createdAt: daysAgo(120),
    recoveryCodesRemaining: 8,
    enforcementMode: "off" as const,
    mustEnroll: false,
    devices: [
      {
        id: "00000000-0000-4000-8000-0000000040a1",
        label: "iPhone — Authenticator",
        verifiedAt: daysAgo(120),
        lastUsedAt: hoursAgo(3),
        createdAt: daysAgo(120),
      },
    ],
  };
}

// ── Smart triggers (per-patient list) ──────────────────────────────
// GET /admin/patients/:id/smart-triggers → { events: [...] }.

function demoSmartTriggers() {
  return {
    events: [
      {
        id: "00000000-0000-4000-8000-0000000050a1",
        kind: "high_leak_streak",
        detectedAt: daysAgo(4),
        windowStartDate: daysAgo(11).slice(0, 10),
        windowEndDate: daysAgo(4).slice(0, 10),
        sentAt: daysAgo(4),
        dismissedAt: null,
        dismissedByEmail: null,
        dismissedReason: null,
        createdAt: daysAgo(4),
      },
      {
        id: "00000000-0000-4000-8000-0000000050a2",
        kind: "cushion_wear",
        detectedAt: daysAgo(20),
        windowStartDate: daysAgo(50).slice(0, 10),
        windowEndDate: daysAgo(20).slice(0, 10),
        sentAt: null,
        dismissedAt: daysAgo(18),
        dismissedByEmail: DEMO_OPERATOR_EMAIL,
        dismissedReason: "Patient already reordered.",
        createdAt: daysAgo(20),
      },
    ],
  };
}

// ── KPI metric alerts + thresholds ─────────────────────────────────
// GET /admin/metric-alerts → { alerts: [...] }
// GET /admin/metric-thresholds → { thresholds: [...] }

function demoMetricAlerts() {
  return {
    alerts: [
      {
        id: "00000000-0000-4000-8000-0000000060a1",
        thresholdId: "00000000-0000-4000-8000-0000000061a1",
        metricKey: "denial_rate",
        metricDate: daysAgo(1).slice(0, 10),
        observedValue: 0.142,
        comparedValue: 0.1,
        baselineValue: 0.095,
        severity: "warning",
        message: "Denial rate 14.2% exceeded the 10% threshold.",
        status: "open",
        notifiedAt: daysAgo(1),
        createdAt: daysAgo(1),
      },
      {
        id: "00000000-0000-4000-8000-0000000060a2",
        thresholdId: "00000000-0000-4000-8000-0000000061a2",
        metricKey: "resupply_confirmation_rate",
        metricDate: daysAgo(2).slice(0, 10),
        observedValue: 0.61,
        comparedValue: 0.7,
        baselineValue: 0.72,
        severity: "info",
        message: "Confirmation rate dipped to 61% (target 70%).",
        status: "open",
        notifiedAt: daysAgo(2),
        createdAt: daysAgo(2),
      },
    ],
  };
}

function demoMetricThresholds() {
  return {
    thresholds: [
      {
        id: "00000000-0000-4000-8000-0000000061a1",
        metricKey: "denial_rate",
        comparison: "gt",
        thresholdValue: 0.1,
        mode: "absolute",
        severity: "warning",
        enabled: true,
        description: "Alert when the daily denial rate exceeds 10%.",
        createdAt: daysAgo(200),
        updatedAt: daysAgo(30),
      },
      {
        id: "00000000-0000-4000-8000-0000000061a2",
        metricKey: "resupply_confirmation_rate",
        comparison: "lt",
        thresholdValue: 0.7,
        mode: "absolute",
        severity: "info",
        enabled: true,
        description: "Alert when resupply confirmation rate falls below 70%.",
        createdAt: daysAgo(200),
        updatedAt: daysAgo(60),
      },
      {
        id: "00000000-0000-4000-8000-0000000061a3",
        metricKey: "fulfillments_per_day",
        comparison: "lt",
        thresholdValue: 25,
        mode: "delta_pct_7d",
        severity: "critical",
        enabled: false,
        description:
          "Alert when daily fulfillments drop sharply week-over-week.",
        createdAt: daysAgo(150),
        updatedAt: daysAgo(150),
      },
    ],
  };
}

// ── Compliance rules (per-payer adherence thresholds) ──────────────
// GET /compliance-rules → { rules: [...] }.

function demoComplianceRules() {
  return {
    rules: [
      {
        id: "00000000-0000-4000-8000-0000000070a1",
        name: "Medicare standard adherence",
        priority: 10,
        matchInsurancePayer: "Medicare PA",
        minMinutes: 240,
        requiredNights: 21,
        windowDays: 30,
        active: true,
        notes: "CMS 4hr/night, 21 of 30 nights.",
        createdAt: daysAgo(220),
        updatedAt: daysAgo(40),
      },
      {
        id: "00000000-0000-4000-8000-0000000070a2",
        name: "Aetna PPO adherence",
        priority: 20,
        matchInsurancePayer: "Aetna PPO",
        minMinutes: 240,
        requiredNights: 21,
        windowDays: 30,
        active: true,
        notes: null,
        createdAt: daysAgo(220),
        updatedAt: daysAgo(90),
      },
      {
        id: "00000000-0000-4000-8000-0000000070a3",
        name: "Default fallback",
        priority: 100,
        matchInsurancePayer: null,
        minMinutes: 240,
        requiredNights: 21,
        windowDays: 30,
        active: true,
        notes: "Applies when no payer-specific rule matches.",
        createdAt: daysAgo(220),
        updatedAt: daysAgo(220),
      },
    ],
  };
}

// ── CSR compliance alerts ──────────────────────────────────────────
// GET /admin/csr-compliance-alerts → { alerts: [...] }.

function demoCsrComplianceAlerts() {
  return {
    alerts: [
      {
        id: "00000000-0000-4000-8000-0000000080a1",
        patientId: "demo-patient-4",
        patientFirstName: "Avery",
        journeyId: null,
        alertType: "low_usage",
        severity: "critical",
        summary: "Usage below 4 hrs/night for 7 consecutive nights.",
        metricSnapshot: { avgHours: 2.6, nights: 7 },
        status: "open",
        snoozedUntil: null,
        resolvedAt: null,
        resolvedByEmail: null,
        resolutionNote: null,
        createdAt: daysAgo(1),
      },
      {
        id: "00000000-0000-4000-8000-0000000080a2",
        patientId: "demo-patient-2",
        patientFirstName: "Casey",
        journeyId: null,
        alertType: "no_response",
        severity: "warning",
        summary: "No response to 3 resupply reminders.",
        metricSnapshot: { reminders: 3 },
        status: "open",
        snoozedUntil: null,
        resolvedAt: null,
        resolvedByEmail: null,
        resolutionNote: null,
        createdAt: daysAgo(3),
      },
      {
        id: "00000000-0000-4000-8000-0000000080a3",
        patientId: "demo-patient-6",
        patientFirstName: "Quinn",
        journeyId: null,
        alertType: "manual",
        severity: "info",
        summary: "Follow up on insurance change.",
        metricSnapshot: null,
        status: "open",
        snoozedUntil: null,
        resolvedAt: null,
        resolvedByEmail: null,
        resolutionNote: null,
        createdAt: daysAgo(5),
      },
    ],
  };
}

// ── Patient access log (Audit Trail) ───────────────────────────────
// GET /admin/patient-access-log → { rows, total, limit, offset, filters }.

function demoPatientAccessLog() {
  const rows = [
    {
      adminEmail: "casey.csr@pennfit.example",
      adminUserId: "demo-auth-2",
      adminRole: "csr",
      action: "view_patient",
      targetTable: "patients",
      patientId: "demo-patient-1",
      patientName: "Jordan Sample",
      statusCode: 200,
    },
    {
      adminEmail: "demo.admin@pennfit.example",
      adminUserId: "demo-auth-1",
      adminRole: "admin",
      action: "update_patient",
      targetTable: "patients",
      patientId: "demo-patient-3",
      patientName: "Morgan Example",
      statusCode: 200,
    },
    {
      adminEmail: "morgan.rt@pennfit.example",
      adminUserId: "demo-auth-3",
      adminRole: "supervisor",
      action: "view_patient",
      targetTable: "patients",
      patientId: "demo-patient-4",
      patientName: "Avery Tester",
      statusCode: 200,
    },
  ].map((r, i) => ({
    id: `00000000-0000-4000-8000-0000000090a${i + 1}`,
    occurredAt: hoursAgo(i * 4 + 1),
    adminEmail: r.adminEmail,
    adminUserId: r.adminUserId,
    adminRole: r.adminRole,
    action: r.action,
    method: "GET",
    path: `/resupply-api/patients/${r.patientId}`,
    targetTable: r.targetTable,
    targetId: r.patientId,
    patientId: r.patientId,
    patientName: r.patientName,
    statusCode: r.statusCode,
    ip: "203.0.113.10",
    userAgent: "Mozilla/5.0 (demo)",
    impersonatorUserId: null,
  }));
  return {
    rows,
    total: rows.length,
    limit: 100,
    offset: 0,
    filters: {
      from: null,
      to: null,
      adminEmail: null,
      adminUserId: null,
      patientId: null,
      targetTable: null,
      action: null,
    },
  };
}

// ── Tenant System Configuration (app-config) ───────────────────────
// GET /admin/system/config → { categories, overlayDisabled, ... }.
// Surfaces tenant-scoped settings; the seed tenant keeps its
// PennBot/PennPilot assistant names.

function demoConfigSetting(
  key: string,
  label: string,
  value: string | null,
  options: { secret?: boolean; updated?: boolean } = {},
) {
  return {
    key,
    label,
    description: null,
    secret: options.secret ?? false,
    // Secrets are masked on the wire; non-secrets show their value.
    value: options.secret && value ? "••••••••" : value,
    hasValue: value != null,
    source: value != null ? ("db" as const) : ("env" as const),
    updatedByEmail: options.updated ? DEMO_OPERATOR_EMAIL : null,
    updatedAt: options.updated ? daysAgo(10) : null,
  };
}

function demoSystemConfig() {
  return {
    categories: [
      {
        category: "Assistant names",
        settings: [
          demoConfigSetting(
            "RESUPPLY_ASSISTANT_STOREFRONT_NAME",
            "Storefront chatbot name",
            "PennBot",
            { updated: true },
          ),
          demoConfigSetting(
            "RESUPPLY_ASSISTANT_ADMIN_NAME",
            "Admin assistant name",
            "PennPilot",
            { updated: true },
          ),
        ],
      },
      {
        category: "Therapy-cloud integrations",
        settings: [
          demoConfigSetting(
            "RESMED_AIRVIEW_USERNAME",
            "ResMed AirView username",
            "pennpaps-airview",
          ),
          demoConfigSetting(
            "RESMED_AIRVIEW_PASSWORD",
            "ResMed AirView password",
            "set-in-demo",
            { secret: true },
          ),
          demoConfigSetting(
            "PHILIPS_CARE_ORCHESTRATOR_API_KEY",
            "Philips Care Orchestrator API key",
            null,
            { secret: true },
          ),
        ],
      },
      {
        category: "Clearinghouse",
        settings: [
          demoConfigSetting(
            "OFFICE_ALLY_SFTP_USERNAME",
            "Office Ally SFTP username",
            "pennpaps-oa",
          ),
          demoConfigSetting(
            "OFFICE_ALLY_SFTP_PASSWORD",
            "Office Ally SFTP password",
            "set-in-demo",
            { secret: true },
          ),
        ],
      },
    ],
    overlayDisabled: false,
    webhookReference: null,
    twilioWebhooks: null,
  };
}

function demoSystemConfigActivity() {
  return {
    activity: [
      {
        occurredAt: daysAgo(10),
        operatorEmail: DEMO_OPERATOR_EMAIL,
        key: "RESUPPLY_ASSISTANT_ADMIN_NAME",
        label: "Admin assistant name",
        category: "Assistant names",
        action: "set",
        hadPrevious: true,
      },
      {
        occurredAt: daysAgo(40),
        operatorEmail: DEMO_OPERATOR_EMAIL,
        key: "RESMED_AIRVIEW_USERNAME",
        label: "ResMed AirView username",
        category: "Therapy-cloud integrations",
        action: "set",
        hadPrevious: false,
      },
    ],
  };
}

// ── Tenant email + phone sender settings ───────────────────────────
// GET/PATCH /admin/organization/email-settings → viewOf() shape.
// GET/PATCH/POST /admin/organization/phone-settings → viewOf() shape.

function demoEmailSettings(overrides?: {
  fromEmail?: string | null;
  fromName?: string | null;
}) {
  const fromEmail =
    overrides && "fromEmail" in overrides
      ? (overrides.fromEmail ?? null)
      : "info@pennpaps.com";
  const fromName =
    overrides && "fromName" in overrides
      ? (overrides.fromName ?? null)
      : "Penn Home Medical Supply";
  return {
    fromEmail,
    fromName,
    platformDefaultEmail: "noreply@cmbreathe.com",
    platformDefaultName: "CareMetric Breathe",
    domainAuth: fromEmail
      ? {
          status: "verified" as const,
          detail: "Sending domain is authenticated (SPF/DKIM) in SendGrid.",
        }
      : {
          status: "unknown" as const,
          detail:
            "Using the platform default sender. Set your own From address to brand outbound email.",
        },
  };
}

function demoPhoneSettings(overrides?: {
  voiceNumber?: string | null;
  smsNumber?: string | null;
  messagingServiceSid?: string | null;
}) {
  return {
    voiceNumber:
      overrides && "voiceNumber" in overrides
        ? (overrides.voiceNumber ?? null)
        : "+12155550100",
    smsNumber:
      overrides && "smsNumber" in overrides
        ? (overrides.smsNumber ?? null)
        : "+12155550100",
    messagingServiceSid:
      overrides && "messagingServiceSid" in overrides
        ? (overrides.messagingServiceSid ?? null)
        : null,
    canProvision: true,
  };
}

export const settingsHandlers: DemoHandler[] = [
  // ── Feature flags (Control Center) ───────────────────────────────
  route("GET", "/resupply-api/admin/feature-flags", () =>
    json(demoFeatureFlags()),
  ),
  route("GET", "/resupply-api/admin/feature-flags/activity", () =>
    json(demoFeatureFlagActivity()),
  ),
  // Toggle echoes the new state so the switch appears to work.
  route("PATCH", "/resupply-api/admin/feature-flags/:key", (req, { key }) => {
    const body = req.json<{ enabled?: boolean }>() ?? {};
    return json(demoToggleFlag(key, body.enabled ?? true));
  }),

  // ── Alert library ────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/alerts", () => json(demoAlerts())),

  // ── Message templates ────────────────────────────────────────────
  route("GET", "/resupply-api/admin/message-templates", () =>
    json(demoMessageTemplates()),
  ),

  // ── Bulk campaigns ───────────────────────────────────────────────
  route("GET", "/resupply-api/admin/bulk-campaigns", () =>
    json(demoBulkCampaigns()),
  ),

  // ── Team ─────────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/team", () => json(demoTeam())),

  // ── Storefront branding ──────────────────────────────────────────
  route("GET", "/resupply-api/admin/storefront-branding", () =>
    json(demoStorefrontBranding()),
  ),

  // ── MFA status ───────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/mfa/status", () => json(demoMfaStatus())),

  // ── Smart triggers (per-patient list) ────────────────────────────
  route("GET", "/resupply-api/admin/patients/:id/smart-triggers", () =>
    json(demoSmartTriggers()),
  ),

  // ── KPI metric alerts + thresholds ───────────────────────────────
  route("GET", "/resupply-api/admin/metric-alerts", () =>
    json(demoMetricAlerts()),
  ),
  // Acknowledge/resolve echoes the new status so the action appears to work.
  route("PATCH", "/resupply-api/admin/metric-alerts/:id", (req, { id }) => {
    const body = req.json<{ status?: string }>() ?? {};
    return json({ id, status: body.status ?? "acknowledged" });
  }),
  route("GET", "/resupply-api/admin/metric-thresholds", () =>
    json(demoMetricThresholds()),
  ),

  // ── Compliance rules ─────────────────────────────────────────────
  route("GET", "/resupply-api/compliance-rules", () =>
    json(demoComplianceRules()),
  ),

  // ── CSR compliance alerts ────────────────────────────────────────
  route("GET", "/resupply-api/admin/csr-compliance-alerts", () =>
    json(demoCsrComplianceAlerts()),
  ),
  // Resolve/snooze/reopen echoes the next status.
  route(
    "PATCH",
    "/resupply-api/admin/csr-compliance-alerts/:id",
    (req, { id }) => {
      const body = req.json<{ action?: string }>() ?? {};
      const status =
        body.action === "resolve"
          ? "resolved"
          : body.action === "snooze"
            ? "snoozed"
            : "open";
      return json({ id, status });
    },
  ),

  // ── Patient access log (Audit Trail) ─────────────────────────────
  route("GET", "/resupply-api/admin/patient-access-log", () =>
    json(demoPatientAccessLog()),
  ),

  // ── Tenant System Configuration ──────────────────────────────────
  route("GET", "/resupply-api/admin/system/config", () =>
    json(demoSystemConfig()),
  ),
  route("GET", "/resupply-api/admin/system/config/activity", () =>
    json(demoSystemConfigActivity()),
  ),

  // ── Tenant email sender settings ─────────────────────────────────
  route("GET", "/resupply-api/admin/organization/email-settings", () =>
    json(demoEmailSettings()),
  ),
  route("PATCH", "/resupply-api/admin/organization/email-settings", (req) => {
    const body =
      req.json<{ fromEmail?: string | null; fromName?: string | null }>() ?? {};
    return json(demoEmailSettings(body));
  }),

  // ── Tenant phone sender settings ─────────────────────────────────
  route("GET", "/resupply-api/admin/organization/phone-settings", () =>
    json(demoPhoneSettings()),
  ),
  route("PATCH", "/resupply-api/admin/organization/phone-settings", (req) => {
    const body =
      req.json<{
        voiceNumber?: string | null;
        smsNumber?: string | null;
        messagingServiceSid?: string | null;
      }>() ?? {};
    return json(demoPhoneSettings(body));
  }),
];
