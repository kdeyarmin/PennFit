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
