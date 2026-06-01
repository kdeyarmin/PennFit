// @workspace/resupply-telecom — Twilio REST client wrapper.
//
// The official `twilio` SDK is fine; we wrap it for three reasons:
//   1. To narrow the API surface to the ONE operation we currently
//      need (placeCall) so future additions show up as PR-sized
//      changes here, not "the API now also dials WhatsApp" surprises.
//   2. To centralise env-var reading. Reading via a factory means a
//      missing secret throws at construction time, not deep inside
//      a Twilio SDK call where the error gets lost in the trace.
//   3. To give tests a mock seam: `createTwilioClient` accepts an
//      override factory so route tests can inject a fake client
//      without monkey-patching `require()` cache.

import twilioPkg from "twilio";

const Twilio = twilioPkg;

export interface PlaceCallInput {
  /** E.164 destination, e.g. "+12155551212". */
  to: string;
  /** E.164 source — the verified Twilio number, e.g. "+12158675309". */
  from: string;
  /**
   * Public URL Twilio will POST to for TwiML when the callee answers.
   * MUST be HTTPS for production (Twilio strips the `Secret` header
   * over plaintext) — we don't enforce that here so dev fixtures can
   * use `http://localhost`, but the API route adds the assertion in
   * production.
   */
  url: string;
  /**
   * Public URL Twilio will POST lifecycle status to (`completed`,
   * `failed`, `no-answer`, `busy`). Optional — the agent-first
   * click-to-dial bridge omits it (the CSR logs the disposition
   * manually); the AI place-call path always sets it.
   */
  statusCallbackUrl?: string;
  /**
   * If true, Twilio will record the call. We pass false explicitly so
   * a future SDK default flip doesn't start sending PHI audio to
   * Twilio storage without us noticing.
   */
  record?: boolean;
  /**
   * Hard cap (seconds) on the call. Defaults to 600s (10 min) — long
   * enough for normal resupply flows, short enough that a stuck
   * agent / loop-bug bills a few cents instead of an hour.
   */
  timeLimit?: number;
}

export interface PlaceCallResult {
  /** Twilio call SID, e.g. "CAxxxxxxxx..." */
  sid: string;
}

/**
 * Errors thrown by this module. Production callers can switch on
 * `name` to distinguish unrecoverable misconfig (`TwilioConfigError`)
 * from transient upstream failures (`TwilioApiError`).
 */
export class TwilioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwilioConfigError";
  }
}

export class TwilioApiError extends Error {
  readonly status?: number;
  readonly code?: number | string;
  constructor(message: string, status?: number, code?: number | string) {
    super(message);
    this.name = "TwilioApiError";
    this.status = status;
    this.code = code;
  }
}

export interface TwilioClient {
  placeCall(input: PlaceCallInput): Promise<PlaceCallResult>;
}

/**
 * Minimal contract the underlying Twilio SDK must satisfy. Tests pass
 * a fake matching this shape; production uses the real SDK.
 *
 * Typed loosely on purpose — Twilio's published types are huge and we
 * only depend on a single nested method.
 */
export interface RawTwilioSdk {
  calls: {
    create(opts: {
      to: string;
      from: string;
      url: string;
      method?: "POST" | "GET";
      statusCallback?: string;
      statusCallbackEvent?: string[];
      statusCallbackMethod?: "POST" | "GET";
      record?: boolean;
      timeLimit?: number;
    }): Promise<{ sid: string }>;
  };
}

export interface CreateTwilioClientOptions {
  accountSid?: string;
  authToken?: string;
  /** Test-only seam. Production callers should leave this undefined. */
  sdkFactory?: (accountSid: string, authToken: string) => RawTwilioSdk;
}

const DEFAULT_TIME_LIMIT_SECONDS = 600;

/**
 * Build a TwilioClient.
 *
 * Reads `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` from the env when
 * options are unset. Throws `TwilioConfigError` if either is missing —
 * better to fail at construction than to bury "401 unauthorized" in a
 * route handler.
 */
export function createTwilioClient(
  opts: CreateTwilioClientOptions = {},
): TwilioClient {
  const accountSid = opts.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken = opts.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid) {
    throw new TwilioConfigError(
      "TWILIO_ACCOUNT_SID is not set — refusing to construct Twilio client.",
    );
  }
  if (!authToken) {
    throw new TwilioConfigError(
      "TWILIO_AUTH_TOKEN is not set — refusing to construct Twilio client.",
    );
  }

  // Cast to our internal contract so we don't have to type the entire
  // Twilio SDK in our client code. Tests pass `sdkFactory` directly.
  const sdk: RawTwilioSdk = opts.sdkFactory
    ? opts.sdkFactory(accountSid, authToken)
    : (Twilio(accountSid, authToken) as unknown as RawTwilioSdk);

  return {
    async placeCall(input) {
      try {
        const res = await sdk.calls.create({
          to: input.to,
          from: input.from,
          url: input.url,
          method: "POST",
          statusCallback: input.statusCallbackUrl,
          // Subscribe to the full call lifecycle. Twilio defaults to
          // just `completed`, but we want `initiated`/`ringing`/
          // `answered` for the admin dashboard timeline.
          statusCallbackEvent: [
            "initiated",
            "ringing",
            "answered",
            "completed",
          ],
          statusCallbackMethod: "POST",
          // Recording: ALWAYS off. We persist the encrypted transcript;
          // the audio itself is PHI we don't want sitting in Twilio
          // storage.
          record: false,
          timeLimit: input.timeLimit ?? DEFAULT_TIME_LIMIT_SECONDS,
        });
        return { sid: res.sid };
      } catch (err) {
        // Twilio errors carry { status, code, message } — preserve
        // those for the route handler's audit log without bubbling the
        // raw SDK class (which can echo auth tokens in some versions).
        const e = err as {
          status?: number;
          code?: number | string;
          message?: string;
        };
        throw new TwilioApiError(
          e.message ?? "Twilio API error",
          e.status,
          e.code,
        );
      }
    },
  };
}
