// Seeded demo data for the insurance-claims workflow pages — the exact
// chain PennPilot's "process a claim end to end" answer deep-links
// (eligibility → auto-submit → ERA files → denials worklist). Shapes
// mirror the response interfaces in src/lib/admin/billing-api.ts,
// billing-auto-submit-api.ts, denials-worklist-api.ts, and
// statement-send-api.ts — those pages dereference nested fields
// unconditionally, so every field of the type must be present.
//
// All names/payers are obviously fictional; money is integer cents in
// realistic DME amounts.

import { daysAgo, hoursAgo, NOW_ISO } from "./dates";

/** EligibilityRecentResponse for /admin/billing/eligibility. */
export function demoEligibilityRecent(status?: string | null) {
  const checks = [
    {
      id: "demo-elig-1",
      patientId: "demo-patient-1",
      insuranceCoverageId: "demo-cov-1",
      payerProfileId: "demo-payer-1",
      payerName: "Sample Medicare",
      serviceHcpcs: "E0601",
      status: "parsed" as const,
      isActive: true,
      inNetwork: true,
      deductibleCents: 25_000,
      deductibleMetCents: 18_500,
      oopMaxCents: 300_000,
      oopMetCents: 45_000,
      copayCents: 0,
      coinsurancePct: 20,
      requiresPriorAuth: false,
      errorMessage: null,
      requestedAt: hoursAgo(3),
      respondedAt: hoursAgo(3),
    },
    {
      id: "demo-elig-2",
      patientId: "demo-patient-4",
      insuranceCoverageId: "demo-cov-4",
      payerProfileId: "demo-payer-2",
      payerName: "Acme Health Demo",
      serviceHcpcs: "A7030",
      status: "parsed" as const,
      isActive: false,
      inNetwork: null,
      deductibleCents: null,
      deductibleMetCents: null,
      oopMaxCents: null,
      oopMetCents: null,
      copayCents: null,
      coinsurancePct: null,
      requiresPriorAuth: null,
      errorMessage: null,
      requestedAt: daysAgo(1),
      respondedAt: daysAgo(1),
    },
    {
      id: "demo-elig-3",
      patientId: "demo-patient-6",
      insuranceCoverageId: "demo-cov-6",
      payerProfileId: null,
      payerName: "Placeholder Mutual",
      serviceHcpcs: null,
      status: "rejected" as const,
      isActive: null,
      inNetwork: null,
      deductibleCents: null,
      deductibleMetCents: null,
      oopMaxCents: null,
      oopMetCents: null,
      copayCents: null,
      coinsurancePct: null,
      requiresPriorAuth: null,
      errorMessage: "AAA*42 — subscriber ID not found",
      requestedAt: daysAgo(2),
      respondedAt: daysAgo(2),
    },
    {
      id: "demo-elig-4",
      patientId: "demo-patient-8",
      insuranceCoverageId: "demo-cov-8",
      payerProfileId: "demo-payer-1",
      payerName: "Sample Medicare",
      serviceHcpcs: "A7034",
      status: "submitted" as const,
      isActive: null,
      inNetwork: null,
      deductibleCents: null,
      deductibleMetCents: null,
      oopMaxCents: null,
      oopMetCents: null,
      copayCents: null,
      coinsurancePct: null,
      requiresPriorAuth: true,
      errorMessage: null,
      requestedAt: hoursAgo(1),
      respondedAt: null,
    },
  ];
  const filtered = status ? checks.filter((c) => c.status === status) : checks;
  return {
    checks: filtered,
    counts: {
      total: checks.length,
      byStatus: {
        queued: 0,
        submitted: 1,
        parsed: 2,
        rejected: 1,
        transport_failed: 0,
      },
      activeCoverage: 1,
      inactiveCoverage: 1,
      priorAuthFlagged: 1,
    },
    windowDays: 30,
    generatedAt: NOW_ISO(),
  };
}

/** EraFilesResponse for /admin/billing/era. */
export function demoEraFiles() {
  return {
    eraFiles: [
      {
        id: "demo-era-1",
        fileName: "835_sample_medicare_demo.txt",
        fileSha256: "demo-sha-1",
        fileSizeBytes: 18_432,
        payerCheckNumber: "CHK-001234",
        payerPaidDate: daysAgo(2).slice(0, 10),
        totalPaidCents: 184_500,
        claimsPaidCount: 9,
        claimsDeniedCount: 1,
        linesProcessedCount: 24,
        matchedSubmissionId: "demo-sub-1",
        status: "processed",
        rejectionReason: null,
        ingestedByEmail: "billing@pennfit.example",
        ingestedAt: daysAgo(2),
      },
      {
        id: "demo-era-2",
        fileName: "835_acme_health_demo.txt",
        fileSha256: "demo-sha-2",
        fileSizeBytes: 9_216,
        payerCheckNumber: null,
        payerPaidDate: null,
        totalPaidCents: null,
        claimsPaidCount: null,
        claimsDeniedCount: null,
        linesProcessedCount: null,
        matchedSubmissionId: null,
        status: "pending",
        rejectionReason: null,
        ingestedByEmail: null,
        ingestedAt: hoursAgo(4),
      },
    ],
  };
}

/** DenialsWorklistResponse for /admin/billing/denials-worklist. */
export function demoDenialsWorklist() {
  const items = [
    {
      claimId: "demo-claim-31",
      patientId: "demo-patient-2",
      payerName: "Sample Medicare",
      recoverableCents: 64_900,
      confidence: 0.86,
      recommendation: "fix_and_resubmit" as const,
      canAutoResubmit: true,
      denialReason: "CO-16 — missing KX modifier",
      decisionAt: daysAgo(3),
      winProbability: 0.82,
      scoreCents: 53_218,
      hasAnalysis: true,
    },
    {
      claimId: "demo-claim-44",
      patientId: "demo-patient-5",
      payerName: "Acme Health Demo",
      recoverableCents: 28_750,
      confidence: 0.61,
      recommendation: "appeal" as const,
      canAutoResubmit: false,
      denialReason: "CO-50 — medical necessity",
      decisionAt: daysAgo(6),
      winProbability: 0.44,
      scoreCents: 12_650,
      hasAnalysis: true,
    },
    {
      claimId: "demo-claim-58",
      patientId: "demo-patient-9",
      payerName: "Placeholder Mutual",
      recoverableCents: 9_900,
      confidence: null,
      recommendation: null,
      canAutoResubmit: false,
      denialReason: "PR-204 — not covered under plan",
      decisionAt: daysAgo(8),
      winProbability: 0.2,
      scoreCents: 1_980,
      hasAnalysis: false,
    },
  ];
  return {
    items,
    totals: {
      count: items.length,
      recoverableCents: 103_550,
      expectedRecoverableCents: 67_848,
      autoResubmittable: 1,
      unanalyzed: 1,
    },
    generatedAt: NOW_ISO(),
  };
}

/** SubmissionReadiness for /admin/billing/auto-submit. */
export function demoAutoSubmitReady() {
  const claims = [
    {
      claimId: "demo-claim-71",
      patientId: "demo-patient-1",
      patientName: "Jordan Sample",
      payerProfileId: "demo-payer-1",
      payerName: "Sample Medicare",
      totalBilledCents: 86_400,
      dateOfService: daysAgo(5).slice(0, 10),
      eligibilityVerifiedAt: hoursAgo(3),
    },
    {
      claimId: "demo-claim-72",
      patientId: "demo-patient-3",
      patientName: "Morgan Example",
      payerProfileId: "demo-payer-1",
      payerName: "Sample Medicare",
      totalBilledCents: 12_950,
      dateOfService: daysAgo(4).slice(0, 10),
      eligibilityVerifiedAt: daysAgo(1),
    },
  ];
  return {
    groups: [
      {
        payerProfileId: "demo-payer-1",
        payerName: "Sample Medicare",
        claimCount: claims.length,
        totalBilledCents: 99_350,
        claims,
      },
    ],
    readyClaimCount: claims.length,
    readyPayerCount: 1,
    readyTotalBilledCents: 99_350,
    excluded: [
      {
        claimId: "demo-claim-80",
        patientId: "demo-patient-7",
        reason: "eligibility_stale" as const,
        detail: "Last 271 is 47 days old (max 30).",
      },
    ],
    scannedCount: 3,
    generatedAt: NOW_ISO(),
  };
}

/** AutoSubmitStatus for the toggle strip on /admin/billing/auto-submit. */
export function demoAutoSubmitStatus() {
  return {
    autoSubmit: {
      flagEnabled: true,
      cronConfigured: true,
      cronExpression: "0 7 * * 1-5",
      active: true,
      maxClaimsPerRun: 50,
      maxClaimsPerBatch: 25,
    },
    eligibilityAutoReverify: {
      cronConfigured: true,
      cronExpression: "30 6 * * 1-5",
    },
  };
}

/**
 * AutoSubmitRunResult for the "Submit all ready" button on
 * /admin/billing/auto-submit. The seeded ready fixture enables the
 * button, and the result panel derefs `result.failures.length` /
 * `result.skippedNotReady.length` unconditionally — the generic
 * `{ ok: true }` mutation fallback would crash the page on click.
 * Mirrors the two seeded ready claims "submitting" in one batch.
 */
export function demoAutoSubmitRun() {
  return {
    triggeredBy: "operator" as const,
    batchesAttempted: 1,
    claimsSubmitted: 2,
    submissions: [
      {
        submissionId: "demo-sub-2",
        payerProfileId: "demo-payer-1",
        claimCount: 2,
        uploadOk: true,
        isaControlNumber: "000000042",
      },
    ],
    failures: [],
    skippedNotReady: [],
    readyClaimCount: 2,
  };
}

/** PendingStatementsResponse for /admin/billing/statements. */
export function demoPendingStatements() {
  const pending = [
    {
      statementId: "demo-stmt-1",
      patientId: "demo-patient-2",
      amountCents: 4_350,
      createdAt: daysAgo(1),
    },
    {
      statementId: "demo-stmt-2",
      patientId: "demo-patient-5",
      amountCents: 12_125,
      createdAt: daysAgo(2),
    },
  ];
  return {
    pending,
    count: pending.length,
    totalCents: 16_475,
  };
}

/** MailQueueResponse for the mail-queue section of /admin/billing/statements. */
export function demoStatementMailQueue() {
  const queued = [
    {
      statementId: "demo-stmt-9",
      patientId: "demo-patient-8",
      amountCents: 7_800,
      createdAt: daysAgo(3),
    },
  ];
  return {
    queued,
    count: queued.length,
    totalCents: 7_800,
    printCap: 50,
  };
}

/**
 * `{ summary: StatementBatchSummary }` for the "Send all pending"
 * button on /admin/billing/statements — the page derefs
 * `batch.data.summary.scanned` on success, so the `{ ok: true }`
 * fallback would crash on click. Mirrors the two seeded pending
 * statements: one sends by email, one falls to the mail queue.
 */
export function demoStatementBatchSend() {
  return {
    summary: { scanned: 2, sent: 1, failed: 0, skipped: 0, mailQueued: 1 },
  };
}

/** `{ outcome: StatementSendOutcome }` for the per-row Send button. */
export function demoStatementSend() {
  return { outcome: { kind: "sent" as const, channel: "email" as const } };
}
