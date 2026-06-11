// Twilio Network Traversal Service (NTS) — ephemeral TURN/STUN
// credentials for the telehealth video path.
//
// Why NTS instead of static TURN credentials: the ICE server list is
// handed to BOTH browsers in a video visit (including the patient's,
// reachable by anyone holding the signed join link), so any static
// credential shipped that way is effectively semi-public. NTS mints a
// short-lived username/credential pair per request, which caps the
// blast radius of a leaked config to the token's TTL.
//
// Same wrapper rationale as client.ts: narrow surface (one operation),
// env reading centralised in the factory, and an `sdkFactory` seam so
// tests inject a fake instead of monkey-patching the SDK.

import twilioPkg from "twilio";

import { TwilioApiError, TwilioConfigError } from "./client";

const Twilio = twilioPkg;

export interface NtsIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface CreateIceTokenResult {
  iceServers: NtsIceServer[];
  /** Seconds the credentials remain valid (Twilio default 86400). */
  ttlSeconds: number;
}

export interface TwilioNtsClient {
  createIceToken(ttlSeconds?: number): Promise<CreateIceTokenResult>;
}

/**
 * Minimal contract the underlying Twilio SDK must satisfy. The SDK's
 * token resource returns `iceServers` entries that may carry the
 * legacy singular `url`, the modern `urls` (string or array), or both.
 */
export interface RawTwilioNtsSdk {
  tokens: {
    create(opts: { ttl?: number }): Promise<{
      iceServers?: Array<{
        url?: string;
        urls?: string | string[];
        username?: string;
        credential?: string;
      }>;
      ttl?: string | number;
    }>;
  };
}

export interface CreateTwilioNtsClientOptions {
  accountSid?: string;
  authToken?: string;
  /** Test-only seam. Production callers should leave this undefined. */
  sdkFactory?: (accountSid: string, authToken: string) => RawTwilioNtsSdk;
}

const DEFAULT_TTL_SECONDS = 86_400; // Twilio's own default (24h)

function normalizeUrls(entry: {
  url?: string;
  urls?: string | string[];
}): string[] {
  const urls = new Set<string>();
  if (entry.url) urls.add(entry.url);
  if (typeof entry.urls === "string") urls.add(entry.urls);
  if (Array.isArray(entry.urls)) {
    for (const u of entry.urls) if (u) urls.add(u);
  }
  return [...urls];
}

/**
 * Build a TwilioNtsClient. Reads `TWILIO_ACCOUNT_SID` /
 * `TWILIO_AUTH_TOKEN` from the env when options are unset; throws
 * `TwilioConfigError` if either is missing so callers can treat
 * "Twilio not configured" as a clean degrade path.
 */
export function createTwilioNtsClient(
  opts: CreateTwilioNtsClientOptions = {},
): TwilioNtsClient {
  const accountSid = opts.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken = opts.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid) {
    throw new TwilioConfigError(
      "TWILIO_ACCOUNT_SID is not set — refusing to construct Twilio NTS client.",
    );
  }
  if (!authToken) {
    throw new TwilioConfigError(
      "TWILIO_AUTH_TOKEN is not set — refusing to construct Twilio NTS client.",
    );
  }

  const sdk: RawTwilioNtsSdk = opts.sdkFactory
    ? opts.sdkFactory(accountSid, authToken)
    : (Twilio(accountSid, authToken) as unknown as RawTwilioNtsSdk);

  return {
    async createIceToken(ttlSeconds = DEFAULT_TTL_SECONDS) {
      try {
        const token = await sdk.tokens.create({ ttl: ttlSeconds });
        const iceServers: NtsIceServer[] = (token.iceServers ?? [])
          .map((entry) => {
            const urls = normalizeUrls(entry);
            const server: NtsIceServer = { urls };
            if (entry.username) server.username = entry.username;
            if (entry.credential) server.credential = entry.credential;
            return server;
          })
          .filter((s) => s.urls.length > 0);
        const parsedTtl = Number(token.ttl);
        return {
          iceServers,
          ttlSeconds:
            Number.isFinite(parsedTtl) && parsedTtl > 0
              ? parsedTtl
              : ttlSeconds,
        };
      } catch (err) {
        const e = err as {
          status?: number;
          code?: number | string;
          message?: string;
        };
        throw new TwilioApiError(
          e.message ?? "Twilio NTS token error",
          e.status,
          e.code,
        );
      }
    },
  };
}
