// Real-time eligibility (270/271) transport — posts the 270 to Office
// Ally's HTTPS web service wrapped in a CAQH CORE Connectivity envelope
// and returns the 271 from the response in the SAME call.
//
// Why a separate transport from sftp.ts
// -------------------------------------
// SFTP is fire-and-forget batch: the 271 arrives later in the outbound
// dir and the inbound poll reconciles it (minutes of latency). The
// real-time service is synchronous request/response, so a CSR at intake
// sees coverage in seconds. Both build the SAME 270 (build270) and parse
// the SAME 271 (parse271) — only the transport differs.
//
// CORE envelope
// -------------
// CAQH CORE Phase II Connectivity Rule (vC2.2.0) defines the SOAP
// envelope used below: PayloadType / ProcessingMode=RealTime / PayloadID
// / SenderID / ReceiverID / CORERuleVersion / Payload. Office Ally is
// CAQH CORE-certified for real-time 270/271. The exact PayloadType
// string, SOAPAction, auth placement, and whether the X12 Payload is
// raw or base64 must be confirmed against Office Ally's real-time
// companion guide for the issued account — those are the spots marked
// `CONFIRM(oa-spec)` below. The envelope builder + 271 extractor are
// exported as pure functions so they can be unit-tested and adjusted
// without touching the network code.
//
// Security / PHI
// --------------
//   * The 270/271 are PHI; this module never logs the payload or the
//     envelope. The caller (eligibility-verifier) persists the parsed
//     271, not the raw bytes-in-flight.
//   * Auth is HTTP Basic from the real-time credentials (NOT the SFTP
//     key). The Authorization header is never logged.

import { randomUUID } from "node:crypto";

import type { OfficeAllyRealtimeConfig } from "../config";
import type {
  EligibilityRealtimeOutcome,
  EligibilityRealtimeTransport,
  EligibilityRequest,
} from "./types";

/** Minimal fetch shape we depend on — keeps the package free of DOM lib
 *  assumptions and makes the transport trivially testable with a fake. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RealtimeTransportDeps {
  /** Inject a fake in tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Override the PayloadID generator (default: randomUUID). */
  payloadId?: () => string;
  /** Override the timestamp source (default: new Date()). */
  now?: () => Date;
}

/**
 * Build a real-time eligibility transport.
 *
 * When `config` is null the transport is a no-op that reports
 * `unavailable` — so a missing real-time config never throws and the
 * verifier simply falls back to the SFTP path.
 */
export function createRealtimeEligibilityTransport(
  config: OfficeAllyRealtimeConfig | null,
  deps: RealtimeTransportDeps = {},
): EligibilityRealtimeTransport {
  if (!config) {
    return {
      kind: "noop",
      async requestEligibility(): Promise<EligibilityRealtimeOutcome> {
        return {
          ok: false,
          kind: "unavailable",
          message: "real-time eligibility not configured",
        };
      },
    };
  }

  const fetchImpl: FetchLike =
    deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const genPayloadId = deps.payloadId ?? randomUUID;
  const now = deps.now ?? (() => new Date());

  return {
    kind: "soap",
    async requestEligibility(
      req: EligibilityRequest,
    ): Promise<EligibilityRealtimeOutcome> {
      const payloadId = genPayloadId();
      const envelope = buildCoreRealTimeRequestEnvelope({
        payload270: req.payload,
        senderId: config.senderId,
        receiverId: config.receiverId,
        payloadId,
        timestamp: now().toISOString(),
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let resp: Awaited<ReturnType<FetchLike>>;
      try {
        resp = await fetchImpl(config.url, {
          method: "POST",
          headers: {
            // The envelope uses the SOAP 1.2 namespace, so the matching
            // content type is application/soap+xml (1.2 carries the action
            // as a content-type parameter, not a separate SOAPAction
            // header). CONFIRM(oa-spec): some Office Ally real-time
            // endpoints are SOAP 1.1 — those want `text/xml` + a separate
            // `SOAPAction` header (and the 1.1 envelope namespace). Match
            // whichever the issued account's companion guide specifies.
            "Content-Type":
              'application/soap+xml; charset=utf-8; action="RealTimeTransaction"',
            SOAPAction: "RealTimeTransaction",
            Authorization: `Basic ${basicAuth(config.username, config.password)}`,
          },
          body: envelope,
          signal: controller.signal,
        });
      } catch (err) {
        // AbortError (timeout) and any network throw are transient/
        // connectivity failures — the verifier falls back to SFTP.
        return {
          ok: false,
          kind: "connect_failed",
          message: isAbortError(err)
            ? `real-time request timed out after ${config.timeoutMs}ms`
            : "real-time request failed to connect",
        };
      } finally {
        clearTimeout(timer);
      }

      if (resp.status === 401 || resp.status === 403) {
        return {
          ok: false,
          kind: "auth_failed",
          message: `real-time auth rejected (HTTP ${resp.status})`,
        };
      }
      if (!resp.ok) {
        return {
          ok: false,
          kind: "rejected",
          message: `real-time endpoint returned HTTP ${resp.status}`,
        };
      }

      const body = await resp.text();
      const payload271 = extract271FromCoreResponse(body);
      if (!payload271) {
        // A 200 with no 271 is usually a CORE-level application error
        // (auth, payload, version). Surface the code so it's actionable.
        const coreError = extractCoreErrorFromResponse(body);
        if (coreError) {
          return {
            ok: false,
            kind: /unauthor|forbidden|denied|credential/i.test(coreError.code)
              ? "auth_failed"
              : "rejected",
            message: `real-time rejected by clearinghouse: ${coreError.code}${
              coreError.message ? ` — ${coreError.message}` : ""
            }`,
          };
        }
        return {
          ok: false,
          kind: "rejected",
          message: "real-time response contained no 271 payload",
        };
      }
      return { ok: true, payload271, sessionId: payloadId };
    },
  };
}

export interface CoreRealTimeRequestInput {
  /** Raw X12 270 payload. */
  payload270: string;
  senderId: string;
  receiverId: string;
  payloadId: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/**
 * Build the CAQH CORE vC2.2.0 real-time request SOAP envelope around a
 * 270 payload. CONFIRM(oa-spec): the PayloadType string and namespace
 * must match Office Ally's companion guide for the issued account.
 */
export function buildCoreRealTimeRequestEnvelope(
  input: CoreRealTimeRequestInput,
): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"',
    ' xmlns:cor="http://www.caqh.org/SOAP/WSDL/CORERule2.2.0.xsd">',
    "<soap:Body>",
    "<cor:COREEnvelopeRealTimeRequest>",
    "<PayloadType>X12_270_Request_005010X279A1</PayloadType>",
    "<ProcessingMode>RealTime</ProcessingMode>",
    `<PayloadID>${xmlEscape(input.payloadId)}</PayloadID>`,
    `<TimeStamp>${xmlEscape(input.timestamp)}</TimeStamp>`,
    `<SenderID>${xmlEscape(input.senderId)}</SenderID>`,
    `<ReceiverID>${xmlEscape(input.receiverId)}</ReceiverID>`,
    "<CORERuleVersion>2.2.0</CORERuleVersion>",
    `<Payload>${xmlEscape(input.payload270)}</Payload>`,
    "</cor:COREEnvelopeRealTimeRequest>",
    "</soap:Body>",
    "</soap:Envelope>",
  ].join("");
}

/**
 * Extract the X12 271 from a CORE real-time response envelope. Tolerates
 * namespace prefixes on the `<Payload>` element, `<![CDATA[…]]>` wrapping,
 * XML-escaped content, and base64-encoded payloads. Returns null when no
 * X12 (no `ISA` segment) can be recovered.
 */
export function extract271FromCoreResponse(body: string): string | null {
  // Tolerate <Payload>, <ns:Payload>, and attributes on the tag.
  const match = body.match(
    /<(?:[A-Za-z0-9]+:)?Payload\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?Payload>/,
  );
  if (!match) return null;
  const inner = match[1].trim();
  // CDATA content is literal (no entity-decoding); everything else is
  // XML-escaped text.
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  const raw = cdata ? cdata[1].trim() : xmlUnescape(inner);
  if (raw.includes("ISA")) return raw;
  // Some implementations base64-encode the X12 payload.
  const decoded = tryBase64Decode(raw);
  if (decoded && decoded.includes("ISA")) return decoded;
  return null;
}

export interface CoreResponseError {
  /** The CORE `<ErrorCode>` value (never `Success`). */
  code: string;
  /** The CORE `<ErrorMessage>`, when present. */
  message: string | null;
}

/**
 * Extract a CORE-level error from a real-time response envelope. Office
 * Ally (like most SOAP endpoints) commonly returns application errors as
 * HTTP 200 with `<ErrorCode>…</ErrorCode>` rather than an HTTP status —
 * surfacing it turns an opaque "no 271 payload" into an actionable
 * reason. Returns null when the envelope reports success (or has no
 * ErrorCode).
 */
export function extractCoreErrorFromResponse(
  body: string,
): CoreResponseError | null {
  const codeMatch = body.match(
    /<(?:[A-Za-z0-9]+:)?ErrorCode\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?ErrorCode>/,
  );
  const code = codeMatch ? xmlUnescape(codeMatch[1].trim()) : "";
  // No code, or an explicit success marker → not an error.
  if (!code || /^success$/i.test(code)) return null;
  const msgMatch = body.match(
    /<(?:[A-Za-z0-9]+:)?ErrorMessage\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?ErrorMessage>/,
  );
  const message = msgMatch ? xmlUnescape(msgMatch[1].trim()) : null;
  return { code, message: message || null };
}

function basicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tryBase64Decode(s: string): string | null {
  // Only attempt when the string is plausibly base64 (X12 is not).
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) return null;
  try {
    return Buffer.from(s.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}
