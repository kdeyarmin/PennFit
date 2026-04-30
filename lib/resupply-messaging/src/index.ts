// @workspace/resupply-messaging — pure semantic layer for SMS + Email.
//
// This package contains:
//   - Intent enum shared between scripted routing + AI fallback.
//   - SMS keyword router (regex/token only — no LLM, no I/O).
//   - Email body templates (pure string render).
//   - Signed-link token builder/verifier (HMAC-SHA256).
//   - The AI-fallback adapter INTERFACE (implementation lives in the
//     API layer, see Rule 11 in scripts/check-resupply-architecture.sh).
//
// MUST NOT IMPORT: pg, @workspace/resupply-db, twilio, @sendgrid/mail,
// openai, @anthropic-ai/sdk, ws. The architecture check fails the
// build if any of these ever land here.

export {
  INTENT_NAMES,
  assertNeverIntent,
  type Intent,
} from "./intents";

export {
  parseSmsIntent,
  type KeywordRouterResult,
} from "./keyword-router";

export {
  signLinkToken,
  verifyLinkToken,
  LINK_ACTIONS,
  type LinkAction,
  type SignLinkTokenInput,
  type VerifyLinkTokenResult,
  type VerifyLinkTokenOptions,
} from "./signed-link-tokens";

export {
  renderResupplyReminder,
  renderClickConfirmation,
  renderClickError,
  escapeHtml,
  type RenderResupplyReminderInput,
  type RenderedEmail,
  type RenderClickConfirmationInput,
  type RenderClickErrorInput,
} from "./email-templates";

export {
  type AiFallbackAdapter,
  type AiFallbackInput,
  type AiFallbackResult,
} from "./ai-fallback";
