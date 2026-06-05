// HTTP client for Da Vinci PAS endpoints.
//
// POST <payerPasEndpoint>/Claim/$submit with the FHIR Bundle as
// `application/fhir+json`. Payer returns either a Bundle wrapping a
// ClaimResponse OR a naked ClaimResponse. Both shapes are handled
// by parse-claim-response.ts.
//
// Auth: payers use one of three patterns:
//   * Bearer (OAuth2 client-credentials) — most common.
//   * Mutual TLS — Highmark, UPMC.
//   * Static API key — small Medicaid MCOs.
//
// For now we ship Bearer + static API key. mTLS requires Node TLS
// agent wiring; it'll land when the first payer that requires it
// onboards.

import type { FhirBundle } from "./build-bundle";

const DEFAULT_TIMEOUT_MS = 30_000;

// Hard cap on the payer response body. A ClaimResponse Bundle is a few
// KB; 4 MB is generous headroom. The cap stops a compromised/misbehaving
// payer endpoint (it only has to pass the route's SSRF host check, not be
// honest) from OOM-ing the in-process API/worker with a multi-GB body.
// Mirrors MAX_JWKS_BODY_BYTES in resupply-integrations-ehr-fhir.
const MAX_PAS_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Read a fetch Response body as UTF-8 text with a hard byte cap, so a
 * hostile/misbehaving upstream can't OOM us. Streams the body and aborts
 * once the cap is crossed. Falls back to a (still length-checked) buffered
 * read when the Response exposes no readable stream (e.g. a test mock).
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // No stream (mock/edge case). Guard via Content-Length when present,
    // then fall back to text(). Real payer calls use undici, which always
    // exposes a body stream, so the streamed path above is what protects
    // production.
    const declared = Number(res.headers?.get?.("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error("payer response exceeded size cap");
    }
    return res.text();
  }
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          throw new Error("payer response exceeded size cap");
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface SubmitPasInput {
  bundle: FhirBundle;
  endpointUrl: string;
  /** Bearer token OR static API key (we forward as `Bearer <token>`
   *  either way — payers we've talked to accept both). */
  accessToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SubmitPasOutcome {
  status: "responded" | "rejected" | "transport_failed";
  /** HTTP status code from the payer. */
  httpStatus: number | null;
  /** The raw FHIR ClaimResponse / Bundle the payer returned. Null
   *  on transport failure. */
  responseJson: unknown | null;
  /** Round-trip latency in ms. */
  latencyMs: number;
  /** Caller-safe error message when status != 'responded'. */
  errorMessage: string | null;
}

export async function submitPasBundle(
  input: SubmitPasInput,
): Promise<SubmitPasOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(
      `${input.endpointUrl.replace(/\/$/, "")}/Claim/$submit`,
      {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/fhir+json",
          Accept: "application/fhir+json",
          Authorization: `Bearer ${input.accessToken}`,
        },
        body: JSON.stringify(input.bundle),
      },
    );
    const latencyMs = Date.now() - startedAt;
    const body = await readBodyCapped(res, MAX_PAS_RESPONSE_BYTES);
    let parsed: unknown = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }
    if (res.status >= 200 && res.status < 300) {
      return {
        status: "responded",
        httpStatus: res.status,
        responseJson: parsed,
        latencyMs,
        errorMessage: null,
      };
    }
    return {
      status: "rejected",
      httpStatus: res.status,
      responseJson: parsed,
      latencyMs,
      errorMessage: `payer http ${res.status}`,
    };
  } catch (err) {
    // Map to a fixed set of caller-safe reasons rather than returning the
    // raw transport error. This value is persisted to
    // davinci_pas_submissions.error_message AND returned in the HTTP body;
    // a raw undici/fetch error string is the one spot in this client that
    // could surface internal request detail to an API response.
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || ctrl.signal.aborted);
    return {
      status: "transport_failed",
      httpStatus: null,
      responseJson: null,
      latencyMs: Date.now() - startedAt,
      errorMessage: aborted
        ? "payer request timed out"
        : "payer transport error",
    };
  } finally {
    clearTimeout(timer);
  }
}
