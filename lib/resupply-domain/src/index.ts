// @workspace/resupply-domain
// Pure TypeScript domain models, value objects, and business rules (eligibility engine, consent rules, scheduling logic). NO I/O — no DB, no network, no filesystem. Imports are restricted to zod + plain TypeScript only. See ADR 008.

export { RENEWAL_WINDOW_DAYS } from "./dispatcher-constants";

export {
  PLAN_FEATURE_FLAG_PRESETS,
  DELIBERATELY_OFF_FLAGS,
  resolvePlanFlagPreset,
  type BillingPlanCode,
} from "./feature-flag-presets";

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

export {
  scoreAdherenceTarget,
  type AdherenceLevel,
  type AdherenceTargetScore,
} from "./adherence-target";

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

export {
  pickCappedRentalModifiers,
  decideCappedRentalAdvance,
  CAPPED_RENTAL_KX_HCPCS,
  CAPPED_RENTAL_CYCLE_DAYS,
  type CappedRentalAction,
  type CappedRentalAdvanceInput,
  type CappedRentalAdvanceDecision,
} from "./capped-rental";

export {
  ruleApplies,
  resolveModifiersFromRules,
  buildAbnScope,
  abnCoversHcpcs,
  MODIFIER_CONDITIONS,
  type PayerModifierCondition,
  type ModifierRuleContext,
  type ModifierRuleRow,
  type AbnScope,
} from "./payer-modifiers";

export {
  classifyExpiry,
  headsUpSeverity,
  PRIOR_AUTH_HEADS_UP_DAYS,
  DWO_HEADS_UP_DAYS,
  HEADS_UP_CRITICAL_DAYS,
  type HeadsUpSeverity,
  type ExpiryState,
  type ExpiryClassification,
} from "./authorization-expiry";

export {
  classifyAdrSla,
  ADR_HEADS_UP_DAYS,
  ADR_AT_RISK_DAYS,
  type AdrSlaStatus,
  type AdrSlaClassification,
  type ClassifyAdrSlaOptions,
} from "./claim-adr";

export {
  AUDIT_PACKET_CATALOG,
  AUDIT_PACKET_ITEM_KEYS,
  getAuditPacketItem,
  isAuditPacketItemKey,
  defaultSelection,
  normalizeSelection,
  REQUIRED_AUDIT_ITEMS,
  assessAuditReadiness,
  coveredKeysFromDocumentTypes,
  type AuditItemSource,
  type AuditScope,
  type AuditItemGroup,
  type AuditPacketItem,
  type NormalizedSelection,
  type AuditReadiness,
} from "./audit-packet-catalog";

export {
  aggregateAdrOutcomes,
  type AdrOutcomeValue,
  type AdrOutcomeRow,
  type AdrSourceBucket,
  type AdrOutcomeAnalytics,
} from "./adr-analytics";

export {
  DEFAULT_DUNNING_POLICY,
  DUNNING_MIN_BALANCE_CENTS,
  decideDunningAction,
  nextDunningStep,
  shouldOpenDunningRun,
  type DunningStep,
  type DunningChannel,
  type DunningPolicyStep,
  type DunningPauseReason,
  type DunningDecision,
  type DunningDecisionInput,
  type NextDunningStep,
} from "./dunning";

export {
  classifyCustomerRecency,
  CUSTOMER_LAPSED_DAYS,
  WINBACK_COOLDOWN_DAYS,
  CUSTOMER_ACTIVE_LOOKBACK_DAYS,
  type CustomerRecency,
  type CustomerRecencyThresholds,
} from "./customer-recency";

export {
  COMFORT_GUARANTEE_DAYS,
  isWithinComfortGuarantee,
  evaluateAutoApprovalRules,
  formatAutoApprovalNote,
  AUTO_APPROVE_PRIOR_RETURN_CAP,
  AUTO_APPROVE_DEFECTIVE_MAX_AGE_DAYS,
  AUTO_APPROVE_WRONG_ITEM_MAX_AGE_DAYS,
  AUTO_APPROVE_ORDER_VALUE_CAP_CENTS,
  type ShopReturnReason,
  type AutoApprovalRule,
  type AutoApprovalDecision,
  type AutoApprovalInput,
} from "./return-window";
