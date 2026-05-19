// Pure helpers for the HIPAA §164.524(b)(2) patient-rights response
// clock.
//
// Statute: covered entity must act on a patient access request within
// 30 days. ONE additional 30-day extension is permitted if the
// patient is notified in writing of the reason for the delay within
// the initial 30-day window. The same clock applies to amendment
// requests under §164.526(b)(2).
//
// These helpers are pure (no DB, no Date.now() inside) so they can
// be unit-tested with synthetic inputs.

export type RightsClockBucket =
  | "on_time"
  | "due_soon"
  | "overdue"
  | "extension_eligible"
  | "extension_overdue"
  | "closed";

export interface RightsClockInput {
  receivedAt: string;
  extensionGrantedAt: string | null;
  status: string;
  asOf: string;
}

/** Bucketize a single rights-request row for the dashboard. */
export function bucketizeRightsClock(input: RightsClockInput): RightsClockBucket {
  if (
    input.status === "granted" ||
    input.status === "partially_granted" ||
    input.status === "denied" ||
    input.status === "withdrawn" ||
    input.status === "expired"
  ) {
    return "closed";
  }
  const received = new Date(input.receivedAt).getTime();
  const now = new Date(input.asOf).getTime();
  if (!Number.isFinite(received) || !Number.isFinite(now)) return "on_time";

  // First 30-day deadline.
  const firstDeadline = received + DAY_MS * 30;
  const extendedDeadline = received + DAY_MS * 60;

  if (input.extensionGrantedAt) {
    if (now >= extendedDeadline) return "extension_overdue";
    if (now >= extendedDeadline - DAY_MS * 5) return "due_soon";
    return "on_time";
  }
  if (now >= firstDeadline) return "extension_eligible";
  if (now >= firstDeadline - DAY_MS * 5) return "due_soon";
  return "on_time";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ISO date the operator must respond by, given the current
 *  extension state. */
export function computeDueByIso(
  receivedAt: string,
  extensionGrantedAt: string | null,
): string {
  const received = new Date(receivedAt).getTime();
  if (!Number.isFinite(received)) return receivedAt;
  const due = extensionGrantedAt
    ? received + DAY_MS * 60
    : received + DAY_MS * 30;
  return new Date(due).toISOString();
}
