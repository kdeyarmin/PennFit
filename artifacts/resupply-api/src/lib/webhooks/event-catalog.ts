// Static catalog of every webhook event type the API publishes.
//
// Single source of truth for:
//   * The admin UI's "events you can subscribe to" picker.
//   * The docs page (rendered separately).
//   * The validator that warns when an admin subscribes to an
//     event-type slug that no publisher actually emits.
//
// Conventions
// -----------
// Slug shape: `<resource>.<action>` (snake_case).
// Each entry documents:
//   - what the event represents
//   - the publisher (where in the codebase it's emitted)
//   - the payload shape — stable fields the subscriber can rely on
//   - whether the event carries any patient-id reference (so the
//     subscriber knows to enrich via our API instead of expecting PHI)

export interface WebhookEventDefinition {
  type: string;
  description: string;
  publisher: string;
  payloadFields: Record<
    string,
    "string" | "number" | "boolean" | "uuid" | "iso_timestamp" | "json"
  >;
  carriesPatientId: boolean;
}

export const WEBHOOK_EVENT_CATALOG: readonly WebhookEventDefinition[] = [
  // ── Claim state transitions ──
  {
    type: "claim.submitted",
    description:
      "Insurance claim transitioned to submitted (sent to clearinghouse).",
    publisher:
      "routes/patients/insurance-claims.ts PATCH + lib/billing/office-ally-batch.ts",
    payloadFields: {
      claim_id: "uuid",
      patient_id: "uuid",
      from_status: "string",
      to_status: "string",
    },
    carriesPatientId: true,
  },
  {
    type: "claim.accepted",
    description: "Claim accepted by payer at the 277CA stage.",
    publisher: "routes/patients/insurance-claims.ts PATCH",
    payloadFields: { claim_id: "uuid", patient_id: "uuid" },
    carriesPatientId: true,
  },
  {
    // The era-reconciler library flips claim status in-place during ERA
    // ingest but does NOT itself emit `claim.denied`; the surrounding
    // routes/admin/era-ingest.ts handler emits only `era.ingested`, so
    // ERA-driven status flips never reach webhook subscribers today.
    // That's a known follow-up — keep the publisher field truthful here
    // so the subscribe-validator doesn't lie to integrators about
    // where the event will originate.
    type: "claim.denied",
    description: "Claim denied by payer (line-level or claim-level).",
    publisher: "routes/patients/insurance-claims.ts PATCH",
    payloadFields: { claim_id: "uuid", patient_id: "uuid" },
    carriesPatientId: true,
  },
  {
    // Same era-reconciler caveat as claim.denied above.
    type: "claim.paid",
    description: "Claim moved to paid status (full or partial pay).",
    publisher: "routes/patients/insurance-claims.ts PATCH",
    payloadFields: { claim_id: "uuid", patient_id: "uuid" },
    carriesPatientId: true,
  },
  {
    type: "claim.appealed",
    description: "Claim transitioned to appealed status.",
    publisher: "routes/patients/insurance-claims.ts PATCH",
    payloadFields: { claim_id: "uuid", patient_id: "uuid" },
    carriesPatientId: true,
  },
  {
    type: "claim.closed",
    description: "Claim closed (terminal state).",
    publisher: "routes/patients/insurance-claims.ts PATCH",
    payloadFields: { claim_id: "uuid", patient_id: "uuid" },
    carriesPatientId: true,
  },
  // ── AI workflow ──
  {
    type: "claim.auto_scrubbed",
    description:
      "Auto-workflow engine ran an AI scrub on a draft claim that the heuristic flagged risky.",
    publisher: "lib/billing/auto-workflow-engine.ts",
    payloadFields: {
      claim_id: "uuid",
      verdict: "string",
      probability: "number",
      finding_count: "number",
    },
    carriesPatientId: false,
  },
  {
    type: "claim.denial_analyzed",
    description:
      "Auto-workflow engine ran an AI denial analysis on a fresh denial.",
    publisher: "lib/billing/auto-workflow-engine.ts",
    payloadFields: {
      claim_id: "uuid",
      recommendation: "string",
      confidence: "number",
      can_auto_resubmit: "boolean",
    },
    carriesPatientId: false,
  },
  // ── ERA + payment ──
  {
    type: "era.ingested",
    description:
      "An 835 ERA was ingested + reconciled. Carries the total paid + per-disposition counts.",
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
  // ── Patient-facing billing ──
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
    type: "billing_statement.due",
    description:
      "The auto-workflow engine flagged that a patient is eligible for a fresh billing statement (cooldown elapsed + open balance).",
    publisher: "lib/billing/auto-workflow-engine.ts",
    payloadFields: { patient_id: "uuid" },
    carriesPatientId: true,
  },
  {
    type: "claim_appeal.generated",
    description: "An appeal letter PDF was generated for a denied claim.",
    publisher: "routes/admin/claim-appeals.ts",
    payloadFields: {
      appeal_letter_id: "uuid",
      claim_id: "uuid",
      patient_id: "uuid",
    },
    carriesPatientId: true,
  },
  {
    type: "dispense_readiness.reviewed",
    description:
      "AI-augmented dispense-readiness review completed. Subscribers can fan out to the CSR queue or ops dashboards.",
    publisher: "routes/admin/dispense-readiness.ts",
    payloadFields: {
      review_id: "uuid",
      patient_id: "uuid",
      verdict: "string",
      checks_failed: "number",
    },
    carriesPatientId: true,
  },
  // ── Compliance auto-workflow (Phase 11) ──
  {
    type: "compliance.baa_expiring_soon",
    description:
      "Business Associate Agreement is within the 60-day expiry window. Emitted once per BAA per 24-hour cooldown.",
    publisher: "lib/compliance/auto-workflow.ts",
    payloadFields: {
      baa_id: "uuid",
      vendor_slug: "string",
      vendor_kind: "string",
      expires_on: "string",
    },
    carriesPatientId: false,
  },
  {
    type: "compliance.baa_expired",
    description:
      "BAA has expired without renewal — a HIPAA §164.504(e) violation in flight. Emitted once per BAA per 24-hour cooldown.",
    publisher: "lib/compliance/auto-workflow.ts",
    payloadFields: {
      baa_id: "uuid",
      vendor_slug: "string",
      vendor_kind: "string",
      expires_on: "string",
    },
    carriesPatientId: false,
  },
  {
    type: "compliance.oig_screening_overdue",
    description:
      "No OIG LEIE screening has been recorded in the last 35 days. Emitted once per 24-hour cooldown.",
    publisher: "lib/compliance/auto-workflow.ts",
    payloadFields: {
      cutoff_days: "number",
      cutoff_at: "iso_timestamp",
    },
    carriesPatientId: false,
  },
  {
    type: "compliance.patient_rights_overdue",
    description:
      "A §164.522/524/526/528 rights request has passed its 30-day (or 60-day extended) response deadline. Emitted once per request per 24-hour cooldown.",
    publisher: "lib/compliance/auto-workflow.ts",
    payloadFields: {
      request_id: "uuid",
      patient_id: "uuid",
      request_kind: "string",
      received_at: "iso_timestamp",
      extended: "boolean",
    },
    carriesPatientId: true,
  },
];

/** Build the set of valid event-type slugs for the admin
 *  subscription create validator. */
export const VALID_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  WEBHOOK_EVENT_CATALOG.map((e) => e.type),
);
