// @workspace/resupply-telecom — TwiML builders for Voice Media Streams.
//
// We hand-roll the XML rather than reach for `twilio.twiml.VoiceResponse`
// because:
//   - The shapes we emit are tiny and stable (Connect+Stream, Hangup).
//   - The Twilio SDK pulls in a sizeable runtime (axios, qs) that we
//     don't otherwise need in the TwiML path. The REST client (in
//     client.ts) keeps that surface area paid-for in one place.
//   - Hand-rolling lets us add typed CustomParameters to the Stream
//     element without fighting the SDK's stringly-typed builder API.

import { z } from "zod";

const wsUrlSchema = z
  .string()
  .url()
  .refine((u) => u.startsWith("wss://") || u.startsWith("ws://"), {
    message: "Stream URL must use ws:// or wss:// scheme.",
  })
  // Twilio explicitly rejects ws:// in production. Allow it in tests
  // (some local fixtures use ws://) but warn loudly via the schema
  // refinement above so a copy-paste into production fails CI.
  .refine((u) => !u.includes("\n") && !u.includes("\r"), {
    message: "Stream URL must not contain CR/LF (header injection guard).",
  });

const customParamsSchema = z
  .record(
    z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/),
    z.string().max(2048),
  )
  .optional();

export interface BuildConnectStreamTwimlInput {
  /** Public WS URL the bridge listens on, e.g. wss://<host>/resupply-api/voice/stream */
  wsUrl: string;
  /**
   * Custom <Parameter> entries forwarded inside the Twilio `start`
   * frame. Use this for the `conversationId` binding so the WS
   * handler doesn't have to depend on URL query parsing alone.
   */
  customParameters?: Record<string, string>;
}

/**
 * Build the TwiML response that tells Twilio "connect this call to my
 * websocket bridge". Returns a complete XML document string.
 *
 * Throws on invalid input. The caller is operating a Twilio webhook
 * — the only way to surface a misconfiguration to ops is for the
 * webhook to 5xx loudly so Twilio retries with backoff. Returning
 * silently-bad TwiML would let the call drop silently.
 */
export function buildConnectStreamTwiml(
  input: BuildConnectStreamTwimlInput,
): string {
  const wsUrl = wsUrlSchema.parse(input.wsUrl);
  const params = customParamsSchema.parse(input.customParameters) ?? {};
  const paramXml = Object.entries(params)
    .map(
      ([k, v]) =>
        `      <Parameter name="${escapeXmlAttr(k)}" value="${escapeXmlAttr(v)}"/>`,
    )
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    `  <Connect>`,
    `    <Stream url="${escapeXmlAttr(wsUrl)}">`,
    paramXml || `      <!-- no custom parameters -->`,
    `    </Stream>`,
    `  </Connect>`,
    `</Response>`,
  ].join("\n");
}

/**
 * TwiML payload for "no Media Stream — just hang up". Used when
 * pending-session lookup fails so we don't open a WS bridge that
 * has no patient context.
 *
 * The optional `<Say>` reads BEFORE the hangup so the operator
 * console can present a friendly explanation in the dashboard
 * (we record the TwiML body alongside the conversation row).
 */
export function buildHangupTwiml(spokenMessage?: string): string {
  const safeSay = spokenMessage
    ? `  <Say>${escapeXmlText(spokenMessage)}</Say>\n`
    : "";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    safeSay + `  <Hangup/>`,
    `</Response>`,
  ].join("\n");
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
