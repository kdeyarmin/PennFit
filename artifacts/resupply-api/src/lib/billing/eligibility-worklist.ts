// Pure eligibility re-verification ranking (Biller #31).
//
// The classification logic now lives in @workspace/resupply-domain
// (`eligibility-recheck.ts`, ADR 008) so both the route (read half) and the
// batch runner (write half) — AND the SPA — share the exact same urgency
// classification without a route↔lib import cycle. This module re-exports
// the pure helpers so existing importers keep their `./eligibility-worklist`
// import path. No I/O here.

export {
  buildVerificationWorklist,
  classifyEligibilityRecency,
  DEFAULT_ELIGIBILITY_STALE_DAYS,
  DEFAULT_ELIGIBILITY_TERMINATION_LOOKAHEAD_DAYS,
  type CoverageInput,
  type VerificationStatus,
  type VerificationWorkItem,
  type VerificationWorklist,
} from "@workspace/resupply-domain";
