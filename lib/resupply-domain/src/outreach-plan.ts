// resolveOutreachPlan — picks the cadence (in days) and channel the
// eligibility engine should use for a single (patient, prescription)
// pair, given the currently-active set of frequency rules.
//
// Why this lives in @workspace/resupply-domain:
//   The decision is pure — no DB, no clock except what's passed in,
//   no network. Keeping it pure means the worker, the API (when
//   showing a "what would happen if we contacted this patient now"
//   preview), and tests can all reason about the same code without
//   spinning up Postgres. ADR 008 forbids I/O in this package.
//
// Resolution order (matches the schema doc on
//   `lib/resupply-db/src/schema/frequency-rules.ts`):
//
//   1. Per-patient override
//        - `patient.cadenceOverrideDays !== null` → use it. The matched
//          rule (if any) does not get to overwrite the cadence.
//        - `patient.channelPreference !== null`   → use it. Same idea.
//      Each override is independent: an admin can override cadence
//      but not channel, or vice versa.
//
//   2. Rules
//        Filter to active rules; sort by (priority asc, createdAt asc).
//        Walk the list and pick the FIRST rule for which every set
//        predicate matches:
//          - matchItemSkuPrefix:    null → matches anything; otherwise
//                                   `prescription.itemSku` must start
//                                   with the prefix.
//          - matchInsurancePayer:   null → matches anything; otherwise
//                                   exact match against `patient.insurancePayer`.
//                                   If the patient has no payer on file
//                                   the rule is treated as not matching.
//          - minTenureDays:         tenure must be >= this; null → no min.
//          - maxTenureDays:         tenure must be <= this; null → no max.
//        Tenure is `(now - patient.createdAt)` in whole days, computed
//        once per call.
//        The matched rule fills any field still unresolved
//        (cadenceDays from the rule; channel from the rule's
//        defaultChannel if non-null).
//
//   3. Fallback
//        Anything still unresolved falls back to:
//          cadenceDays → `prescription.cadenceDays` (today's behavior)
//          channel     → `"sms"` if patient has a phone, else `"email"`.
//        This is the legacy behavior the worker had before this helper
//        existed, preserved deliberately so deploying with zero rules
//        and zero overrides changes nothing operationally.
//
// `cadenceSource` / `channelSource` are returned for the dashboard's
// "why is this patient on this schedule?" UX and for audit-log writes.

export const OUTREACH_CHANNELS = ["sms", "email", "voice"] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export type CadenceSource = "patient_override" | "rule" | "prescription";
export type ChannelSource =
  | "patient_override"
  | "rule"
  | "default_sms"
  | "default_email";

export interface OutreachPatient {
  id: string;
  /** When the patient was first added — drives tenure. */
  createdAt: Date;
  /** Free-text payer name; `null` means unknown. */
  insurancePayer: string | null;
  /** Per-patient cadence override in days, or `null`. */
  cadenceOverrideDays: number | null;
  /** Per-patient channel override, or `null`. */
  channelPreference: OutreachChannel | null;
  /** Whether the patient has a phone number on file (drives the
   *  legacy SMS-then-email fallback). The domain package never sees
   *  the phone itself — that is encrypted PHI living in the DB. */
  hasPhone: boolean;
}

export interface OutreachPrescription {
  itemSku: string;
  cadenceDays: number;
}

export interface OutreachRule {
  id: string;
  priority: number;
  createdAt: Date;
  active: boolean;
  matchItemSkuPrefix: string | null;
  matchInsurancePayer: string | null;
  minTenureDays: number | null;
  maxTenureDays: number | null;
  cadenceDays: number;
  defaultChannel: OutreachChannel | null;
}

export interface ResolveOutreachPlanInput {
  patient: OutreachPatient;
  prescription: OutreachPrescription;
  rules: readonly OutreachRule[];
  /** Treated as the current moment for tenure math. Pass `new Date()`
   *  in production; tests pass a fixed instant for determinism. */
  now: Date;
}

export interface OutreachPlan {
  cadenceDays: number;
  cadenceSource: CadenceSource;
  channel: OutreachChannel;
  channelSource: ChannelSource;
  /** The id of the rule that contributed (cadence and/or channel),
   *  or `null` if no rule was consulted (override or fallback only). */
  matchedRuleId: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function tenureInDays(createdAt: Date, now: Date): number {
  // Whole-day tenure — fractional days never participate in rule
  // matches, which keeps the behavior independent of the time of day
  // the worker happens to scan.
  return Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS);
}

function ruleMatches(
  rule: OutreachRule,
  patient: OutreachPatient,
  prescription: OutreachPrescription,
  tenure: number,
): boolean {
  if (!rule.active) return false;
  if (
    rule.matchItemSkuPrefix !== null &&
    !prescription.itemSku.startsWith(rule.matchItemSkuPrefix)
  ) {
    return false;
  }
  if (rule.matchInsurancePayer !== null) {
    // A rule that requires a specific payer can only match patients
    // whose payer is recorded AND equal. Patients with NULL payer do
    // not match a payer-constrained rule — admins have to record
    // the payer first. This is the safe default: silently matching
    // unknown-payer patients to a payer-specific rule would route
    // outreach into a regime they shouldn't be in.
    if (
      patient.insurancePayer === null ||
      patient.insurancePayer !== rule.matchInsurancePayer
    ) {
      return false;
    }
  }
  if (rule.minTenureDays !== null && tenure < rule.minTenureDays) {
    return false;
  }
  if (rule.maxTenureDays !== null && tenure > rule.maxTenureDays) {
    return false;
  }
  return true;
}

export function resolveOutreachPlan(
  input: ResolveOutreachPlanInput,
): OutreachPlan {
  const { patient, prescription, rules, now } = input;
  const tenure = tenureInDays(patient.createdAt, now);

  // Sort defensively — callers may pass rules in any order. Stable
  // priority asc, then createdAt asc as a tie-breaker so the earliest
  // rule of equal priority wins (operationally, "the rule that's
  // been around longest is the safer default").
  const sortedRules = [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const matched =
    sortedRules.find((r) => ruleMatches(r, patient, prescription, tenure)) ??
    null;

  // Cadence resolution.
  let cadenceDays: number;
  let cadenceSource: CadenceSource;
  if (patient.cadenceOverrideDays !== null) {
    cadenceDays = patient.cadenceOverrideDays;
    cadenceSource = "patient_override";
  } else if (matched !== null) {
    cadenceDays = matched.cadenceDays;
    cadenceSource = "rule";
  } else {
    cadenceDays = prescription.cadenceDays;
    cadenceSource = "prescription";
  }

  // Channel resolution. The matched rule's defaultChannel is consulted
  // only when the patient hasn't overridden — and only when the rule
  // actually opined on channel (defaultChannel may be null even on a
  // matched rule).
  let channel: OutreachChannel;
  let channelSource: ChannelSource;
  if (patient.channelPreference !== null) {
    channel = patient.channelPreference;
    channelSource = "patient_override";
  } else if (matched !== null && matched.defaultChannel !== null) {
    channel = matched.defaultChannel;
    channelSource = "rule";
  } else if (patient.hasPhone) {
    channel = "sms";
    channelSource = "default_sms";
  } else {
    channel = "email";
    channelSource = "default_email";
  }

  return {
    cadenceDays,
    cadenceSource,
    channel,
    channelSource,
    matchedRuleId: matched?.id ?? null,
  };
}
