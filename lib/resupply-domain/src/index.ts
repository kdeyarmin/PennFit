// @workspace/resupply-domain
// Pure TypeScript domain models, value objects, and business rules (eligibility engine, consent rules, scheduling logic). NO I/O — no DB, no network, no filesystem. Imports are restricted to zod + plain TypeScript only. See ADR 008.

export { RENEWAL_WINDOW_DAYS } from "./dispatcher-constants";

export { normalizeE164 } from "./phone";

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
  computeMargin,
  aggregateMargin,
  type MarginInput,
  type MarginResult,
  type MarginAggregate,
} from "./margin";

export {
  evaluateThreshold,
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
