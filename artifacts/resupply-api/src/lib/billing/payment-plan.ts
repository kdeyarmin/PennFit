// Patient payment-plan math (biller #B7). Pure + I/O-free: installment
// schedule generation, plan-status derivation, and an A/R summary. Money
// movement (Stripe auto-charge) is intentionally NOT here — this slice
// is the schedule + tracking the biller/CSR uses to manage a patient
// balance paid over time; charging is a follow-up.
//
// The pure math now lives in the canonical domain package
// (@workspace/resupply-domain, ADR 008) so the SPA can reuse it. This
// module re-exports it unchanged so existing importers keep their path.

export {
  generateInstallmentSchedule,
  computePlanSummary,
  derivePlanStatus,
  type PlanFrequency,
  type ScheduledInstallment,
  type InstallmentStatus,
  type InstallmentRow,
  type PlanSummary,
} from "@workspace/resupply-domain";
