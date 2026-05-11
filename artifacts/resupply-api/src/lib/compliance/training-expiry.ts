// Pure helpers for the accreditation-binder surfaces.
//
// Two concerns:
//   1. Bucket each training record into current / due-soon /
//      expired so the dashboard can color-code without re-deriving
//      from raw dates client-side.
//   2. Validate grievance status transitions (state machine).
//
// Both are PURE — no DB, no Date.now() inside the helpers (callers
// pass `asOfDate`). Same inputs always produce the same output.

export type TrainingExpiryBucket = "current" | "due_soon" | "expired";

/** A training record can be `current` until DUE_SOON_DAYS days
 *  before its expires_at; then it flips to `due_soon`; on or after
 *  expires_at it flips to `expired`. Records with NULL expires_at
 *  are `current` forever (one-time trainings like new-hire
 *  orientation). */
export const DUE_SOON_DAYS = 30;

export function bucketizeTrainingExpiry({
  expiresAt,
  asOfDate,
}: {
  expiresAt: string | null;
  asOfDate: string;
}): TrainingExpiryBucket {
  if (!expiresAt) return "current";
  // Parse YYYY-MM-DD without TZ shift.
  const expiry = parseIsoDate(expiresAt);
  const today = parseIsoDate(asOfDate);
  if (!expiry || !today) return "current"; // safest default

  if (today.getTime() >= expiry.getTime()) return "expired";

  const dueSoonStart = new Date(expiry.getTime());
  dueSoonStart.setUTCDate(dueSoonStart.getUTCDate() - DUE_SOON_DAYS);
  if (today.getTime() >= dueSoonStart.getTime()) return "due_soon";

  return "current";
}

export function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

// ── Grievance state machine ─────────────────────────────────────────

export type GrievanceStatus =
  | "open"
  | "acknowledged"
  | "escalated"
  | "resolved"
  | "reopened";

/**
 * Allowed transitions per the schema comment. `reopened` is the only
 * legal off-ramp from `resolved` — accreditors prefer the reopen
 * trail over silently re-opening the original row.
 */
export const GRIEVANCE_TRANSITIONS: Record<
  GrievanceStatus,
  readonly GrievanceStatus[]
> = {
  open: ["acknowledged", "resolved", "escalated"],
  acknowledged: ["resolved", "escalated"],
  escalated: ["resolved"],
  resolved: ["reopened"],
  reopened: ["resolved"],
};

export function isLegalGrievanceTransition(
  from: GrievanceStatus,
  to: GrievanceStatus,
): boolean {
  if (from === to) return true; // no-op same-status is allowed
  return GRIEVANCE_TRANSITIONS[from].includes(to);
}
