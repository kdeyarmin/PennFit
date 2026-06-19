// @workspace/resupply-telecom — Twilio number-search + purchase client.
//
// Used to PROVISION a voice / SMS phone number for a tenant (DME company)
// from the admin "Provision a number" button, the mirror of the Telnyx
// fax-number flow in telnyx-numbers.ts. Voice + SMS ride on Twilio (fax
// went to Telnyx because Twilio retired Programmable Fax), so number
// provisioning for those channels goes through Twilio's REST API:
//   * GET  AvailablePhoneNumbers/{country}/Local — search for a number
//   * POST IncomingPhoneNumbers                  — buy one and (optionally)
//                                                  point its voice/SMS
//                                                  webhooks at our app
//
// Buying a number costs money and assigns a real DID, so callers gate this
// behind an explicit operator action (the admin "Provision number" button)
// and a tight rate limit.
//
// Architecture: this package MUST NOT import @workspace/resupply-db (Rule
// 10). Persisting the purchased number onto
// `organizations.voice_from_number` / `sms_from_number` is the CALLER's
// job — this client only talks to Twilio.
//
// PHI note: a tenant's own DID is business data, not PHI. Caller / patient
// numbers are handled (and kept out of logs) by the SMS / voice send +
// receive paths, not here.

import twilioPkg from "twilio";

import { TwilioApiError, TwilioConfigError } from "./client";

const Twilio = twilioPkg;

/** A number returned by the availability search. */
export interface AvailableTwilioNumber {
  /** E.164 phone number, e.g. "+12155551212". */
  phoneNumber: string;
  /** Friendly/display form Twilio returns, when present. */
  friendlyName?: string;
  /** Capabilities Twilio reports for it. */
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
}

export interface SearchNumbersInput {
  /** ISO-3166 alpha-2 country, default "US". */
  countryCode?: string;
  /** US area code (e.g. "215") to keep the number local. Omit to let Twilio pick. */
  areaCode?: string;
  /** Require voice capability (default true). */
  voice?: boolean;
  /** Require SMS capability (default true). */
  sms?: boolean;
  /** How many candidates to return. Default 10. */
  limit?: number;
}

export interface PurchaseNumberInput {
  /** E.164 number to buy (from a prior availability search). */
  phoneNumber: string;
  /** Display label on the Twilio number (we pass the org slug/id). */
  friendlyName?: string;
  /**
   * Public webhook URL Twilio POSTs to for inbound VOICE on this number.
   * Point it at the platform's existing inbound-voice endpoint so the
   * tenant's calls reach the app (which routes by called number). Omit to
   * leave the number's voice config at the Twilio account default.
   */
  voiceUrl?: string;
  /**
   * Public webhook URL Twilio POSTs to for inbound SMS on this number.
   * Same rationale as voiceUrl. Omit to leave the SMS config at default.
   */
  smsUrl?: string;
}

export interface PurchaseNumberResult {
  /** Twilio IncomingPhoneNumber SID ("PNxxxx..."). Persist for audit. */
  sid: string;
  /** The purchased number in E.164. */
  phoneNumber: string;
}

export interface ProvisionNumberInput extends SearchNumbersInput {
  friendlyName?: string;
  voiceUrl?: string;
  smsUrl?: string;
}

export type ProvisionNumberResult = PurchaseNumberResult;

export interface TwilioNumberClient {
  /** Search Twilio for available numbers matching the filters. */
  searchAvailableNumbers(
    input?: SearchNumbersInput,
  ): Promise<AvailableTwilioNumber[]>;
  /** Buy a specific number (and optionally wire its inbound webhooks). */
  purchaseNumber(input: PurchaseNumberInput): Promise<PurchaseNumberResult>;
  /**
   * Convenience: search then buy the first match, in one call. Throws
   * TwilioApiError when nothing matches the filters.
   */
  provisionNumber(input?: ProvisionNumberInput): Promise<ProvisionNumberResult>;
}

/**
 * The slice of the Twilio SDK this client depends on. Tests pass a fake
 * matching this shape; production uses the real SDK. Typed loosely on
 * purpose — Twilio's published types are huge and we touch a tiny corner.
 */
export interface RawTwilioNumbersSdk {
  availablePhoneNumbers(countryCode: string): {
    local: {
      list(opts: {
        areaCode?: number;
        voiceEnabled?: boolean;
        smsEnabled?: boolean;
        limit?: number;
      }): Promise<
        Array<{
          phoneNumber: string;
          friendlyName?: string;
          capabilities?: Record<string, boolean | undefined>;
        }>
      >;
    };
  };
  incomingPhoneNumbers: {
    create(opts: {
      phoneNumber: string;
      friendlyName?: string;
      voiceUrl?: string;
      voiceMethod?: "POST" | "GET";
      smsUrl?: string;
      smsMethod?: "POST" | "GET";
    }): Promise<{ sid: string; phoneNumber: string }>;
  };
}

export interface CreateTwilioNumberClientOptions {
  accountSid?: string;
  authToken?: string;
  /** Test-only seam. Production callers leave this undefined. */
  sdkFactory?: (accountSid: string, authToken: string) => RawTwilioNumbersSdk;
}

/**
 * Build a TwilioNumberClient. Reads `TWILIO_ACCOUNT_SID` /
 * `TWILIO_AUTH_TOKEN` from the env when options are unset, and throws
 * `TwilioConfigError` at construction when they're missing — better to
 * fail before a half-finished purchase than inside the search/buy flow.
 */
export function createTwilioNumberClient(
  opts: CreateTwilioNumberClientOptions = {},
): TwilioNumberClient {
  const accountSid = opts.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken = opts.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid) {
    throw new TwilioConfigError(
      "TWILIO_ACCOUNT_SID is not set — refusing to construct Twilio number client.",
    );
  }
  if (!authToken) {
    throw new TwilioConfigError(
      "TWILIO_AUTH_TOKEN is not set — refusing to construct Twilio number client.",
    );
  }

  const sdk: RawTwilioNumbersSdk = opts.sdkFactory
    ? opts.sdkFactory(accountSid, authToken)
    : (Twilio(accountSid, authToken) as unknown as RawTwilioNumbersSdk);

  async function searchAvailableNumbers(
    input: SearchNumbersInput = {},
  ): Promise<AvailableTwilioNumber[]> {
    const wantVoice = input.voice ?? true;
    const wantSms = input.sms ?? true;
    const areaCodeStr = input.areaCode?.trim();
    const areaCode = areaCodeStr ? Number(areaCodeStr) : undefined;
    try {
      const rows = await sdk
        .availablePhoneNumbers(input.countryCode?.trim() || "US")
        .local.list({
          ...(areaCode !== undefined && Number.isFinite(areaCode)
            ? { areaCode }
            : {}),
          // Twilio's voiceEnabled/smsEnabled filter for numbers that LACK
          // the capability when set to false — so only send the flag when we
          // actually REQUIRE that capability; omit it otherwise.
          ...(wantVoice ? { voiceEnabled: true } : {}),
          ...(wantSms ? { smsEnabled: true } : {}),
          limit: input.limit ?? 10,
        });
      return rows.map((r) => ({
        phoneNumber: r.phoneNumber,
        friendlyName: r.friendlyName,
        // Twilio reports capability keys inconsistently across API
        // versions ("sms" vs "SMS"); read both spellings defensively.
        capabilities: {
          voice: readCap(r.capabilities, "voice"),
          sms: readCap(r.capabilities, "sms", "SMS"),
          mms: readCap(r.capabilities, "mms", "MMS"),
        },
      }));
    } catch (err) {
      throw toApiError(err, "Twilio number search error");
    }
  }

  async function purchaseNumber(
    input: PurchaseNumberInput,
  ): Promise<PurchaseNumberResult> {
    try {
      const created = await sdk.incomingPhoneNumbers.create({
        phoneNumber: input.phoneNumber,
        ...(input.friendlyName ? { friendlyName: input.friendlyName } : {}),
        ...(input.voiceUrl
          ? { voiceUrl: input.voiceUrl, voiceMethod: "POST" as const }
          : {}),
        ...(input.smsUrl
          ? { smsUrl: input.smsUrl, smsMethod: "POST" as const }
          : {}),
      });
      return { sid: created.sid, phoneNumber: created.phoneNumber };
    } catch (err) {
      throw toApiError(err, "Twilio number purchase error");
    }
  }

  async function provisionNumber(
    input: ProvisionNumberInput = {},
  ): Promise<ProvisionNumberResult> {
    const wantVoice = input.voice ?? true;
    const wantSms = input.sms ?? true;
    const candidates = await searchAvailableNumbers({
      countryCode: input.countryCode,
      areaCode: input.areaCode,
      voice: wantVoice,
      sms: wantSms,
      limit: 10,
    });
    const pick = candidates.find(
      (c) =>
        (!wantVoice || c.capabilities.voice) &&
        (!wantSms || c.capabilities.sms),
    );
    if (!pick) {
      throw new TwilioApiError(
        input.areaCode
          ? `No matching Twilio numbers available in area code ${input.areaCode}.`
          : "No matching Twilio numbers available for the requested search.",
        404,
      );
    }
    return purchaseNumber({
      phoneNumber: pick.phoneNumber,
      friendlyName: input.friendlyName,
      voiceUrl: input.voiceUrl,
      smsUrl: input.smsUrl,
    });
  }

  return { searchAvailableNumbers, purchaseNumber, provisionNumber };
}

function readCap(
  caps: Record<string, boolean | undefined> | undefined,
  ...keys: string[]
): boolean {
  if (!caps) return false;
  for (const k of keys) {
    if (caps[k]) return true;
  }
  return false;
}

/** Normalize an unknown throw into a TwilioApiError (preserving status/code). */
function toApiError(err: unknown, fallback: string): Error {
  if (err instanceof TwilioApiError || err instanceof TwilioConfigError) {
    return err;
  }
  const e = err as {
    status?: number;
    code?: number | string;
    message?: string;
  };
  return new TwilioApiError(e.message ?? fallback, e.status, e.code);
}
