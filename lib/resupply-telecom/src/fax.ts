// @workspace/resupply-telecom — Twilio Programmable Fax REST client.
//
// Twilio SDK v5 removed fax support, so we call the Twilio Fax REST
// API (https://fax.twilio.com/v1/Faxes) directly with Node's global
// fetch and HTTP Basic auth. Same pattern as client.ts / sms.ts:
// narrow surface, constructor-time config validation, test seam.
//
// Environment:
//   - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN — required (shared with
//     SMS and voice).
//   - TWILIO_FAX_FROM_NUMBER — E.164 fax-enabled Twilio number.
//
// PHI note: neither the recipient fax number nor the media URL are
// logged here. Log posture is the caller's responsibility.

import { TwilioApiError, TwilioConfigError } from "./client.js";

export interface SendFaxInput {
  /** E.164 recipient fax number, e.g. "+12155551212". */
  to: string;
  /** E.164 Twilio fax-enabled number to send from. */
  from: string;
  /** Publicly accessible URL of the PDF or TIFF to transmit. */
  mediaUrl: string;
  /** Webhook URL Twilio POSTs delivery lifecycle events to. */
  statusCallbackUrl?: string;
  /**
   * Fax quality. "fine" is the default and is suitable for medical
   * cover letters. "superfine" doubles resolution at the cost of
   * longer transmission time.
   */
  quality?: "standard" | "fine" | "superfine";
}

export interface SendFaxResult {
  /** Twilio fax SID, e.g. "FXxxxxxxxx..." */
  sid: string;
  /** Initial status returned by Twilio — typically "queued". */
  status: string;
}

export interface TwilioFaxClient {
  sendFax(input: SendFaxInput): Promise<SendFaxResult>;
}

/** Test-only seam: replace the fetch call without touching global fetch. */
export type FaxHttpSend = (
  url: string,
  basicAuth: string,
  body: string,
) => Promise<SendFaxResult>;

export interface CreateTwilioFaxClientOptions {
  accountSid?: string;
  authToken?: string;
  /** Test-only seam. Production callers leave undefined. */
  httpSend?: FaxHttpSend;
}

const FAX_API_URL = "https://fax.twilio.com/v1/Faxes";

/**
 * Build a TwilioFaxClient.
 *
 * Reads credentials from the environment when options are unset.
 * Throws TwilioConfigError at construction when credentials are
 * missing — better to fail at startup than inside a route handler.
 */
export function createTwilioFaxClient(
  opts: CreateTwilioFaxClientOptions = {},
): TwilioFaxClient {
  const accountSid = opts.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken = opts.authToken ?? process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid) {
    throw new TwilioConfigError(
      "TWILIO_ACCOUNT_SID is not set — refusing to construct Twilio fax client.",
    );
  }
  if (!authToken) {
    throw new TwilioConfigError(
      "TWILIO_AUTH_TOKEN is not set — refusing to construct Twilio fax client.",
    );
  }

  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString(
    "base64",
  );
  const send: FaxHttpSend = opts.httpSend ?? defaultHttpSend;

  return {
    async sendFax(input) {
      const params = new URLSearchParams({
        To: input.to,
        From: input.from,
        MediaUrl: input.mediaUrl,
        Quality: input.quality ?? "fine",
      });
      if (input.statusCallbackUrl) {
        params.set("StatusCallback", input.statusCallbackUrl);
      }

      try {
        return await send(FAX_API_URL, basicAuth, params.toString());
      } catch (err) {
        if (err instanceof TwilioApiError || err instanceof TwilioConfigError) {
          throw err;
        }
        const e = err as {
          status?: number;
          code?: number | string;
          message?: string;
        };
        throw new TwilioApiError(
          e.message ?? "Twilio fax API error",
          e.status,
          e.code,
        );
      }
    },
  };
}

async function defaultHttpSend(
  url: string,
  basicAuth: string,
  body: string,
): Promise<SendFaxResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new TwilioApiError(
      `Twilio fax: non-JSON response (HTTP ${res.status})`,
      res.status,
    );
  }

  const p = parsed as Record<string, unknown>;

  if (!res.ok) {
    throw new TwilioApiError(
      typeof p["message"] === "string"
        ? p["message"]
        : `Twilio fax API error (HTTP ${res.status})`,
      res.status,
      typeof p["code"] === "number" ? p["code"] : undefined,
    );
  }

  if (typeof p["sid"] !== "string") {
    throw new TwilioApiError(
      "Twilio fax: response missing sid",
      res.status,
    );
  }

  return {
    sid: p["sid"] as string,
    status:
      typeof p["status"] === "string" ? (p["status"] as string) : "queued",
  };
}
