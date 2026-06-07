// @workspace/resupply-email — SendGrid client wrapper.
//
// Mirrors the shape of @workspace/resupply-telecom/client.ts:
//   - One narrow operation (sendEmail).
//   - Env read at call time, not module load.
//   - Mock seam (`sgFactory`) for route tests.
//   - Typed config errors so callers can branch on misconfig vs upstream
//     failure.
//
// This module is the wire to SendGrid. We refuse to send when the
// SENDGRID_API_KEY env var is missing, so a stub deploy without the
// key fails closed.

import sgMail from "@sendgrid/mail";

import {
  DEFAULT_EMAIL_RETRY_POLICY,
  isTransientSendgridError,
  withRetry,
  type RetryPolicy,
} from "./retry";

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigError";
  }
}

export class EmailApiError extends Error {
  readonly status?: number;
  readonly responseBody?: unknown;
  /**
   * True when this failure is transient (HTTP 429 / 5xx / transport
   * error) and the send was NOT accepted — i.e. it is safe to retry.
   * `sendEmail` exhausts its bounded in-process retry budget before
   * throwing, so a thrown `EmailApiError` with `retryable: true` means
   * every attempt failed; callers can treat it as a genuine outage.
   */
  readonly retryable: boolean;
  constructor(
    message: string,
    status?: number,
    responseBody?: unknown,
    retryable = false,
  ) {
    super(message);
    this.name = "EmailApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.retryable = retryable;
  }
}

export interface SendEmailInput {
  /** Recipient email address. */
  to: string;
  /** Subject line. MUST NOT contain PHI — subjects are not encrypted at any provider. */
  subject: string;
  /** HTML body. */
  html: string;
  /** Plain-text fallback body. Required — many corporate filters drop HTML-only mail. */
  text: string;
  /**
   * Optional Reply-To. Defaults to the From address. Useful when an
   * admin should receive bounces/replies at a different mailbox
   * than the noreply address.
   */
  replyTo?: string;
  /**
   * SendGrid `customArgs` — opaque key/value pairs echoed back on every
   * Event Webhook delivery for this message. We use this to round-trip
   * conversationId + outboundMessageId so the bounce/delivered handler
   * can correlate without a separate database lookup. Values must be
   * strings (SendGrid stringifies; we make it explicit).
   */
  customArgs?: Record<string, string>;
  /**
   * Optional file attachments. Each attachment must carry its own
   * MIME type — SendGrid uses it for the Content-Type header on
   * the attached part. The `content` field is the raw bytes; the
   * client base64-encodes them before handing them to the SDK
   * (the SDK's wire format expects base64).
   *
   * PHI posture: attachments ride the same channel as the rest of
   * the email and the same SENDGRID_FROM_EMAIL gate applies. Don't
   * attach anything you wouldn't put in a subject line — these are
   * not encrypted in transit beyond TLS to SendGrid.
   */
  attachments?: ReadonlyArray<{
    content: Buffer;
    filename: string;
    contentType: string;
  }>;
}

export interface SendEmailResult {
  /** SendGrid `X-Message-Id` from the response headers. */
  messageId: string;
}

/**
 * Minimal contract the @sendgrid/mail SDK must satisfy. Tests pass a
 * fake matching this shape; production binds to the real SDK.
 *
 * `setApiKey` is a setter — it's called once per `sendEmail` to keep
 * the client stateless across processes that handle multiple SendGrid
 * subaccounts (we don't today, but the cost of being explicit is zero).
 */
export interface RawSendgridSdk {
  setApiKey(key: string): void;
  send(msg: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    html: string;
    text: string;
    replyTo?: string;
    customArgs?: Record<string, string>;
    attachments?: {
      content: string; // base64-encoded
      filename: string;
      type: string;
      disposition: "attachment";
    }[];
  }): Promise<
    [
      {
        statusCode: number;
        headers: Record<string, string | string[]>;
        body?: unknown;
      },
      unknown,
    ]
  >;
}

export interface CreateSendgridClientOptions {
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
  /** Test-only seam. Production callers leave undefined. */
  sgFactory?: () => RawSendgridSdk;
  /**
   * Override the bounded in-process retry on transient SendGrid
   * failures (HTTP 429 / 5xx / network). Defaults to
   * {@link DEFAULT_EMAIL_RETRY_POLICY} (3 attempts). Set
   * `{ maxAttempts: 1 }` to disable. Test seam `sleep` lets specs
   * assert retry without real timers.
   */
  retry?: Partial<RetryPolicy> & { sleep?: (ms: number) => Promise<void> };
}

export interface SendgridClient {
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
}

/**
 * The platform's single outbound From address (ADR 016 / 018): one
 * sender identity — info@pennpaps.com — across every environment. Used
 * as the default when SENDGRID_FROM_EMAIL is unset so a deploy that only
 * has the API key still sends from the canonical address (and the admin
 * "connection test" can pass with just the key set).
 */
export const DEFAULT_SENDGRID_FROM_EMAIL = "info@pennpaps.com";

/**
 * Build a SendgridClient.
 *
 * Reads SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, SENDGRID_FROM_NAME from
 * the environment when options are unset. The API key is the only
 * required value — it throws EmailConfigError at construction (NOT at
 * first send) when it is missing. The From address is a fixed platform
 * constant: when SENDGRID_FROM_EMAIL is unset it defaults to
 * {@link DEFAULT_SENDGRID_FROM_EMAIL} (info@pennpaps.com), so the
 * "one From address" rule (ADR 016/018) holds with zero extra
 * configuration. SENDGRID_FROM_NAME is optional (display name only).
 *
 * Production fail-closed: a missing API key should never silently degrade
 * to "email didn't go out" — it must surface as a 503 at the route
 * handler so admins see the misconfig immediately.
 */
export function createSendgridClient(
  opts: CreateSendgridClientOptions = {},
): SendgridClient {
  const apiKey = opts.apiKey ?? process.env.SENDGRID_API_KEY;
  // One canonical sender identity (ADR 016/018). An explicit override
  // (option or env) still wins, but an unset/blank value falls back to
  // the platform constant rather than failing closed.
  const fromEmailOverride = opts.fromEmail ?? process.env.SENDGRID_FROM_EMAIL;
  const fromEmailCandidate = fromEmailOverride?.trim();
  const fromEmail =
    fromEmailCandidate && fromEmailCandidate !== ""
      ? fromEmailCandidate
      : DEFAULT_SENDGRID_FROM_EMAIL;
  const fromName = opts.fromName ?? process.env.SENDGRID_FROM_NAME;

  if (!apiKey) {
    throw new EmailConfigError(
      "SENDGRID_API_KEY is not set — refusing to construct SendGrid client.",
    );
  }

  const sg: RawSendgridSdk = opts.sgFactory ? opts.sgFactory() : sgMail;

  const retryPolicy: RetryPolicy = {
    maxAttempts:
      opts.retry?.maxAttempts ?? DEFAULT_EMAIL_RETRY_POLICY.maxAttempts,
    baseDelayMs:
      opts.retry?.baseDelayMs ?? DEFAULT_EMAIL_RETRY_POLICY.baseDelayMs,
    maxDelayMs: opts.retry?.maxDelayMs ?? DEFAULT_EMAIL_RETRY_POLICY.maxDelayMs,
  };
  const retrySleep = opts.retry?.sleep;

  return {
    async sendEmail(input) {
      // Defense-in-depth header-injection guard. SendGrid's v3 JSON API
      // does not interpret CR/LF as header separators (JSON encoding
      // escapes them), but a future migration to SMTP / a different
      // provider would inherit the unsafe values verbatim. Failing
      // loudly here also catches accidental bugs where caller-supplied
      // template variables containing newlines leak into the subject.
      if (/[\r\n]/.test(input.subject)) {
        throw new EmailConfigError(
          "Email subject contains a newline character (CR/LF). Header injection guard rejected the send.",
        );
      }
      if (/[\r\n]/.test(input.to)) {
        throw new EmailConfigError(
          "Email recipient contains a newline character (CR/LF). Header injection guard rejected the send.",
        );
      }
      if (input.replyTo && /[\r\n]/.test(input.replyTo)) {
        throw new EmailConfigError(
          "Email reply-to contains a newline character (CR/LF). Header injection guard rejected the send.",
        );
      }
      sg.setApiKey(apiKey);
      const attachments = input.attachments?.map((a) => ({
        content: a.content.toString("base64"),
        filename: a.filename,
        type: a.contentType,
        disposition: "attachment" as const,
      }));

      // A single send attempt. Transient SendGrid failures (429 / 5xx /
      // network) are classified here and re-thrown as a retryable
      // EmailApiError; `withRetry` re-runs this whole function with the
      // identical payload (idempotent — SendGrid never accepted the
      // failed attempt, so there is no duplicate-send risk).
      const attempt = async (): Promise<SendEmailResult> => {
        try {
          const [response] = await sg.send({
            to: input.to,
            from: fromName
              ? { email: fromEmail, name: fromName }
              : { email: fromEmail },
            subject: input.subject,
            html: input.html,
            text: input.text,
            replyTo: input.replyTo,
            customArgs: input.customArgs,
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          });
          // SendGrid returns the X-Message-Id in response headers; this is
          // the stable id we'll see echoed back on every Event Webhook
          // delivery for this message.
          const headerVal = response.headers["x-message-id"];
          const messageId =
            typeof headerVal === "string"
              ? headerVal
              : Array.isArray(headerVal)
                ? (headerVal[0] ?? "")
                : "";
          if (!messageId) {
            // A 2xx with no message id means the mail WAS accepted; do
            // not retry (would duplicate). Non-retryable EmailApiError.
            throw new EmailApiError(
              "SendGrid response did not include x-message-id header",
              response.statusCode,
              response.body,
            );
          }
          return { messageId };
        } catch (err) {
          if (err instanceof EmailApiError) throw err;
          const e = err as {
            code?: string | number;
            response?: { body?: unknown; statusCode?: number };
            message?: string;
          };
          const statusFromCode =
            typeof e.code === "number" ? e.code : undefined;
          throw new EmailApiError(
            e.message ?? "SendGrid API error",
            e.response?.statusCode ?? statusFromCode,
            e.response?.body,
            isTransientSendgridError(err),
          );
        }
      };

      return withRetry(attempt, retryPolicy, {
        shouldRetry: (err) =>
          err instanceof EmailApiError && err.retryable === true,
        sleep: retrySleep,
        onRetry: ({ attempt: n, nextDelayMs, err }) => {
          // PHI-free structured line: no recipient, no subject, no body.
          const status =
            err instanceof EmailApiError ? (err.status ?? null) : null;
          process.stderr.write(
            JSON.stringify({
              level: 40,
              event: "email_send_retry",
              vendor: "sendgrid",
              attempt: n,
              maxAttempts: retryPolicy.maxAttempts,
              nextDelayMs,
              status,
              msg: "Transient SendGrid failure — retrying send",
            }) + "\n",
          );
        },
      });
    },
  };
}
