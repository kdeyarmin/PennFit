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
    /**
     * The timestamp column that says how long an item has been waiting.
     *
     * Without it a queue can only report a SIZE, and size is the less
     * useful half: five items sitting for six weeks is a different
     * problem from fifty that arrived this morning, and only the first
     * one is failing anybody.
     *
     * It must be the moment the item ENTERED THIS QUEUE, which is not
     * always the row's `created_at`. A row that lives through several
     * states before it lands here — a claim that is created, submitted,
     * adjudicated and only then denied — has a `created_at` that predates
     * the work by the whole earlier lifecycle, and aging from it reports
     * every item as instantly breached. A gate that is always red tells a
     * biller nothing and gets ignored, which is worse than not measuring.
     *
     * The column may be NULL on some rows (a status stamped without its
     * timestamp). The read orders NULLS LAST so an unstamped row can
     * never masquerade as the oldest item; it is still counted in
     * `waiting`, so the size stays honest.
     */
    ageColumn?: string;
  } | null;
  /**
   * WHY no count is possible, for a gate whose `queue` is null.
   *
   * Required rather than optional: a bare `null` is indistinguishable
   * from "we could not read it just now", and an operator looking at a
   * permanent dash has no way to tell an un-countable step from an
   * outage. Stating the reason is what makes the dash informative.
   */
  uncountableReason?: string;
  /**
   * How long an item may wait before it is failing someone.
   *
   * Not a service-level guarantee to a customer — an internal
   * expectation, so a queue that has quietly stopped being worked
   * becomes visible. Chosen per gate because they are not comparable: a
   * patient waiting on an address confirmation is blocking a shipment
   * today, while a catalog sign-off is a standing task.
   *
   * `null` for a gate where age carries no meaning.
   */
  slaHours: number | null;
  /**
   * Ordering when everything is behind at once. `1` is worked first.
   *
   * Ordered by what breaks if it is not: a patient without supplies,
   * then a claim that will time out, then everything else.
   */
  priority: 1 | 2 | 3;
  /**
   * Where the DECISION is recorded once a person makes it.
   *
   * A gate whose disposition is not written anywhere cannot be audited,
   * and "who approved this and when" is the question that gets asked
   * about every one of these after the fact.
   */
  disposition: string;
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
    slaHours: 48,
    priority: 2,
    disposition:
      "`fit_sessions.review_status` + the reviewing clinician on the row.",
    label: "Approve or override a mask fitting",
    actor: "clinician",
    why: "A recommendation from measurements is a starting point, not a prescription. A clinician confirms the size before it becomes what the patient wears every night.",
    href: "/admin/fit-sessions",
    permission: "clinical.read",
    queue: {
      table: "fit_sessions",
      match: { review_status: "pending_review" },
      ageColumn: "created_at",
    },
  },
  {
    key: "fitter_request_close",
    slaHours: 24,
    priority: 1,
    disposition:
      "`fitter_fit_requests.status` moves to `fulfilled` or `closed`, with the closing staff member.",
    label: "Work a mask-fitter request",
    actor: "csr",
    href: "/admin/fitter-requests",
    why: "The fitter deliberately ends in a request, not an order. A claim must not start from a patient's own guess at their member ID, and the confirmation email promises a person will be in touch.",
    permission: "conversations.manage",
    queue: {
      table: "fitter_fit_requests",
      match: { status: "new" },
      ageColumn: "created_at",
    },
  },
  {
    key: "resupply_draft_approve",
    slaHours: 72,
    priority: 2,
    disposition: "`resupply_order_drafts.status` -> approved/rejected.",
    label: "Approve a suggested resupply order",
    actor: "csr",
    why: "The auto-drafter proposes from device data; it never orders. Someone confirms the patient actually needs the item before it is dispensed and billed.",
    href: "/admin/therapy-resupply",
    permission: "orders.create",
    queue: {
      table: "resupply_order_drafts",
      match: { status: "proposed" },
      ageColumn: "created_at",
    },
  },
  {
    key: "address_change_confirm",
    slaHours: 24,
    priority: 1,
    disposition:
      "`csr_compliance_alerts.status` -> resolved, plus the address change on the patient record.",
    label: "Confirm a patient's new shipping address",
    actor: "csr",
    why: "The patient told us their address is wrong. Nothing ships until a person confirms the new one — an order sent to a stale address is lost product and a patient without supplies.",
    href: "/admin/alerts",
    permission: "conversations.manage",
    queue: {
      table: "csr_compliance_alerts",
      match: { alert_type: "address_change_pending", status: "open" },
      ageColumn: "created_at",
    },
  },
  {
    key: "resupply_no_response",
    slaHours: 72,
    priority: 2,
    disposition: "`csr_compliance_alerts.status` -> resolved/snoozed.",
    label: "Call a patient the reminders could not reach",
    actor: "csr",
    why: "The automated ladder has run out. Someone who has ignored SMS, email and a call is not going to be reached by a fourth automated message.",
    href: "/admin/alerts",
    permission: "conversations.manage",
    queue: {
      table: "csr_compliance_alerts",
      match: { alert_type: "no_response", status: "open" },
      ageColumn: "created_at",
    },
  },
  {
    key: "mark_shipped",
    slaHours: 72,
    priority: 1,
    disposition:
      "`fulfillments.shipped_at` + `shipment_metadata.source`, written only through recordShipmentEvidence.",
    label: "Record that an order shipped",
    actor: "csr",
    why: "PacWare ships out of band. Until a shipment is recorded — by import or by hand — the patient's next refill is timed from when we queued the order, and their claim carries the wrong date of service.",
    href: "/admin/episodes",
    permission: "orders.create",
    queue: {
      table: "fulfillments",
      match: { status: "queued" },
      isNull: "shipped_at",
      ageColumn: "created_at",
    },
  },
  {
    key: "claim_from_fulfillment",
    slaHours: 120,
    priority: 2,
    disposition: "An `insurance_claims` row exists for the fulfillment.",
    uncountableReason:
      "No single queue: the backlog is shipped fulfillments with no claim, which is an anti-join PostgREST cannot express in one read. /admin/analytics/order-outcomes reports it as the shipped-but-unbilled stage.",
    label: "Create the claim for a shipped order",
    actor: "biller",
    why: "Claim creation resolves HCPCS, modifiers, a fee schedule and a diagnosis. A biller owns that mapping; getting it wrong is a denial, or worse, a false claim.",
    href: "/admin/billing",
    permission: "conversations.manage",
    queue: null,
  },
  {
    key: "paperwork_bill_hold",
    slaHours: 168,
    priority: 2,
    disposition:
      "`claim_paperwork_requirements.status` -> received, with the document.",
    label: "Chase outstanding paperwork before billing",
    actor: "biller",
    why: "An outstanding required document blocks transmission by design. Billing without it is a denial the payer will take back later, with interest.",
    href: "/admin/billing/bill-hold",
    permission: "billing.manage",
    queue: {
      table: "claim_paperwork_requirements",
      match: { status: "outstanding", required: "true" },
      ageColumn: "created_at",
    },
  },
  {
    key: "ai_scrub_review",
    slaHours: 48,
    priority: 2,
    disposition: "`claim_scrub_results.review_status` + the reviewing biller.",
    label: "Review what the claim scrubber flagged",
    actor: "biller",
    why: "The scrubber suggests; it does not edit. A model's confident patch to a claim is still a change to a legal document a person signs for.",
    href: "/admin/billing/ai-queue",
    permission: "billing.manage",
    queue: {
      table: "claim_scrub_results",
      match: { review_status: "pending" },
      ageColumn: "created_at",
    },
  },
  {
    key: "claim_submit",
    slaHours: 120,
    priority: 2,
    disposition:
      "`insurance_claims.status` leaves `draft`, and the Office Ally submission row records who sent it.",
    label: "Submit claims to the clearinghouse",
    actor: "biller",
    why: "Unattended submission exists, but it needs BOTH an env cron and a per-tenant flag, and it only takes claims that pass preflight with fresh active eligibility. Everything it excludes is here, waiting for a person.",
    href: "/admin/billing/auto-submit",
    permission: "billing.manage",
    queue: {
      table: "insurance_claims",
      match: { status: "draft" },
      ageColumn: "created_at",
    },
    // With this on, the worker takes the preflight-clean, freshly
    // eligible subset without anyone clicking. The count below cannot
    // exclude them, so it is reported as an upper bound instead of
    // claiming every draft is waiting on a biller.
    conditionalOn: "billing.auto_submit_claims",
  },
  {
    key: "secondary_cob_submit",
    slaHours: 168,
    priority: 3,
    disposition: "The secondary claim's own `insurance_claims.status`.",
    uncountableReason:
      "No single queue: a secondary claim is identified by its relationship to a primary remit, which needs a join. /admin/billing/secondary lists them.",
    label: "Submit a secondary claim",
    actor: "biller",
    why: "Secondary claims are drafted automatically and never auto-submitted. The COB amounts carried over from the primary remit are what a payer audits.",
    href: "/admin/billing/secondary",
    permission: "billing.manage",
    queue: null,
  },
  {
    key: "denial_work",
    slaHours: 240,
    priority: 2,
    disposition:
      "`insurance_claims.status` -> appealed / resubmitted / written_off, plus a billing note.",
    label: "Work a denial",
    actor: "biller",
    why: "Analysis is generated; the decision to appeal, resubmit, bill the patient, or write off is money and is a person's.",
    href: "/admin/billing/denials-worklist",
    permission: "billing.manage",
    queue: {
      table: "insurance_claims",
      // Aged from the DENIAL, not from the claim. A claim is created,
      // submitted, adjudicated and only then denied — often two months
      // after `created_at`. Aging this queue from the row's creation made
      // every denial arrive already past its 10-day SLA, so the gate was
      // permanently breached no matter how fast a biller worked it and
      // measured the payer's turnaround rather than ours.
      match: { status: "denied" },
      ageColumn: "decision_at",
    },
  },
  {
    key: "appeal_send",
    slaHours: 240,
    priority: 3,
    disposition:
      "The appeal record's sent timestamp and the correspondence log.",
    uncountableReason:
      "No single queue: a drafted appeal is a document attached to a denial, not a row with a pending status of its own. /admin/billing/denials lists them.",
    label: "Send an appeal letter",
    actor: "biller",
    why: "The letter is drafted for you. Sending it is a separate, audited act — it is correspondence with a payer under your practice's name.",
    href: "/admin/billing/denials",
    permission: "billing.manage",
    queue: null,
  },
  {
    key: "mask_catalog_signoff",
    slaHours: null,
    priority: 3,
    disposition:
      "`mask_catalog_signoffs` records who vouched for the band and when.",
    uncountableReason:
      "Not a backlog: catalog sign-off is a standing task with no due date, and a count would imply an unworked queue where there is none.",
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
