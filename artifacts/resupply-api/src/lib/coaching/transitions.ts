// Pure state-machine transition rules for patient_coaching_plans.
//
// Kept out of the route handler so the rules can be unit-tested
// independently and reused if another surface (e.g. the worker)
// needs to apply the same rules.

export type CoachingStatus =
  | "open"
  | "outreach_made"
  | "improving"
  | "escalated"
  | "resolved"
  | "abandoned";

export const TERMINAL_STATUSES: readonly CoachingStatus[] = [
  "resolved",
  "abandoned",
];

/** True when the status is a non-recoverable terminal state. */
export function isTerminal(status: CoachingStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

const TRANSITIONS: Record<CoachingStatus, ReadonlySet<CoachingStatus>> = {
  open: new Set(["outreach_made", "escalated", "abandoned"]),
  outreach_made: new Set(["improving", "escalated", "resolved", "abandoned"]),
  improving: new Set(["resolved", "escalated", "abandoned"]),
  escalated: new Set(["resolved", "abandoned", "improving"]),
  resolved: new Set(),
  abandoned: new Set(),
};

export interface TransitionAttempt {
  from: CoachingStatus;
  to: CoachingStatus;
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: "terminal" | "illegal_transition" };

/** Vet a state-machine move. Returns ok=true when it's allowed,
 *  ok=false with a stable reason code otherwise. */
export function canTransition({
  from,
  to,
}: TransitionAttempt): TransitionResult {
  if (from === to) return { ok: true };
  if (isTerminal(from)) return { ok: false, reason: "terminal" };
  const allowed = TRANSITIONS[from];
  if (!allowed.has(to)) {
    return { ok: false, reason: "illegal_transition" };
  }
  return { ok: true };
}
