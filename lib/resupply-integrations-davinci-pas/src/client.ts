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
    const body = await res.text();
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
    return {
      status: "transport_failed",
      httpStatus: null,
      responseJson: null,
      latencyMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
