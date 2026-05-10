// Public surface for @workspace/resupply-reminders.
//
// This package is the SHARED code path for outbound resupply reminders.
// Both the admin-facing API routes (POST /sms/send-reminder,
// POST /email/send-reminder) and the worker's pg-boss handlers
// (reminders.send-sms, reminders.send-email) call into the same two
// helpers — `sendReminderSms` and `sendReminderEmail`.
//
// Why a separate package (instead of inlining in the api):
//   - The worker is its own process and cannot import from
//     artifacts/resupply-api/. A shared helper has to live in lib/.
//   - Keeping the helpers here forces us to keep them
//     framework-agnostic: no Express, no req/res leak, no admin
//     auth coupling. The actor is passed in explicitly.
//
// Architecture rule (Rule 13): this package may import db, telecom,
// email, messaging, audit — but NOT twilio, @sendgrid/mail,
// openai, @anthropic-ai/sdk directly. Vendor SDKs are reached only
// through the resupply-{telecom,email} wrappers. All DB access goes
// through the Supabase client exported from `@workspace/resupply-db`.

export { sendReminderSms } from "./send-sms";
export type { SendReminderSmsInput } from "./send-sms";
export { sendReminderEmail } from "./send-email";
export type { SendReminderEmailInput } from "./send-email";
export { replyInConversation } from "./reply";
export type {
  ReplyInConversationInput,
  ReplyInConversationOutcome,
} from "./reply";
export type {
  EmailSendConfig,
  SendActor,
  SendReminderOutcome,
  SmsSendConfig,
} from "./types";
