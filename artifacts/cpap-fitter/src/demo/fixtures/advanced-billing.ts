// Seeded demo data for the ADVANCED BILLING admin pages — the deeper
// revenue-cycle surfaces beyond the core claims workflow already seeded
// in fixtures/billing-claims.ts (eligibility-recent / era / denials /
// auto-submit / statements). These cover: claim-status (276/277),
// chargeback disputes, secondary/COB, payment plans, timely-filing,
// payer fee schedules, payer modifier rules, the AI billing queue, the
// cross-worklist action queue, denial-code catalog, eligibility
// re-verification worklist, Good Faith Estimates, PECOS enrollment, DWO
// renewals, claim appeal letters, and the collections forecast.
//
// Every shape mirrors the live route's `res.json({...})` exactly (incl.
// nested keys + array element fields) so the SPA pages render real data
// instead of empty states or crashing the admin error boundary on a
// missing nested field. Tenant is Penn Home Medical Supply on the
// CareMetric Breathe platform; all names/payers/ids are obviously
// fictional and money is integer cents in realistic DME amounts.

import { daysAgo, daysFromNow, dateOnly, NOW_ISO } from "./dates";

// ── claim-status.ts — GET .../insurance-claims/:claimId/status-checks ──
// res.json({ statusChecks: [...] }) — rows selected as id/status/outcome/
// category_code/status_code/total_charge_cents/total_paid_cents/
// requested_at/responded_at/error_message.
export function demoClaimStatusChecks() {
  return {
    statusChecks: [
      {
        id: "demo-csc-1",
        status: "parsed",
        outcome: "finalized_paid",
        category_code: "F1",
        status_code: "1",
        total_charge_cents: 86_400,
        total_paid_cents: 69_120,
        requested_at: daysAgo(4),
        responded_at: daysAgo(3),
        error_message: null,
      },
      {
        id: "demo-csc-2",
        status: "parsed",
        outcome: "pending",
        category_code: "A2",
        status_code: "20",
        total_charge_cents: 86_400,
        total_paid_cents: 0,
        requested_at: daysAgo(8),
        responded_at: daysAgo(8),
        error_message: null,
      },
      {
        id: "demo-csc-3",
        status: "rejected",
        outcome: null,
        category_code: null,
        status_code: null,
        total_charge_cents: null,
        total_paid_cents: null,
        requested_at: daysAgo(10),
        responded_at: daysAgo(10),
        error_message: "AAA*79 — invalid participant identification",
      },
    ],
  };
}

// POST .../status-check → 201 { id, uploadOk, errorMessage }.
export function demoClaimStatusCheckSubmit() {
  return {
    id: "demo-csc-new",
    uploadOk: true,
    errorMessage: null,
  };
}

// ── billing-disputes.ts — GET /admin/billing/disputes ──
// res.json({ disputes: [...] }) — rows: id/stripe_dispute_id/
// stripe_charge_id/order_id/amount_cents/currency/reason/status/
// evidence_due_by/opened_at/closed_at/outcome.
export function demoBillingDisputes(status?: string | null) {
  const disputes = [
    {
      id: "demo-dispute-1",
      stripe_dispute_id: "dp_demo_001",
      stripe_charge_id: "ch_demo_8841",
      order_id: "demo-order-512",
      amount_cents: 14_900,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      evidence_due_by: daysFromNow(5),
      opened_at: daysAgo(2),
      closed_at: null,
      outcome: null,
    },
    {
      id: "demo-dispute-2",
      stripe_dispute_id: "dp_demo_002",
      stripe_charge_id: "ch_demo_9120",
      order_id: "demo-order-489",
      amount_cents: 4_350,
      currency: "usd",
      reason: "product_not_received",
      status: "under_review",
      evidence_due_by: daysFromNow(11),
      opened_at: daysAgo(6),
      closed_at: null,
      outcome: null,
    },
    {
      id: "demo-dispute-3",
      stripe_dispute_id: "dp_demo_003",
      stripe_charge_id: "ch_demo_7733",
      order_id: "demo-order-401",
      amount_cents: 9_900,
      currency: "usd",
      reason: "duplicate",
      status: "won",
      evidence_due_by: null,
      opened_at: daysAgo(40),
      closed_at: daysAgo(18),
      outcome: "won",
    },
  ];
  const open = disputes.filter((d) => d.closed_at === null);
  return { disputes: status === "all" ? disputes : open };
}

// ── secondary-claims.ts — GET /admin/billing/secondary-eligible ──
// res.json({ eligible: EligibleItem[], count }) — EligibleItem:
// claimId/patientId/primaryPayerName/billedCents/primaryPaidCents/
// patientResponsibilityCents (sorted by balance desc).
export function demoSecondaryEligible() {
  const eligible = [
    {
      claimId: "demo-claim-101",
      patientId: "demo-patient-2",
      primaryPayerName: "Sample Medicare",
      billedCents: 86_400,
      primaryPaidCents: 69_120,
      patientResponsibilityCents: 17_280,
    },
    {
      claimId: "demo-claim-117",
      patientId: "demo-patient-7",
      primaryPayerName: "Sample Medicare",
      billedCents: 42_000,
      primaryPaidCents: 33_600,
      patientResponsibilityCents: 8_400,
    },
    {
      claimId: "demo-claim-123",
      patientId: "demo-patient-3",
      primaryPayerName: "Acme Health Demo",
      billedCents: 21_500,
      primaryPaidCents: 17_200,
      patientResponsibilityCents: 4_300,
    },
  ];
  return { eligible, count: eligible.length };
}

// POST /admin/claims/:id/generate-secondary → 201
// { secondaryClaimId, cob, lineCount }. The SecondaryCob shape carries
// the snapshot amounts the COB loop needs.
export function demoGenerateSecondary() {
  return {
    secondaryClaimId: "demo-claim-secondary-1",
    cob: {
      primaryPaidCents: 69_120,
      primaryAllowedCents: 86_400,
      primaryContractualCents: 17_280,
      patientRespCents: 17_280,
    },
    lineCount: 2,
  };
}

// ── payment-plans.ts ──
// POST /admin/patients/payment-plans/list → res.json({ plans: [...] })
// each plan is the row + { summary: PlanSummary | null }.
export function demoPaymentPlansList() {
  return {
    plans: [
      {
        id: "demo-plan-1",
        total_amount_cents: 36_000,
        installment_count: 6,
        frequency: "monthly",
        start_date: dateOnly(-60),
        status: "active",
        note: "Cash-pay balance after Medicare adjudication.",
        created_at: daysAgo(60),
        autopay_status: "authorized",
        autopay_authorized_at: daysAgo(58),
        summary: {
          paidCents: 12_000,
          remainingCents: 24_000,
          overdueCount: 0,
          overdueCents: 0,
          nextDueDate: dateOnly(5),
        },
      },
      {
        id: "demo-plan-2",
        total_amount_cents: 18_000,
        installment_count: 4,
        frequency: "monthly",
        start_date: dateOnly(-95),
        status: "active",
        note: null,
        created_at: daysAgo(95),
        autopay_status: "off",
        autopay_authorized_at: null,
        summary: {
          paidCents: 9_000,
          remainingCents: 9_000,
          overdueCount: 1,
          overdueCents: 4_500,
          nextDueDate: dateOnly(-3),
        },
      },
    ],
  };
}

// GET /admin/payment-plans/:id → { plan, installments, summary }.
export function demoPaymentPlanDetail(id: string) {
  const installments = [
    {
      id: "demo-inst-1",
      seq: 1,
      due_date: dateOnly(-60),
      amount_cents: 6_000,
      status: "paid",
      paid_at: daysAgo(60),
      patient_payment_id: "demo-pay-1",
    },
    {
      id: "demo-inst-2",
      seq: 2,
      due_date: dateOnly(-30),
      amount_cents: 6_000,
      status: "paid",
      paid_at: daysAgo(30),
      patient_payment_id: "demo-pay-2",
    },
    {
      id: "demo-inst-3",
      seq: 3,
      due_date: dateOnly(5),
      amount_cents: 6_000,
      status: "scheduled",
      paid_at: null,
      patient_payment_id: null,
    },
    {
      id: "demo-inst-4",
      seq: 4,
      due_date: dateOnly(35),
      amount_cents: 6_000,
      status: "scheduled",
      paid_at: null,
      patient_payment_id: null,
    },
    {
      id: "demo-inst-5",
      seq: 5,
      due_date: dateOnly(65),
      amount_cents: 6_000,
      status: "scheduled",
      paid_at: null,
      patient_payment_id: null,
    },
    {
      id: "demo-inst-6",
      seq: 6,
      due_date: dateOnly(95),
      amount_cents: 6_000,
      status: "scheduled",
      paid_at: null,
      patient_payment_id: null,
    },
  ];
  return {
    plan: {
      id,
      patient_id: "demo-patient-2",
      total_amount_cents: 36_000,
      installment_count: 6,
      frequency: "monthly",
      start_date: dateOnly(-60),
      status: "active",
      note: "Cash-pay balance after Medicare adjudication.",
      created_at: daysAgo(60),
      updated_at: daysAgo(30),
      autopay_status: "authorized",
      autopay_authorized_at: daysAgo(58),
    },
    installments,
    summary: {
      paidCents: 12_000,
      remainingCents: 24_000,
      overdueCount: 0,
      overdueCents: 0,
      nextDueDate: dateOnly(5),
    },
  };
}

// ── billing-timely-filing.ts — GET /admin/billing/timely-filing ──
// res.json({ claims: TimelyFilingClaimRow[], counts, generatedAt }).
export function demoTimelyFiling(status?: string | null) {
  const claims = [
    {
      id: "demo-claim-201",
      patientId: "demo-patient-1",
      payerName: "Sample Medicare",
      status: "rejected",
      dateOfService: dateOnly(-350),
      totalBilledCents: 86_400,
      filingStatus: "overdue" as const,
      daysRemaining: -5,
      deadline: dateOnly(-5),
    },
    {
      id: "demo-claim-202",
      patientId: "demo-patient-4",
      payerName: "Acme Health Demo",
      status: "denied",
      dateOfService: dateOnly(-80),
      totalBilledCents: 42_000,
      filingStatus: "due_soon" as const,
      daysRemaining: 10,
      deadline: dateOnly(10),
    },
    {
      id: "demo-claim-203",
      patientId: "demo-patient-6",
      payerName: "Sample Medicare",
      status: "submitted",
      dateOfService: dateOnly(-20),
      totalBilledCents: 21_500,
      filingStatus: "ok" as const,
      daysRemaining: 345,
      deadline: dateOnly(345),
    },
    {
      id: "demo-claim-204",
      patientId: "demo-patient-9",
      payerName: "Placeholder Mutual",
      status: "draft",
      dateOfService: dateOnly(-15),
      totalBilledCents: 12_950,
      filingStatus: "unknown" as const,
      daysRemaining: null,
      deadline: null,
    },
  ];
  const counts = { overdue: 1, dueSoon: 1, ok: 1, unknown: 1, total: 4 };
  const filtered =
    status && status !== "all"
      ? claims.filter((c) => c.filingStatus === status)
      : claims;
  return { claims: filtered, counts, generatedAt: NOW_ISO() };
}

// ── payer-fee-schedules.ts — GET /admin/payer-fee-schedules ──
// res.json({ feeSchedules: [...] }) via rowToApi (camelCase).
export function demoPayerFeeSchedules() {
  return {
    feeSchedules: [
      {
        id: "demo-fee-1",
        payerProfileId: "demo-payer-1",
        hcpcsCode: "E0601",
        modifier: "RR",
        allowedCents: 9_543,
        effectiveFrom: dateOnly(-180),
        effectiveThrough: null,
        source: "cms_published",
        notes: "CMS DMEPOS 2026 ceiling — CPAP rental.",
        createdAt: daysAgo(180),
        updatedAt: daysAgo(180),
      },
      {
        id: "demo-fee-2",
        payerProfileId: "demo-payer-1",
        hcpcsCode: "A7030",
        modifier: null,
        allowedCents: 6_212,
        effectiveFrom: dateOnly(-180),
        effectiveThrough: null,
        source: "cms_published",
        notes: "Full face mask.",
        createdAt: daysAgo(180),
        updatedAt: daysAgo(180),
      },
      {
        id: "demo-fee-3",
        payerProfileId: "demo-payer-2",
        hcpcsCode: "A7034",
        modifier: null,
        allowedCents: 3_088,
        effectiveFrom: dateOnly(-90),
        effectiveThrough: null,
        source: "payer_published",
        notes: "Nasal interface — Acme Health negotiated rate.",
        createdAt: daysAgo(90),
        updatedAt: daysAgo(30),
      },
    ],
  };
}

// ── payer-modifier-rules.ts — GET /admin/payer-modifier-rules ──
// res.json({ rules: [...] }) via rowToApi (camelCase).
export function demoPayerModifierRules() {
  return {
    rules: [
      {
        id: "demo-mod-1",
        payerProfileId: "demo-payer-1",
        hcpcsCode: "E0601",
        condition: "if_rental_month_le_3",
        modifiersCsv: "RR,KH",
        priority: 10,
        rationale: "Months 1–3 of capped rental — first-month modifier.",
        isActive: true,
        createdAt: daysAgo(200),
        updatedAt: daysAgo(200),
      },
      {
        id: "demo-mod-2",
        payerProfileId: "demo-payer-1",
        hcpcsCode: "E0601",
        condition: "if_rental_month_ge_4",
        modifiersCsv: "RR,KI",
        priority: 20,
        rationale: "Months 4+ of capped rental.",
        isActive: true,
        createdAt: daysAgo(200),
        updatedAt: daysAgo(200),
      },
      {
        id: "demo-mod-3",
        payerProfileId: "demo-payer-1",
        hcpcsCode: "A7030",
        condition: "if_compliant_90day",
        modifiersCsv: "KX",
        priority: 30,
        rationale: "Continued use documented past the 90-day window.",
        isActive: true,
        createdAt: daysAgo(150),
        updatedAt: daysAgo(20),
      },
    ],
  };
}

// ── ai-billing-queue.ts — GET /admin/billing/ai-queue ──
// Mirrors aiBillingQueueResponseSchema exactly.
export function demoAiBillingQueue() {
  const scrubBlockingClaims = [
    {
      id: "demo-claim-301",
      patientId: "demo-patient-1",
      payerName: "Sample Medicare",
      totalBilledCents: 86_400,
      latestScrubAt: daysAgo(1),
      latestScrubResultId: "demo-scrub-1",
    },
  ];
  const scrubFixableClaims = [
    {
      id: "demo-claim-302",
      patientId: "demo-patient-3",
      payerName: "Acme Health Demo",
      totalBilledCents: 42_000,
      latestScrubAt: daysAgo(2),
      latestScrubResultId: "demo-scrub-2",
    },
    {
      id: "demo-claim-303",
      patientId: "demo-patient-5",
      payerName: "Sample Medicare",
      totalBilledCents: 12_950,
      latestScrubAt: daysAgo(2),
      latestScrubResultId: "demo-scrub-3",
    },
  ];
  const deniedNeedsAnalysis = [
    {
      id: "demo-claim-304",
      patientId: "demo-patient-8",
      payerName: "Placeholder Mutual",
      totalBilledCents: 21_500,
      decisionAt: daysAgo(3),
      denialReason: "CARC 16 — claim/service lacks information; RARC N130",
    },
  ];
  const autoResubmitReady = [
    {
      analysisId: "demo-analysis-1",
      claimId: "demo-claim-305",
      patientId: "demo-patient-2",
      recommendation: "auto_resubmit",
      confidence: 0.91,
      rootCauseSummary: "Missing KX modifier; resubmit with KX appended.",
      createdAt: daysAgo(1),
    },
  ];
  return {
    scrubBlockingClaims,
    scrubFixableClaims,
    deniedNeedsAnalysis,
    autoResubmitReady,
    counts: {
      scrubBlocking: scrubBlockingClaims.length,
      scrubFixable: scrubFixableClaims.length,
      deniedNeedsAnalysis: deniedNeedsAnalysis.length,
      autoResubmitReady: autoResubmitReady.length,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── billing-action-queue.ts — GET /admin/billing/action-queue ──
// res.json({ denials: { byAction, totals }, secondaryEligible, generatedAt }).
export function demoBillingActionQueue() {
  const bucket = (
    count: number,
    recoverableCents: number,
    expectedRecoverableCents: number,
  ) => ({ count, recoverableCents, expectedRecoverableCents });
  return {
    denials: {
      byAction: {
        auto_resubmit: bucket(2, 91_200, 82_080),
        manual_resubmit: bucket(1, 42_000, 25_200),
        appeal: bucket(2, 64_900, 35_695),
        bill_patient: bucket(1, 9_900, 6_930),
        write_off: bucket(0, 0, 0),
        manual_review: bucket(1, 12_950, 3_885),
        unclassified: bucket(1, 8_400, 2_520),
      },
      totals: {
        count: 8,
        recoverableCents: 229_350,
        expectedRecoverableCents: 156_310,
        autoResubmittable: 2,
        unanalyzed: 1,
      },
    },
    secondaryEligible: {
      count: 3,
      billableCents: 29_980,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── denial-codes.ts — GET /admin/denial-codes ──
// res.json({ denialCodes: [...] }) via rowToApi (camelCase).
export function demoDenialCodes() {
  return {
    denialCodes: [
      {
        id: "demo-dc-1",
        codeSystem: "carc",
        code: "16",
        description: "Claim/service lacks information or has a billing error.",
        category: "documentation",
        recommendedAction:
          "Add the missing element (often a modifier or NPI) and resubmit.",
        isTerminal: false,
        createdAt: daysAgo(400),
        updatedAt: daysAgo(400),
      },
      {
        id: "demo-dc-2",
        codeSystem: "carc",
        code: "50",
        description:
          "These are non-covered services because this is not deemed a medical necessity.",
        category: "medical_necessity",
        recommendedAction: "Appeal with chart notes + sleep study.",
        isTerminal: false,
        createdAt: daysAgo(400),
        updatedAt: daysAgo(400),
      },
      {
        id: "demo-dc-3",
        codeSystem: "carc",
        code: "29",
        description: "The time limit for filing has expired.",
        category: "timely_filing",
        recommendedAction: "No appeal — write off; tighten the filing cadence.",
        isTerminal: true,
        createdAt: daysAgo(400),
        updatedAt: daysAgo(400),
      },
      {
        id: "demo-dc-4",
        codeSystem: "rarc",
        code: "N130",
        description:
          "Consult plan benefit documents/guidelines for information about restrictions.",
        category: "coverage_limit",
        recommendedAction: null,
        isTerminal: false,
        createdAt: daysAgo(400),
        updatedAt: daysAgo(400),
      },
    ],
  };
}

// ── eligibility-verification-worklist.ts ──
// res.json({ staleDays, items: VerificationWorkItem[], counts, generatedAt }).
export function demoEligibilityVerificationWorklist() {
  const items = [
    {
      id: "demo-cov-1",
      patientId: "demo-patient-4",
      rank: "primary",
      payerName: "Acme Health Demo",
      memberIdTail: "8842",
      verifiedAt: daysAgo(58),
      terminationDate: dateOnly(12),
      status: "terminating_soon" as const,
      daysSinceVerified: 58,
      daysUntilTermination: 12,
      priority: 3,
    },
    {
      id: "demo-cov-2",
      patientId: "demo-patient-7",
      rank: "primary",
      payerName: "Sample Medicare",
      memberIdTail: "1190",
      verifiedAt: null,
      terminationDate: null,
      status: "never_verified" as const,
      daysSinceVerified: null,
      daysUntilTermination: null,
      priority: 2,
    },
    {
      id: "demo-cov-3",
      patientId: "demo-patient-2",
      rank: "secondary",
      payerName: "Placeholder Mutual",
      memberIdTail: "5503",
      verifiedAt: daysAgo(74),
      terminationDate: null,
      status: "stale" as const,
      daysSinceVerified: 74,
      daysUntilTermination: null,
      priority: 1,
    },
  ];
  return {
    staleDays: 30,
    items,
    counts: {
      neverVerified: 1,
      terminatingSoon: 1,
      stale: 1,
      ok: 0,
      total: 3,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── good-faith-estimates.ts — GET /admin/good-faith-estimates ──
// res.json({ estimates: [...] }) — raw rows (snake_case).
export function demoGoodFaithEstimates() {
  return {
    estimates: [
      {
        id: "demo-gfe-1",
        customer_id: "demo-customer-1",
        recipient_name: "Dana Sampleton",
        recipient_email: "dana.demo@example.com",
        items_json: [
          {
            description: "CPAP machine (cash-pay)",
            hcpcsCode: "E0601",
            quantity: 1,
            unitPriceCents: 79_900,
          },
          {
            description: "Full face mask",
            hcpcsCode: "A7030",
            quantity: 1,
            unitPriceCents: 12_900,
          },
        ],
        total_cents: 92_800,
        expected_service_date: dateOnly(7),
        delivery_method: "email",
        delivered_at: daysAgo(2),
        generated_by_email: "billing@pennpaps.com",
        created_at: daysAgo(2),
      },
      {
        id: "demo-gfe-2",
        customer_id: null,
        recipient_name: "Riley Placeholder",
        recipient_email: "riley.demo@example.com",
        items_json: [
          {
            description: "Auto-CPAP machine (cash-pay)",
            hcpcsCode: "E0601",
            quantity: 1,
            unitPriceCents: 84_900,
          },
        ],
        total_cents: 84_900,
        expected_service_date: dateOnly(14),
        delivery_method: null,
        delivered_at: null,
        generated_by_email: "billing@pennpaps.com",
        created_at: daysAgo(5),
      },
    ],
  };
}

// ── pecos-status.ts — GET /admin/providers-pecos ──
// res.json({ rows: [...] }) — npi/enrollment_status/enrollment_type/
// first_approved_date/specialty_description/last_synced_at.
export function demoPecosStatus() {
  return {
    rows: [
      {
        npi: "1700000001",
        enrollment_status: "approved",
        enrollment_type: "individual",
        first_approved_date: dateOnly(-1400),
        specialty_description: "Sleep Medicine",
        last_synced_at: daysAgo(1),
      },
      {
        npi: "1700000002",
        enrollment_status: "approved",
        enrollment_type: "individual",
        first_approved_date: dateOnly(-980),
        specialty_description: "Pulmonary Disease",
        last_synced_at: daysAgo(2),
      },
      {
        npi: "1700000003",
        enrollment_status: "not_found",
        enrollment_type: null,
        first_approved_date: null,
        specialty_description: null,
        last_synced_at: daysAgo(9),
      },
    ],
  };
}

// ── dwo-documents.ts — GET /admin/dwo-documents/expiring ──
// res.json({ documents: (row + { expiry }) [...] }).
export function demoDwoExpiring() {
  return {
    documents: [
      {
        id: "demo-dwo-1",
        patient_id: "demo-patient-1",
        hcpcs_family: "pap",
        form_type: "swo",
        signing_provider_id: "demo-provider-1",
        signed_on: dateOnly(-330),
        expires_on: dateOnly(20),
        document_object_key: null,
        notes: "Annual standard written order for CPAP.",
        created_at: daysAgo(330),
        updated_at: daysAgo(330),
        expiry: {
          state: "expiring_soon",
          severity: "warning",
          daysOut: 20,
          window: 30,
        },
      },
      {
        id: "demo-dwo-2",
        patient_id: "demo-patient-5",
        hcpcs_family: "oxygen",
        form_type: "cmn_484",
        signing_provider_id: "demo-provider-2",
        signed_on: dateOnly(-340),
        expires_on: dateOnly(52),
        document_object_key: null,
        notes: null,
        created_at: daysAgo(340),
        updated_at: daysAgo(340),
        expiry: {
          state: "expiring_soon",
          severity: "info",
          daysOut: 52,
          window: 60,
        },
      },
    ],
  };
}

// ── claim-appeals.ts — GET .../insurance-claims/:claimId/appeal-letter ──
// res.json({ appealLetters: [...] }) — raw claim_appeal_letters rows.
export function demoClaimAppealLetters() {
  return {
    appealLetters: [
      {
        id: "demo-appeal-1",
        claim_id: "demo-claim-44",
        denial_analysis_id: "demo-analysis-9",
        letter_body:
          "We respectfully request reconsideration of the above claim, denied for medical necessity (CARC 50). Enclosed are the sleep study and treating-physician notes establishing the medical necessity of PAP therapy for this patient.",
        delivery_method: "fax",
        delivered_at: daysAgo(6),
        responded_at: null,
        outcome: null,
        generated_by_email: "billing@pennpaps.com",
        created_at: daysAgo(7),
      },
    ],
  };
}

// GET .../denial-sketch → { denialAnalysisId, recommendation, sketch }.
export function demoClaimDenialSketch() {
  return {
    denialAnalysisId: "demo-analysis-9",
    recommendation: "appeal",
    sketch:
      "Appeal CARC 50 (medical necessity). Cite the in-lab sleep study (AHI 32) and the treating physician's order. Attach the 90-day compliance download.",
  };
}

// ── billing-collections-forecast.ts ──
// GET /admin/billing/collections-forecast → CollectionsForecast.
export function demoCollectionsForecast() {
  return {
    horizons: [
      {
        label: "≤30 days",
        withinDays: 30,
        expectedCents: 184_500,
        claimCount: 12,
      },
      {
        label: "31–60 days",
        withinDays: 60,
        expectedCents: 96_300,
        claimCount: 7,
      },
      {
        label: "61–90 days",
        withinDays: 90,
        expectedCents: 41_250,
        claimCount: 4,
      },
      {
        label: ">90 days",
        withinDays: Number.POSITIVE_INFINITY,
        expectedCents: 18_900,
        claimCount: 2,
      },
    ],
    totalExpectedCents: 340_950,
    outstandingClaimCount: 25,
    grossExpectedCents: 340_950,
    assumptions: {
      expectedDaysToPay: 45,
      defaultAllowedRatio: 0.5,
      collectionProbability: 0.95,
      asOf: NOW_ISO(),
    },
  };
}

// GET /admin/billing/forward-order-book → ForwardOrderBook (companion
// projection on the same page family). Tunable assumptions echoed back.
export function demoForwardOrderBook() {
  return {
    horizons: [
      {
        label: "≤30 days",
        withinDays: 30,
        expectedCents: 142_000,
        dueCount: 38,
      },
      {
        label: "31–60 days",
        withinDays: 60,
        expectedCents: 98_500,
        dueCount: 26,
      },
      {
        label: "61–90 days",
        withinDays: 90,
        expectedCents: 61_000,
        dueCount: 17,
      },
    ],
    totalExpectedCents: 301_500,
    dueCount: 81,
    assumptions: {
      expectedOrderValueCents: 9_500,
      confirmRate: 0.62,
      horizonDays: 90,
      asOf: NOW_ISO(),
    },
  };
}
