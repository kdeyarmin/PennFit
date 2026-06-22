// Patient AR dunning ladder — pure decision logic (ADR 008: no I/O, clock
// passed in). The brain the collections worker calls; also drives a worklist
// preview and tests without touching the DB or any send path.
//
// A "run" is one patient balance cycle. It walks an escalating ladder
// (statement → reminder → second notice → final notice → agency) on a cadence,
// and — critically — DE-ESCALATES the moment the balance is paid or the patient
// goes onto a payment plan / autopay. Sends themselves (consent + quiet-hours)
// are the worker's job via the existing statement send path; this module only
// decides WHETHER and WHAT to send.

export type DunningStep =
  | "statement"
  | "reminder"
  | "second_notice"
  | "final_notice"
  | "agency"
  | "resolved";

export type DunningChannel = "email" | "sms" | "letter";

export interface DunningPolicyStep {
  step: DunningStep;
  /** Days after the run opened that this step becomes due (cumulative). */
  dayOffset: number;
  /** Channels to attempt for this step (consent/quiet-hours applied later).
   *  Empty = no automated send (the agency step is an export, not a message). */
  channels: DunningChannel[];
}

/** Default escalation ladder. `agency` has no channels — reaching it produces a
 *  reviewable collections export, never an automated message. */
export const DEFAULT_DUNNING_POLICY: readonly DunningPolicyStep[] = [
  { step: "statement", dayOffset: 0, channels: ["email", "sms"] },
  { step: "reminder", dayOffset: 7, channels: ["email", "sms"] },
  { step: "second_notice", dayOffset: 21, channels: ["email", "sms"] },
  { step: "final_notice", dayOffset: 35, channels: ["email", "sms", "letter"] },
  { step: "agency", dayOffset: 60, channels: [] },
];

/** A run is only opened for balances at or above this floor (cents). Below it,
 *  the collections cost isn't worth the patient-experience hit. */
export const DUNNING_MIN_BALANCE_CENTS = 2500;

export type DunningPauseReason = "payment_plan_active" | "autopay_enrolled";

export type DunningDecision =
  | { type: "resolve"; reason: "paid" }
  | { type: "pause"; reason: DunningPauseReason }
  | { type: "wait" }
  | { type: "send"; step: DunningStep; channels: DunningChannel[] }
  | { type: "handoff" };

export interface DunningDecisionInput {
  currentStep: DunningStep;
  /** When the current step is due (ISO `YYYY-MM-DD`), or null to act now. */
  nextActionAt: string | null;
  balanceCents: number;
  hasActivePaymentPlan: boolean;
  hasAutopay: boolean;
  today: string;
  policy?: readonly DunningPolicyStep[];
}

function dayOf(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}`);
  return Number.isNaN(t) ? null : t;
}

/**
 * Decide what a dunning tick should do for a run. Resolution and pause checks
 * come FIRST and on every tick, so a balance paid (or a plan started) between
 * touches stops the ladder immediately rather than sending another notice.
 * Pure + total.
 */
export function decideDunningAction(
  input: DunningDecisionInput,
): DunningDecision {
  // 1. Paid off — stop, regardless of where on the ladder we were.
  if (input.balanceCents <= 0) {
    return { type: "resolve", reason: "paid" };
  }
  // 2. On a plan / autopay — pause (the run resumes only if it lapses unpaid).
  if (input.hasActivePaymentPlan) {
    return { type: "pause", reason: "payment_plan_active" };
  }
  if (input.hasAutopay) {
    return { type: "pause", reason: "autopay_enrolled" };
  }
  // 3. Not yet due — wait.
  if (input.nextActionAt) {
    const due = dayOf(input.nextActionAt);
    const now = dayOf(input.today);
    if (due !== null && now !== null && now < due) {
      return { type: "wait" };
    }
  }
  // 4. Terminal step — hand off to the agency export (never auto-send).
  if (input.currentStep === "agency" || input.currentStep === "resolved") {
    return { type: "handoff" };
  }
  // 5. Due — send this step on its policy channels.
  const policy = input.policy ?? DEFAULT_DUNNING_POLICY;
  const stepDef = policy.find((s) => s.step === input.currentStep);
  return {
    type: "send",
    step: input.currentStep,
    channels: stepDef ? [...stepDef.channels] : [],
  };
}

export interface NextDunningStep {
  step: DunningStep;
  /** ISO `YYYY-MM-DD` the next step becomes due. */
  nextActionAt: string;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Given the step just sent and the date the run opened, return the next step +
 * its due date, or null if the ladder is exhausted (the just-sent step was the
 * last). Pure.
 */
export function nextDunningStep(
  sentStep: DunningStep,
  openedOn: string,
  policy: readonly DunningPolicyStep[] = DEFAULT_DUNNING_POLICY,
): NextDunningStep | null {
  const idx = policy.findIndex((s) => s.step === sentStep);
  if (idx < 0 || idx + 1 >= policy.length) return null;
  const next = policy[idx + 1]!;
  return {
    step: next.step,
    nextActionAt: addDaysIso(openedOn, next.dayOffset),
  };
}

/**
 * Whether a fresh run should be opened for a patient with this balance and
 * plan/autopay state. Pure.
 */
export function shouldOpenDunningRun(
  balanceCents: number,
  hasActivePaymentPlan: boolean,
  hasAutopay: boolean,
  minBalanceCents: number = DUNNING_MIN_BALANCE_CENTS,
): boolean {
  if (balanceCents < minBalanceCents) return false;
  if (hasActivePaymentPlan || hasAutopay) return false;
  return true;
}
