// Re-exports for the resupply test fixture factories. Test code should
// import from `@workspace/resupply-testing` (top-level) rather than
// reach into `factories/` directly — the top-level barrel is what gets
// pinned by Rule 5 of the architecture check (no production code may
// import this package).

export { makePatient, type PatientFixtureSpec } from "./patient";
export {
  makePrescription,
  type PrescriptionFixtureSpec,
} from "./prescription";
export { makeEpisode, type EpisodeFixtureSpec } from "./episode";
export {
  makeConversation,
  type ConversationFixtureSpec,
} from "./conversation";
export { makeMessage, type MessageFixtureSpec } from "./message";
export {
  makeFulfillment,
  type FulfillmentFixtureSpec,
} from "./fulfillment";
export { makeAuditLog, type AuditLogFixtureSpec } from "./audit-log";
