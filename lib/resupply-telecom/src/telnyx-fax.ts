// @workspace/resupply-telecom — Telnyx Programmable Fax REST client.
//
// Faxes are sent through Telnyx (Twilio retired Programmable Fax). We
// call the Telnyx v2 REST API (https://api.telnyx.com/v2/faxes)
// directly with Node's global fetch and a Bearer API key. Same pattern
// as client.ts / sms.ts: narrow surface, constructor-time config
// validation, test seam.
//
// Environment:
//   - TELNYX_API_KEY            — required. Bearer key from the Telnyx
//                                 portal (Keys & Credentials).
//   - TELNYX_FAX_CONNECTION_ID  — required. The Fax Application
//                                 ("connection") ID that owns the
//                                 fax-enabled number and the inbound
//                                 webhook config.
//   - TELNYX_FAX_FROM_NUMBER    — E.164 fax-enabled Telnyx number
//                                 (read by the route layer, passed in
//                                 as `from`).
//
// PHI note: neither the recipient fax number nor the media URL are
// logged here. Log posture is the caller's responsibility.

/**
 * Errors thrown by the Telnyx fax client. Mirrors the Twilio
 * Config/Api split so route handlers can distinguish unrecoverable
 * misconfig (`TelnyxConfigError`) from transient upstream failures
 * (`TelnyxApiError`).
 */
export class TelnyxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelnyxConfigError";
  }
}

export class TelnyxApiError extends Error {
  readonly status?: number;
  readonly code?: number | string;
  constructor(message: string, status?: number, code?: number | string) {
    super(message);
    this.name = "TelnyxApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Telnyx fax resolution quality. Telnyx's enum differs from Twilio's
 * "standard | fine | superfine". "high" is our default and is a good
 * match for medical cover letters; "very_high" / "ultra" trade
 * transmission time for resolution.
 */
export type TelnyxFaxQuality = "normal" | "high" | "very_high" | "ultra";

export interface SendFaxInput {
  /** E.164 recipient fax number, e.g. "+12155551212". */
  to: string;
  /** E.164 Telnyx fax-enabled number to send from. */
  from: string;
  /** Publicly accessible URL of the PDF to transmit. */
  mediaUrl: string;
  /**
   * Per-fax webhook override. Telnyx posts this fax's lifecycle events
   * (fax.queued / fax.sending.started / fax.delivered / fax.failed)
   * here; without it they go to the connection's configured webhook
   * URL. We set it to the unified /fax/webhook endpoint; inbound
   * `fax.received` stays on the connection-level webhook URL, and the
   * single handler routes both directions by event_type.
   */
  statusCallbackUrl?: string;
  /** Fax quality. Defaults to "high". */
  quality?: TelnyxFaxQuality;
}

export interface SendFaxResult {
  /** Telnyx fax id (UUID), e.g. "c62be5bc-9b13-…". Stored as vendor_ref. */
  id: string;
  /** Initial status returned by Telnyx — typically "queued". */
  status: string;
}

export interface TelnyxFaxClient {
  sendFax(input: SendFaxInput): Promise<SendFaxResult>;
}

/** The JSON body POSTed to the Telnyx Faxes endpoint. */
export interface TelnyxFaxRequestBody {
  connection_id: string;
  to: string;
  from: string;
  media_url: string;
  quality: TelnyxFaxQuality;
  webhook_url?: string;
}

/** Test-only seam: replace the fetch call without touching global fetch. */
export type FaxHttpSend = (
  url: string,
  apiKey: string,
  body: TelnyxFaxRequestBody,
) => Promise<SendFaxResult>;

export interface CreateTelnyxFaxClientOptions {
  apiKey?: string;
  connectionId?: string;
  /** Test-only seam. Production callers leave undefined. */
  httpSend?: FaxHttpSend;
}

const FAX_API_URL = "https://api.telnyx.com/v2/faxes";

/**
 * Build a TelnyxFaxClient.
 *
 * Reads credentials from the environment when options are unset.
 * Throws TelnyxConfigError at construction when credentials are
 * missing — better to fail at startup than inside a route handler.
 */
export function createTelnyxFaxClient(
  opts: CreateTelnyxFaxClientOptions = {},
): TelnyxFaxClient {
  const apiKey = opts.apiKey ?? process.env.TELNYX_API_KEY;
  const connectionId =
    opts.connectionId ?? process.env.TELNYX_FAX_CONNECTION_ID;

  if (!apiKey) {
    throw new TelnyxConfigError(
      "TELNYX_API_KEY is not set — refusing to construct Telnyx fax client.",
    );
  }
  if (!connectionId) {
    throw new TelnyxConfigError(
      "TELNYX_FAX_CONNECTION_ID is not set — refusing to construct Telnyx fax client.",
    );
  }

  const send: FaxHttpSend = opts.httpSend ?? defaultHttpSend;

  return {
    async sendFax(input) {
      const body: TelnyxFaxRequestBody = {
        connection_id: connectionId,
        to: input.to,
        from: input.from,
        media_url: input.mediaUrl,
        quality: input.quality ?? "high",
      };
      if (input.statusCallbackUrl) {
        body.webhook_url = input.statusCallbackUrl;
      }

      try {
        return await send(FAX_API_URL, apiKey, body);
      } catch (err) {
        if (err instanceof TelnyxApiError || err instanceof TelnyxConfigError) {
          throw err;
        }
        const e = err as {
          status?: number;
          code?: number | string;
          message?: string;
        };
        throw new TelnyxApiError(
          e.message ?? "Telnyx fax API error",
          e.status,
          e.code,
        );
      }
    },
  };
}

async function defaultHttpSend(
  url: string,
  apiKey: string,
  body: TelnyxFaxRequestBody,
): Promise<SendFaxResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    if (!res.ok) {
      throw new TelnyxApiError(
        `Telnyx fax: non-JSON error response (HTTP ${res.status})`,
        res.status,
      );
    }
    throw new TelnyxApiError(
      `Telnyx fax: non-JSON response (HTTP ${res.status})`,
      res.status,
    );
  }

  const p = parsed as Record<string, unknown>;

  if (!res.ok) {
    // Telnyx errors come back as { errors: [{ code, title, detail }] }.
    const errors = Array.isArray(p["errors"])
      ? (p["errors"] as Array<Record<string, unknown>>)
      : [];
    const first = errors[0];
    const message =
      first && typeof first["detail"] === "string"
        ? first["detail"]
        : first && typeof first["title"] === "string"
          ? (first["title"] as string)
          : `Telnyx fax API error (HTTP ${res.status})`;
    const code =
      first &&
      (typeof first["code"] === "string" || typeof first["code"] === "number")
        ? (first["code"] as string | number)
        : undefined;
    throw new TelnyxApiError(message, res.status, code);
  }

  // Success envelope: { data: { id, status, ... } }.
  const data = p["data"];
  if (!data || typeof data !== "object") {
    throw new TelnyxApiError("Telnyx fax: response missing data", res.status);
  }
  const d = data as Record<string, unknown>;
  if (typeof d["id"] !== "string") {
    throw new TelnyxApiError("Telnyx fax: response missing id", res.status);
  }

  return {
    id: d["id"] as string,
    status:
      typeof d["status"] === "string" ? (d["status"] as string) : "queued",
  };
}
