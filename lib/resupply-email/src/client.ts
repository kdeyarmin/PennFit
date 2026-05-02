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

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigError";
  }
}

export class EmailApiError extends Error {
  readonly status?: number;
  readonly responseBody?: unknown;
  constructor(message: string, status?: number, responseBody?: unknown) {
    super(message);
    this.name = "EmailApiError";
    this.status = status;
    this.responseBody = responseBody;
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
}

export interface SendgridClient {
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
}

/**
 * Build a SendgridClient.
 *
 * Reads SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, SENDGRID_FROM_NAME from
 * the environment when options are unset. Throws EmailConfigError at
 * construction (NOT at first send) when any required value is missing.
 *
 * Production fail-closed: a missing API key or From address should never
 * silently degrade to "email didn't go out" — it must surface as a 503
 * at the route handler so admins see the misconfig immediately.
 */
export function createSendgridClient(
  opts: CreateSendgridClientOptions = {},
): SendgridClient {
  const apiKey = opts.apiKey ?? process.env.SENDGRID_API_KEY;
  const fromEmail = opts.fromEmail ?? process.env.SENDGRID_FROM_EMAIL;
  const fromName = opts.fromName ?? process.env.SENDGRID_FROM_NAME;

  if (!apiKey) {
    throw new EmailConfigError(
      "SENDGRID_API_KEY is not set — refusing to construct SendGrid client.",
    );
  }
  if (!fromEmail) {
    throw new EmailConfigError(
      "SENDGRID_FROM_EMAIL is not set — refusing to construct SendGrid client.",
    );
  }

  const sg: RawSendgridSdk = opts.sgFactory ? opts.sgFactory() : sgMail;

  return {
    async sendEmail(input) {
      sg.setApiKey(apiKey);
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
          code?: number;
          response?: { body?: unknown; statusCode?: number };
          message?: string;
        };
        throw new EmailApiError(
          e.message ?? "SendGrid API error",
          e.response?.statusCode ?? e.code,
          e.response?.body,
        );
      }
    },
  };
}
