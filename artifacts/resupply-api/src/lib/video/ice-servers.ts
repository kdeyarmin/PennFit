// ICE server configuration handed to both video-call peers.
//
// Resolution order (first match wins):
//   1. Static operator TURN — RESUPPLY_TURN_URLS (+ _USERNAME /
//      _CREDENTIAL). Explicit config always wins so an operator can
//      pin a specific relay.
//   2. Twilio Network Traversal Service — when TWILIO_ACCOUNT_SID /
//      TWILIO_AUTH_TOKEN are set (they already are wherever SMS/voice
//      run), we mint EPHEMERAL TURN credentials per call window and
//      cache them briefly. Ephemeral creds matter because the ICE list
//      is sent to both browsers — including the patient's, reachable by
//      anyone holding the signed join link — so a static credential
//      shipped that way is semi-public. NTS caps a leak at the token
//      TTL.
//   3. Public STUN only — the pre-TURN behavior. Connects typical
//      home-NAT peers; symmetric-NAT (cellular CGNAT) and strict
//      corporate networks need 1 or 2.
//
// Every failure degrades DOWN this list, never to an error — a Twilio
// hiccup must reduce connectivity odds, not block the call attempt.
//
// PHI note: a TURN relay forwards encrypted SRTP packets it cannot
// decrypt (DTLS keys never leave the browsers), so a relay does not
// change the "media never touches our server in the clear" posture.

import {
  createTwilioNtsClient,
  TwilioConfigError,
  type TwilioNtsClient,
} from "@workspace/resupply-telecom";

import { logger } from "../logger";

export interface IceServerEntry {
  urls: string[];
  username?: string;
  credential?: string;
}

const DEFAULT_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

// Mint NTS tokens valid for 24h (Twilio's default) but reuse a cached
// one for at most an hour, so every join hands out credentials with
// ≥23h of remaining validity — comfortably longer than any visit,
// including mid-call ICE restarts.
const NTS_TOKEN_TTL_SECONDS = 86_400;
const NTS_CACHE_MS = 60 * 60 * 1000;

interface NtsCache {
  servers: IceServerEntry[];
  expiresAt: number;
}

let ntsCache: NtsCache | null = null;

/** Test-only: clear the cached NTS token. */
export function resetIceServerCacheForTest(): void {
  ntsCache = null;
}

function staticTurnServers(): IceServerEntry | null {
  const turnUrls = (process.env.RESUPPLY_TURN_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (turnUrls.length === 0) return null;
  const entry: IceServerEntry = { urls: turnUrls };
  const username = process.env.RESUPPLY_TURN_USERNAME;
  const credential = process.env.RESUPPLY_TURN_CREDENTIAL;
  if (username) entry.username = username;
  if (credential) entry.credential = credential;
  return entry;
}

/** Synchronous baseline: static TURN (if configured) + public STUN. */
export function getIceServers(): IceServerEntry[] {
  const servers: IceServerEntry[] = [{ urls: DEFAULT_STUN_URLS }];
  const turn = staticTurnServers();
  if (turn) servers.push(turn);
  return servers;
}

function tryCreateNtsClient(): TwilioNtsClient | null {
  try {
    return createTwilioNtsClient();
  } catch (err) {
    // Missing Twilio env is the expected "not configured" signal;
    // anything else (an SDK constructor failure) still degrades to the
    // baseline — resolveIceServers() must never throw — but is worth a
    // warning since it means Twilio IS configured and unusable.
    if (!(err instanceof TwilioConfigError)) {
      logger.warn(
        {
          event: "video.ice.nts_client_init_failed",
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "Twilio NTS client construction failed — falling back to STUN-only ICE",
      );
    }
    return null;
  }
}

/**
 * Full resolution (see file header for the order). Never throws —
 * worst case is the STUN-only baseline.
 */
export async function resolveIceServers(opts?: {
  /** Test-only seam; production callers leave this undefined. */
  ntsClientFactory?: () => TwilioNtsClient | null;
  now?: () => number;
}): Promise<IceServerEntry[]> {
  const baseline = getIceServers();
  // Explicit operator TURN config wins outright.
  if (staticTurnServers()) return baseline;

  const now = opts?.now ?? Date.now;
  if (ntsCache && ntsCache.expiresAt > now()) {
    return [...baseline, ...ntsCache.servers];
  }

  const nts = (opts?.ntsClientFactory ?? tryCreateNtsClient)();
  if (!nts) return baseline; // Twilio not configured — STUN only.

  try {
    const token = await nts.createIceToken(NTS_TOKEN_TTL_SECONDS);
    const servers: IceServerEntry[] = token.iceServers;
    ntsCache = {
      servers,
      // Never cache past the token's own validity, even if Twilio
      // returns a shorter TTL than requested.
      expiresAt: now() + Math.min(NTS_CACHE_MS, token.ttlSeconds * 0.8 * 1000),
    };
    return [...baseline, ...servers];
  } catch (err) {
    // Pass the Error object itself so the logger's redaction policy
    // applies to message/stack rather than leaking a raw string.
    logger.warn(
      {
        event: "video.ice.nts_token_failed",
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "Twilio NTS token mint failed — falling back to STUN-only ICE",
    );
    return baseline;
  }
}
