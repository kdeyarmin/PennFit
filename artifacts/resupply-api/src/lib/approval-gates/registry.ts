// approval-gates/registry.ts — every transition in this platform that a
// person has to make, stated in one place.
//
// WHY THIS EXISTS
// ---------------
// The posture is already deliberate, and the code says so at each site:
//
//   lib/billing/auto-workflow-engine.ts — "we never auto-SUBMIT"
//   lib/billing/secondary-claim-generator.ts — same rule restated
//   routes/admin/billing-action-queue.ts — "a deliberate human click"
//
// But it is stated in about a dozen places and nowhere as a SET. Two
// things follow from that. An operator cannot see what is waiting on a
// person without opening a dozen queues and knowing which ones exist. And
// nobody can check whether the product's description of itself is still
// true, so copy drifts toward "automatic" while the code stays manual —
// which is the specific failure this addresses: never call a workflow
// no-touch when a biller or CSR has to act.
//
// THIS CHANGES NO GATE. It is a description of the system as it is, not a
// new control. Adding an entry here does not create a gate; removing one
// does not open anything. If you change what a gate does, change it at
// its own site and update the entry to match.
//
// PHI: this file names tables and statuses. The route built on it returns
// COUNTS. Nothing here reaches a patient record.

import type { ResupplyTable } from "@workspace/resupply-db";

/** Who is expected to act. Determines which queue a gate belongs to and
 *  who is asked when it backs up. */
export type ApprovalActor = "biller" | "csr" | "clinician" | "owner";

export interface ApprovalGate {
  key: string;
  /** What the person is deciding, in their words. */
  label: string;
  actor: ApprovalActor;
  /**
   * WHY a person is required. Not decoration — this is the argument that
   * has to survive the next person who asks "can't we automate this?",
   * and if it cannot be written down the gate probably should not exist.
   */
  why: string;
  /** Where they do it. */
  href: string;
  /** The permission that route enforces. */
  permission: string;
  /** The table + filter the count query reads. `null` for a gate whose
   *  backlog has no single countable queue.
   *
   *  `table` is the typed table union, so a rename or a typo fails to
   *  compile rather than turning a gate's badge into a silent zero. */
  queue: {
    table: ResupplyTable;
    /** Column/value equality pairs, ANDed. */
    match: Record<string, string>;
    /** Optional `.in(column, values)` on top of `match`. */
    anyOf?: { column: string; values: string[] };
    /** Optional `.is(column, null)` on top of `match`. */
    isNull?: string;
  } | null;
  /**
   * A feature flag that, when ON for a tenant, moves PART of this queue
   * without a person.
   *
   * The panel's premise is "nothing below moves until someone decides",
   * and for every other gate that is unconditionally true. This one
   * cannot be counted exactly — the auto-submit worker's predicate is
   * preflight-clean plus fresh active eligibility, which lives in tables
   * PostgREST cannot join here — so the count is a ceiling rather than a
   * backlog, and saying so is better than quietly overstating it.
   */
  conditionalOn?: string;
}

/**
 * The gates, ordered as an order travels: clinical first, then the
 * dispense, then the money.
 */
export const APPROVAL_GATES: readonly ApprovalGate[] = [
  {
    key: "fit_session_review",
    label: "Approve or override a mask fitting",
    actor: "clinician",
    why: "A recommendation from measurements is a starting point, not a prescription. A clinician confirms the size before it becomes what the patient wears every night.",
    href: "/admin/fit-sessions",
    permission: "clinical.read",
    queue: {
      table: "fit_sessions",
      match: { review_status: "pending_review" },
    },
  },
  {
    key: "fitter_request_close",
    label: "Work a mask-fitter request",
    actor: "csr",
    href: "/admin/fitter-requests",
    why: "The fitter deliberately ends in a request, not an order. A claim must not start from a patient's own guess at their member ID, and the confirmation email promises a person will be in touch.",
    permission: "conversations.manage",
    queue: {
      table: "fitter_fit_requests",
      match: { status: "new" },
    },
  },
  {
    key: "resupply_draft_approve",
    label: "Approve a suggested resupply order",
    actor: "csr",
    why: "The auto-drafter proposes from device data; it never orders. Someone confirms the patient actually needs the item before it is dispensed and billed.",
    href: "/admin/therapy-resupply",
    permission: "orders.create",
    queue: {
      table: "resupply_order_drafts",
      match: { status: "proposed" },
    },
  },
  {
    key: "address_change_confirm",
    label: "Confirm a patient's new shipping address",
    actor: "csr",
    why: "The patient told us their address is wrong. Nothing ships until a person confirms the new one — an order sent to a stale address is lost product and a patient without supplies.",
    href: "/admin/alerts",
    permission: "conversations.manage",
    queue: {
      table: "csr_compliance_alerts",
      match: { alert_type: "address_change_pending", status: "open" },
    },
  },
  {
    key: "resupply_no_response",
    label: "Call a patient the reminders could not reach",
    actor: "csr",
    why: "The automated ladder has run out. Someone who has ignored SMS, email and a call is not going to be reached by a fourth automated message.",
    href: "/admin/alerts",
    permission: "conversations.manage",
    queue: {
      table: "csr_compliance_alerts",
      match: { alert_type: "no_response", status: "open" },
    },
  },
  {
    key: "mark_shipped",
    label: "Record that an order shipped",
    actor: "csr",
    why: "PacWare ships out of band. Until a shipment is recorded — by import or by hand — the patient's next refill is timed from when we queued the order, and their claim carries the wrong date of service.",
    href: "/admin/episodes",
    permission: "orders.create",
    queue: {
      table: "fulfillments",
      match: { status: "queued" },
      isNull: "shipped_at",
    },
  },
  {
    key: "claim_from_fulfillment",
    label: "Create the claim for a shipped order",
    actor: "biller",
    why: "Claim creation resolves HCPCS, modifiers, a fee schedule and a diagnosis. A biller owns that mapping; getting it wrong is a denial, or worse, a false claim.",
    href: "/admin/billing",
    permission: "conversations.manage",
    queue: null,
  },
  {
    key: "paperwork_bill_hold",
    label: "Chase outstanding paperwork before billing",
    actor: "biller",
    why: "An outstanding required document blocks transmission by design. Billing without it is a denial the payer will take back later, with interest.",
    href: "/admin/billing/bill-hold",
    permission: "billing.manage",
    queue: {
      table: "claim_paperwork_requirements",
      match: { status: "outstanding", required: "true" },
    },
  },
  {
    key: "ai_scrub_review",
    label: "Review what the claim scrubber flagged",
    actor: "biller",
    why: "The scrubber suggests; it does not edit. A model's confident patch to a claim is still a change to a legal document a person signs for.",
    href: "/admin/billing/ai-queue",
    permission: "billing.manage",
    queue: {
      table: "claim_scrub_results",
      match: { review_status: "pending" },
    },
  },
  {
    key: "claim_submit",
    label: "Submit claims to the clearinghouse",
    actor: "biller",
    why: "Unattended submission exists, but it needs BOTH an env cron and a per-tenant flag, and it only takes claims that pass preflight with fresh active eligibility. Everything it excludes is here, waiting for a person.",
    href: "/admin/billing/auto-submit",
    permission: "billing.manage",
    queue: {
      table: "insurance_claims",
      match: { status: "draft" },
    },
    // With this on, the worker takes the preflight-clean, freshly
    // eligible subset without anyone clicking. The count below cannot
    // exclude them, so it is reported as an upper bound instead of
    // claiming every draft is waiting on a biller.
    conditionalOn: "billing.auto_submit_claims",
  },
  {
    key: "secondary_cob_submit",
    label: "Submit a secondary claim",
    actor: "biller",
    why: "Secondary claims are drafted automatically and never auto-submitted. The COB amounts carried over from the primary remit are what a payer audits.",
    href: "/admin/billing/secondary",
    permission: "billing.manage",
    queue: null,
  },
  {
    key: "denial_work",
    label: "Work a denial",
    actor: "biller",
    why: "Analysis is generated; the decision to appeal, resubmit, bill the patient, or write off is money and is a person's.",
    href: "/admin/billing/denials-worklist",
    permission: "billing.manage",
    queue: {
      table: "insurance_claims",
      match: { status: "denied" },
    },
  },
  {
    key: "appeal_send",
    label: "Send an appeal letter",
    actor: "biller",
    why: "The letter is drafted for you. Sending it is a separate, audited act — it is correspondence with a payer under your practice's name.",
    href: "/admin/billing/denials",
    permission: "billing.manage",
    queue: null,
  },
  {
    key: "mask_catalog_signoff",
    label: "Sign off on catalog entries",
    actor: "clinician",
    why: "Seeded size bands are estimates until a clinician at THIS practice vouches for them. The sign-off records who did.",
    href: "/admin/fitter/catalog",
    permission: "clinical.read",
    queue: null,
  },
];

export function findApprovalGate(key: string): ApprovalGate | undefined {
  return APPROVAL_GATES.find((g) => g.key === key);
}

export const APPROVAL_ACTOR_LABEL: Record<ApprovalActor, string> = {
  biller: "Billing",
  csr: "Patient support",
  clinician: "Clinical",
  owner: "Owner",
};
