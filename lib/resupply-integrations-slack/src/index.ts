// @workspace/resupply-integrations-slack — Slack notification + interactivity
// client for the operator/CS workspace.
//
// Public surface:
//   - readSlackConfigOrNull(env) / readSlackSigningSecretOrNull(env) —
//     fail-soft credential readers (null when unconfigured).
//   - postSlackMessage(config, input) — chat.postMessage, never throws.
//   - verifySlackSignature(input) — constant-time inbound request verifier.
//   - buildAlertBlocks(...) / buildFallbackText(...) — Block Kit builders.
//
// This package is push/verify only (not a pull IntegrationAdapter — Slack is
// outbound notifications + inbound webhooks, not a therapy-cloud snapshot
// source). It follows the same conventions as the other integration libs:
// fail-soft config readers and NO data-layer imports.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db.

export {
  readSlackConfigOrNull,
  readSlackSigningSecretOrNull,
  type SlackConfig,
} from "./config";
export {
  exchangeSlackOAuthCode,
  postSlackMessage,
  slackAuthTest,
  SLACK_OAUTH_SCOPES,
  type AuthTestResult,
  type OAuthExchangeInput,
  type OAuthExchangeResult,
  type PostMessageInput,
  type PostMessageOptions,
  type PostMessageResult,
} from "./client";
export {
  verifySlackSignature,
  type VerifySlackSignatureInput,
} from "./signature";
export {
  buildAlertBlocks,
  buildFallbackText,
  severityEmoji,
  type BuildAlertBlocksInput,
  type SlackAction,
  type SlackButtonAction,
  type SlackLinkAction,
  type SlackSeverity,
} from "./blocks";
