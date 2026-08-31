// episode-status.ts — the single source of truth for the resupply
// episode lifecycle, and for the fulfillment status spellings that
// lifecycle depends on.
//
// WHY THIS EXISTS
// ---------------
// The in-progress status set used to be declared four separate times:
//
//   * artifacts/resupply-api/src/worker/jobs/reminders.ts
//   * artifacts/resupply-api/src/lib/shop-customer/insurance-due-digest.ts
//   * artifacts/resupply-api/src/routes/voice/inbound-reorder.ts
//     (as ACTIONABLE_EPISODE_STATUSES)
//   * artifacts/resupply-api/src/routes/episodes/list.ts (the query enum)
//
// …and a fifth list in routes/admin/pacware.ts accepted two statuses
// ("approved", "pending") that NO writer has ever produced. Four copies
// of a filter that decides whether a patient gets contacted is how a
// status gets added in one place and silently re-enters the reminder
// ladder in another.
//
// The vocabulary is also load-bearing beyond the ladder: `fulfilled`,
// `expired`, and `canceled` are READ by the analytics funnel
// (lib/analytics/aggregate.ts), routes/episodes/counts.ts, and the SPA
// client types. Until the lifecycle close-out work landed, nothing
// wrote them — every one of those surfaces reported a permanent zero.
//
// Pure module: no DB, no I/O.

// ── Episode statuses ─────────────────────────────────────────────────

export const EPISODE_STATUSES = [
  "outreach_pending",
  "awaiting_response",
  /** Patient asked us to change their address. NOT terminal and NOT in
   *  outreach: the cycle is alive and a CSR owns it, but the ladder is
   *  silent because we have already told the patient nothing is
   *  shipping. Before this existed, an address edit held the shipment
   *  and left the episode in the ladder, so we kept nagging about an
   *  order we had just paused. */
  "address_hold",
  "confirmed",
  "fulfilled",
  "declined",
  "expired",
  "canceled",
] as const;

export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

/**
 * Statuses the reminder scan and the escalation ladder may act on.
 * `address_hold` is deliberately absent — see its comment above.
 */
export const IN_PROGRESS_EPISODE_STATUSES = [
  "outreach_pending",
  "awaiting_response",
] as const;

export type InProgressEpisodeStatus =
  (typeof IN_PROGRESS_EPISODE_STATUSES)[number];

/**
 * A prescription already has a live outreach cycle in one of these, so
 * opening another would double-nag. This is `openOutreachEpisode`'s
 * idempotency set.
 *
 * `confirmed` is deliberately EXCLUDED: the confirm path opens the NEXT
 * cycle while the current row is still `confirmed`, and including it
 * here would make that a silent no-op — the exact "automation is
 * one-shot" failure this work exists to fix.
 */
export const OUTREACH_OPEN_EPISODE_STATUSES = [
  "outreach_pending",
  "awaiting_response",
  "address_hold",
] as const;

/** Not yet finished — what a CSR queue or patient dashboard shows. */
export const OPEN_EPISODE_STATUSES = [
  ...OUTREACH_OPEN_EPISODE_STATUSES,
  "confirmed",
] as const;

/** The cycle is over. `confirmed` is NOT terminal: the order is on the
 *  books but has not shipped, and it can still be cancelled. */
export const TERMINAL_EPISODE_STATUSES = [
  "fulfilled",
  "declined",
  "expired",
  "canceled",
] as const;

export type TerminalEpisodeStatus = (typeof TERMINAL_EPISODE_STATUSES)[number];

// ── Close-out reasons ────────────────────────────────────────────────

/**
 * Why a cycle ended. Recorded on `episodes.closed_reason` so the
 * outcome funnel can say *why* a cycle dropped out instead of only
 * counting that it did.
 *
 * Bounded on purpose. A free-text CSR note here would give the funnel's
 * GROUP BY unbounded cardinality and put operator prose — a PHI vector —
 * into an analytics response. Narrative belongs on the patient timeline.
 */
export const EPISODE_CLOSED_REASONS = [
  /** Real shipment evidence arrived. */
  "shipped",
  /** No evidence ever arrived; the grace sweep advanced the ladder so
   *  the patient would not fall out of resupply. Deliberately distinct
   *  from `shipped` — a tenant that later installs a ship feed watches
   *  this bucket collapse, which is the honest measure of the gap. */
  "assumed_shipped",
  /** Patient said no this cycle (SMS NO, voice decline, email decline). */
  "patient_declined",
  /** Patient withdrew from outreach entirely (STOP / unsubscribe). */
  "patient_opted_out",
  /** Ladder ran out with no answer, after we did reach out. */
  "no_response",
  /** Ladder ran out having never sent anything — no phone, no email, or
   *  a worker outage. Operationally different from `no_response`: one is
   *  a patient who ignored us, the other is a patient we failed. */
  "never_contacted",
  /** A person closed it from the admin console. */
  "csr_canceled",
  /** The prescription behind it stopped being active. */
  "prescription_ended",
  /** The patient record left active status for a non-opt-out reason. */
  "patient_inactive",
  /** Superseded by another episode for the same prescription. */
  "duplicate",
  /** Coverage lapsed, so this cycle cannot be billed. */
  "coverage_lost",
] as const;

export type EpisodeClosedReason = (typeof EPISODE_CLOSED_REASONS)[number];

/**
 * Which reasons are legal under which terminal status.
 *
 * Enforced HERE, in TypeScript, and deliberately NOT as a cross-column
 * SQL CHECK: pairing them in the database would make every status
 * correction a two-column-atomic write and turn a mismatch into a 500
 * on the patient-facing confirm path.
 */
export const CLOSED_REASONS_BY_STATUS: Record<
  TerminalEpisodeStatus,
  readonly EpisodeClosedReason[]
> = {
  fulfilled: ["shipped", "assumed_shipped"],
  declined: ["patient_declined"],
  expired: ["no_response", "never_contacted"],
  canceled: [
    "patient_opted_out",
    "csr_canceled",
    "prescription_ended",
    "patient_inactive",
    "duplicate",
    "coverage_lost",
  ],
};

export interface EpisodeClosure {
  status: TerminalEpisodeStatus;
  closed_reason: EpisodeClosedReason;
  /** ISO instant. For `fulfilled` this is the SHIP date, not `now` — so
   *  time-to-fulfil stays honest when evidence arrives late. */
  closed_at: string;
}

/**
 * Build the closure patch. Throws on an illegal (status, reason) pair so
 * a typo fails at the callsite instead of silently mis-bucketing a
 * report six weeks later.
 */
export function buildEpisodeClosure(
  status: TerminalEpisodeStatus,
  reason: EpisodeClosedReason,
  at: Date,
): EpisodeClosure {
  const allowed = CLOSED_REASONS_BY_STATUS[status];
  if (!allowed.includes(reason)) {
    throw new Error(
      `episode closure: reason "${reason}" is not valid for status "${status}" ` +
        `(expected one of: ${allowed.join(", ")})`,
    );
  }
  return { status, closed_reason: reason, closed_at: at.toISOString() };
}

// ── Fulfillment statuses ─────────────────────────────────────────────

export const FULFILLMENT_STATUSES = [
  "queued",
  "on_hold",
  "shipped",
  "delivered",
  "cancelled",
] as const;

export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

/**
 * NOTE THE DOUBLE L, AND NEVER TYPE THIS LITERAL BY HAND.
 *
 * The cadence math excludes cancelled dispenses with
 * `.neq("status", "cancelled")` — worker/jobs/reminders.ts:634 and
 * lib/entitlement/resolve-sku-entitlement.ts:89, both double-L, both
 * pinned by tests. The admin SPA's `fulfillmentStatusVariant` renders
 * the SINGLE-L spelling. Nothing has broken yet only because no writer
 * has ever cancelled a fulfillment.
 *
 * The moment one does, a single-L write slips past both filters and is
 * counted as a real dispense — which silently suppresses the patient's
 * next resupply reminder. Use this constant.
 */
export const FULFILLMENT_CANCELLED = "cancelled" as const;
export const FULFILLMENT_QUEUED = "queued" as const;
export const FULFILLMENT_ON_HOLD = "on_hold" as const;
export const FULFILLMENT_SHIPPED = "shipped" as const;
export const FULFILLMENT_DELIVERED = "delivered" as const;

// ── Predicates ───────────────────────────────────────────────────────

const IN_PROGRESS_SET: ReadonlySet<string> = new Set(
  IN_PROGRESS_EPISODE_STATUSES,
);
const OUTREACH_OPEN_SET: ReadonlySet<string> = new Set(
  OUTREACH_OPEN_EPISODE_STATUSES,
);
const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_EPISODE_STATUSES);
const STATUS_SET: ReadonlySet<string> = new Set(EPISODE_STATUSES);
const REASON_SET: ReadonlySet<string> = new Set(EPISODE_CLOSED_REASONS);

/**
 * True for a status the reminder ladder may still act on. Unknown input
 * answers false: a status written by an older or newer deploy must never
 * re-enter the ladder on the strength of not being recognised.
 */
export function isInProgressEpisodeStatus(
  status: string | null | undefined,
): status is InProgressEpisodeStatus {
  return typeof status === "string" && IN_PROGRESS_SET.has(status);
}

/** True while a cycle is still open for outreach purposes — the
 *  idempotency question `openOutreachEpisode` asks. */
export function isOutreachOpenEpisodeStatus(
  status: string | null | undefined,
): boolean {
  return typeof status === "string" && OUTREACH_OPEN_SET.has(status);
}

export function isTerminalEpisodeStatus(
  status: string | null | undefined,
): status is TerminalEpisodeStatus {
  return typeof status === "string" && TERMINAL_SET.has(status);
}

export function isEpisodeStatus(
  status: string | null | undefined,
): status is EpisodeStatus {
  return typeof status === "string" && STATUS_SET.has(status);
}

export function isEpisodeClosedReason(
  reason: string | null | undefined,
): reason is EpisodeClosedReason {
  return typeof reason === "string" && REASON_SET.has(reason);
}

// ── Display labels ───────────────────────────────────────────────────

export const EPISODE_STATUS_LABEL: Record<EpisodeStatus, string> = {
  outreach_pending: "Due",
  awaiting_response: "Waiting on patient",
  address_hold: "Address confirmation needed",
  confirmed: "Confirmed",
  fulfilled: "Shipped",
  declined: "Declined",
  expired: "No response",
  canceled: "Cancelled",
};

export const EPISODE_CLOSED_REASON_LABEL: Record<EpisodeClosedReason, string> =
  {
    shipped: "Shipped",
    assumed_shipped: "Assumed shipped (no confirmation)",
    patient_declined: "Patient declined",
    patient_opted_out: "Patient opted out",
    no_response: "No response",
    never_contacted: "Never contacted",
    csr_canceled: "Cancelled by staff",
    prescription_ended: "Prescription ended",
    patient_inactive: "Patient inactive",
    duplicate: "Duplicate",
    coverage_lost: "Coverage lost",
  };

/**
 * Days after `due_at` that an unanswered episode expires. Comfortably
 * past the ladder's own stop-nagging age (RESUPPLY_ESCALATION_MAX_DAYS,
 * default 21) so expiry closes a cycle the ladder has already given up
 * on rather than racing it.
 */
export const EPISODE_EXPIRY_DAYS = 45;
