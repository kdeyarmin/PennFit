// Real-time eligibility (270/271) transport — posts the X12 270 to Office
// Ally's EDI REST API and returns the X12 271 from the response in the
// SAME call.
//
// Why a separate transport from sftp.ts
// -------------------------------------
// SFTP is fire-and-forget batch: the 271 arrives later in the outbound
// dir and the inbound poll reconciles it (minutes of latency). The
// real-time service is synchronous request/response, so a CSR at intake
// sees coverage in seconds. Both build the SAME 270 (build270) and parse
// the SAME 271 (parse271) — only the transport differs.
//
// Office Ally EDI REST API v2 (edi.officeally.io)
// -----------------------------------------------
// Verified against Office Ally's EDI API v2 spec (https://edi.officeally.io/
// swagger, ?urls.primaryName=v2, the eligibility-benefits group). The
// real-time eligibility call is a JSON POST that wraps the raw X12 270 and
// returns the X12 271 wrapped in a JSON envelope — no SOAP, no CORE
// envelope, no WS-Security:
//
//   POST <url>                          (the /v2/eligibility-benefits/x12
//                                        endpoint, configured per account)
//     Authorization: <api key>          (apiKey scheme; header is named
//                                        "Authorization")
//     Content-Type:  application/json   (RealTimeX12Request: {"x12": "<270>"})
//     Accept:        application/json
//   → 200 with ApiResponseOfEligibilityResponse:
//       { "data": { "x12": "<raw X12 271>", "responseStatus": {…}, … } }
//     The raw 271 lives at data.x12.
//
// CONFIRM(oa-spec) for the issued account: the exact endpoint URL and
// whether the Authorization value needs a scheme prefix — we send the
// configured api-key value verbatim, so set it EXACTLY as Office Ally
// issued it (include a "Bearer " prefix in the key itself if they require
// one).
//
// Security / PHI
// --------------
//   * The 270/271 are PHI; this module never logs the request or response
//     body. The caller (eligibility-verifier) persists the parsed 271, not
//     the raw bytes-in-flight.
//   * The API key rides in the Authorization header and is never logged.

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
  /** Override the client request id (surfaced as the result sessionId for
   *  log correlation). Default: randomUUID. */
  requestId?: () => string;
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
  const genRequestId = deps.requestId ?? randomUUID;

  return {
    kind: "https",
    async requestEligibility(
      req: EligibilityRequest,
    ): Promise<EligibilityRealtimeOutcome> {
      const requestId = genRequestId();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let resp: Awaited<ReturnType<FetchLike>>;
      try {
        resp = await fetchImpl(config.url, {
          method: "POST",
          headers: {
            // Office Ally's apiKey scheme: the key value goes in the
            // Authorization header verbatim (set it exactly as issued —
            // include a "Bearer " prefix in the key if they require one).
            Authorization: config.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          // RealTimeX12Request: the raw X12 270 wrapped as JSON {"x12": …}.
          body: JSON.stringify({ x12: req.payload }),
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
        // Surface a short, PHI-free reason. The error body is a server
        // message (it does not echo the 270 request).
        const detail = (await safeText(resp))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        return {
          ok: false,
          kind: "rejected",
          message: `real-time endpoint returned HTTP ${resp.status}${
            detail ? `: ${detail}` : ""
          }`,
        };
      }

      // The 200 body is JSON (ApiResponseOfEligibilityResponse); the raw
      // X12 271 lives at data.x12.
      const rawBody = await resp.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return {
          ok: false,
          kind: "rejected",
          message: "real-time response was not valid JSON",
        };
      }

      const payload271 = extract271(parsed);
      if (!payload271 || !isX12Response271(payload271)) {
        // No 271 in the envelope — surface OA's PHI-free status text
        // (responseStatus.description), e.g. "Payer not available".
        const detail = extractStatusDetail(parsed);
        return {
          ok: false,
          kind: "rejected",
          message: `real-time response carried no X12 271${
            detail ? `: ${detail}` : ""
          }`,
        };
      }
      return { ok: true, payload271: payload271.trim(), sessionId: requestId };
    },
  };
}

/** Pull the raw X12 271 out of Office Ally's v2 JSON envelope
 *  (ApiResponseOfEligibilityResponse → data.x12). Returns null when the
 *  field is absent or not a non-empty string. Exported for tests. */
export function extract271(parsed: unknown): string | null {
  const data = (parsed as { data?: unknown } | null | undefined)?.data;
  const x12 = (data as { x12?: unknown } | null | undefined)?.x12;
  return typeof x12 === "string" && x12.length > 0 ? x12 : null;
}

/** Heuristic that a response body is an X12 271 (carries an interchange
 *  header and the 271 transaction-set header). Exported for tests. */
export function isX12Response271(body: string): boolean {
  return body.includes("ISA") && body.includes("ST*271");
}

/** Best-effort, PHI-free reason string from the v2 envelope's status —
 *  data.responseStatus.description (a status code description like
 *  "Success" / "Payer not available", never patient data). */
function extractStatusDetail(parsed: unknown): string {
  const data = (parsed as { data?: unknown } | null | undefined)?.data;
  const status = (data as { responseStatus?: unknown } | null | undefined)
    ?.responseStatus;
  const desc = (status as { description?: unknown } | null | undefined)
    ?.description;
  return typeof desc === "string"
    ? desc.replace(/\s+/g, " ").trim().slice(0, 200)
    : "";
}

async function safeText(resp: { text(): Promise<string> }): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
