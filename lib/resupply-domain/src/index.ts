// @workspace/resupply-domain
// Pure TypeScript domain models, value objects, and business rules (eligibility engine, consent rules, scheduling logic). NO I/O — no DB, no network, no filesystem. Imports are restricted to zod + plain TypeScript only. See ADR 008.

export { RENEWAL_WINDOW_DAYS } from "./dispatcher-constants";

export {
  COMPLIANT_MINUTES_PER_NIGHT,
  COMPLIANCE_NIGHT_RATIO,
  WINDOW_DAYS,
  ATTESTATION_HORIZON_DAYS,
  CMS_COMPLIANT_NIGHTS,
  findBestAdherenceWindow,
  type AdherenceNight,
  type AdherenceWindow,
  type AdherenceResult,
} from "./cms-adherence";

export { normalizeE164, type NormalizeE164Options } from "./phone";

export { timezoneForUsState } from "./us-timezone";

export {
  resolveOutreachPlan,
  OUTREACH_CHANNELS,
  type OutreachChannel,
  type CadenceSource,
  type ChannelSource,
  type OutreachPatient,
  type OutreachPrescription,
  type OutreachRule,
  type ResolveOutreachPlanInput,
  type OutreachPlan,
} from "./outreach-plan";

export {
  resolveResupplyEntitlement,
  ENTITLEMENT_STATUSES,
  type EntitlementStatus,
  type ResupplyEntitlementInput,
  type ResupplyEntitlementResult,
} from "./entitlement";

export {
  resolveRefillWindow,
  REFILL_CONTACT_LEAD_DAYS,
  REFILL_SHIP_LEAD_DAYS,
  REFILL_AFFIRMATION_STATEMENT,
  type RefillWindowInput,
  type RefillWindowResult,
} from "./refill-window";

export {
  computeMargin,
  aggregateMargin,
  type MarginInput,
  type MarginResult,
  type MarginAggregate,
} from "./margin";

export {
  evaluateThreshold,
  breachPersists,
  THRESHOLD_COMPARISONS,
  THRESHOLD_MODES,
  type ThresholdComparison,
  type ThresholdMode,
  type ThresholdRule,
  type ThresholdEvalResult,
} from "./metric-threshold";

export {
  timelyFilingStatus,
  type TimelyFilingStatus,
  type TimelyFilingInput,
  type TimelyFilingResult,
} from "./timely-filing";

export {
  parsePeriodRange,
  computeGoalPace,
  type GoalPaceStatus,
  type GoalPaceProjectionConfidence,
  type PeriodRange,
  type GoalPaceInput,
  type GoalPaceResult,
} from "./goal-pace";

export {
  buildLtvCacReport,
  type AcquisitionChannel,
  type CustomerEconomicsInput,
  type ChannelEconomics,
  type LtvCacReport,
} from "./ltv-cac";

export {
  generateInstallmentSchedule,
  computePlanSummary,
  derivePlanStatus,
  type PlanFrequency,
  type ScheduledInstallment,
  type InstallmentStatus,
  type InstallmentRow,
  type PlanSummary,
} from "./payment-plan";

export {
  evaluateSameOrSimilar,
  SAME_OR_SIMILAR_STATUSES,
  SAME_OR_SIMILAR_WINDOW_MONTHS,
  type SameOrSimilarStatus,
  type SameOrSimilarInput,
  type SameOrSimilarResult,
} from "./same-or-similar";

export { prorateCents, type ProrationInput } from "./proration";

export {
  patientRespBreakdown,
  PR_DEDUCTIBLE_CARC,
  PR_COINSURANCE_CARC,
  PR_COPAY_CARC,
  type EraAdjustment,
  type EraClaimAdjustments,
  type PatientRespBreakdown,
} from "./era-patient-responsibility";

export {
  validateSwoCompleteness,
  isSwoComplete,
  type SwoInputs,
  type SwoValidationError,
} from "./written-order";

export {
  buildVerificationWorklist,
  classifyEligibilityRecency,
  DEFAULT_ELIGIBILITY_STALE_DAYS,
  DEFAULT_ELIGIBILITY_TERMINATION_LOOKAHEAD_DAYS,
  type CoverageInput,
  type VerificationStatus,
  type VerificationWorkItem,
  type VerificationWorklist,
} from "./eligibility-recheck";

export {
  deriveSecondaryCob,
  filterSecondaryEligible,
  type CobDerivation,
  type CobIneligibleReason,
  type EligibleCandidate,
  type EligibleItem,
  type PrimaryClaimTotals,
  type SecondaryCob,
} from "./secondary-cob";
