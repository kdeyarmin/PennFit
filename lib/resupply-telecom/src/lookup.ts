// @workspace/resupply-telecom — Twilio Lookup v2 (line type intelligence).
//
// One operation: classify a phone number's LINE TYPE (mobile / landline /
// voip) so callers can tell whether a number is a cell. Used to gate
// bulk-campaign SMS to cellular numbers only.
//
// Same wrapper rationale as ./sms.ts: a narrow, mockable surface with
// centralised credential reading. Construction throws TwilioConfigError when
// creds are missing (fail-closed); a LOOKUP failure (network / 404 / vendor
// error) resolves to `"unknown"` rather than throwing — a classification
// blip must not break the caller, and "unknown" is the safe not-yet-known
// state (allowed to send under the allow-unknown policy).
//
// Endpoint: GET https://lookups.twilio.com/v2/PhoneNumbers/{E164}
//   ?Fields=line_type_intelligence   (HTTP Basic: AccountSid:AuthToken)

import { TwilioConfigError } from "./client";

/** Normalised line type the app stores + gates on. */
export type PhoneLineType = "mobile" | "landline" | "voip" | "unknown";

export interface LookupLineTypeResult {
  lineType: PhoneLineType;
  /** Raw Twilio `type` string (e.g. "nonFixedVoip"), or null when absent. */
  rawType: string | null;
}

export interface TwilioLookupHttpResponse {
  status: number;
  /** Parsed JSON body, or null when the body wasn't JSON. */
  json: unknown;
}

/** Injectable HTTP GET (test seam). `authorization` is the full header value. */
export type LookupHttpGet = (
  url: string,
  authorization: string,
) => Promise<TwilioLookupHttpResponse>;

export interface CreateTwilioLookupClientOptions {
  accountSid?: string;
  authToken?: string;
  /** Override the Lookup base URL (tests). */
  baseUrl?: string;
  /** Override the HTTP transport (tests). */
  httpGet?: LookupHttpGet;
}

export interface TwilioLookupClient {
  lookupLineType(e164: string): Promise<LookupLineTypeResult>;
}

const DEFAULT_LOOKUP_BASE_URL = "https://lookups.twilio.com/v2/PhoneNumbers";

/**
 * Map Twilio's `line_type_intelligence.type` to our normalised enum.
 * Twilio types: mobile, landline, fixedVoip, nonFixedVoip, personal,
 * tollFree, premium, sharedCost, uan, voicemail, pager, unknown, null.
 * Only `mobile` and `landline` map cleanly; both VoIP flavours → "voip";
 * everything else (incl. null / tollFree / unknown) → "unknown" so it is
 * NOT treated as a known non-mobile (and so isn't suppressed under the
 * allow-unknown SMS policy).
 */
export function mapTwilioLineType(
  raw: string | null | undefined,
): PhoneLineType {
  switch (raw) {
    case "mobile":
      return "mobile";
    case "landline":
      return "landline";
    case "fixedVoip":
    case "nonFixedVoip":
      return "voip";
    default:
      return "unknown";
  }
}

async function defaultHttpGet(
  url: string,
  authorization: string,
): Promise<TwilioLookupHttpResponse> {
  const res = await fetch(url, {
    method: "GET",
    headers: { authorization, accept: "application/json" },
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export function createTwilioLookupClient(
  opts: CreateTwilioLookupClientOptions = {},
): TwilioLookupClient {
  const accountSid = opts.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken = opts.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid) {
    throw new TwilioConfigError(
      "TWILIO_ACCOUNT_SID is not set — refusing to construct Twilio Lookup client.",
    );
  }
  if (!authToken) {
    throw new TwilioConfigError(
      "TWILIO_AUTH_TOKEN is not set — refusing to construct Twilio Lookup client.",
    );
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_LOOKUP_BASE_URL;
  const httpGet = opts.httpGet ?? defaultHttpGet;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;

  return {
    async lookupLineType(e164) {
      const url = `${baseUrl}/${encodeURIComponent(e164)}?Fields=line_type_intelligence`;
      let resp: TwilioLookupHttpResponse;
      try {
        resp = await httpGet(url, authorization);
      } catch {
        // Network / transport failure — unknown, don't throw.
        return { lineType: "unknown", rawType: null };
      }
      if (resp.status < 200 || resp.status >= 300 || !resp.json) {
        return { lineType: "unknown", rawType: null };
      }
      const body = resp.json as {
        line_type_intelligence?: { type?: string | null } | null;
      };
      const rawType = body.line_type_intelligence?.type ?? null;
      return { lineType: mapTwilioLineType(rawType), rawType };
    },
  };
}
