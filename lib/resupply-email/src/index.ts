// @workspace/resupply-email — SendGrid adapter.
//
// Public surface intentionally narrow: send + signature validate +
// event payload parse. Architecture rule 12 (see
// `scripts/check-resupply-architecture.sh`) forbids importing
// `@workspace/resupply-db`, `pg`, `twilio`, `openai`, or
// `@anthropic-ai/sdk` from this package.

export {
  createSendgridClient,
  DEFAULT_SENDGRID_FROM_EMAIL,
  DEFAULT_SENDGRID_FROM_NAME,
  EmailConfigError,
  EmailApiError,
  type SendEmailInput,
  type SendEmailResult,
  type SendgridClient,
  type CreateSendgridClientOptions,
  type RawSendgridSdk,
} from "./client";

export {
  validateSendgridSignature,
  requireSendgridSignature,
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
  type ValidateSendgridSignatureInput,
  type RequireSendgridSignatureOptions,
  type SendgridSigRequestLike,
  type SendgridSigResponseLike,
  type SendgridSigNext,
} from "./signature";

export {
  isTransientSendgridError,
  withRetry,
  computeBackoffMs,
  DEFAULT_EMAIL_RETRY_POLICY,
  type RetryPolicy,
  type WithRetryHooks,
} from "./retry";

export {
  renderBrandedEmail,
  brandedButton,
  paragraph,
  textParagraph,
  escapeHtml,
  secondaryLink,
  subheading,
  divider,
  lineItemsTable,
  summaryRows,
  infoPanel,
  bulletList,
  BREATHE_COLORS,
  PLATFORM_BRAND_NAME,
  type BrandedEmailOptions,
  type BrandedEmailButton,
  type EmailLineItem,
  type EmailSummaryRow,
  type EmailPanelOptions,
  type EmailPanelTone,
} from "./layout";

export {
  parseSendgridEventBatch,
  sendgridEventSchema,
  sendgridEventBatchSchema,
  SENDGRID_HANDLED_EVENTS,
  type SendgridEvent,
  type SendgridEventBatch,
  type SendgridHandledEvent,
} from "./events";
