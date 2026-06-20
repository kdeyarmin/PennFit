// Insurance discovery transport — posts patient demographics to Office
// Ally's EDI REST insurance-discovery service and returns the list of
// coverages it matched, in the SAME call.
//
// Why a separate transport from realtime.ts
// -----------------------------------------
// Real-time eligibility (realtime.ts) answers "is THIS coverage active?":
// you wrap a 270 (payer + member id already known) and parse the single
// 271 that comes back. Insurance discovery answers "does this PERSON have
// ANY active coverage, and with whom?": you send only demographics and the
// service searches its payer network, returning a LIST of discovered
// coverages — each with its own payer name + member id. Different inputs,
// different (multi-row) output, so it gets its own request/response shape.
//
// Office Ally EDI REST API (edi.officeally.io)
// --------------------------------------------
// Modeled on the same v2 JSON envelope the eligibility endpoint uses (a
// JSON POST, apiKey in the Authorization header, results under `data`):
//
//   POST <url>                          (the insurance-discovery endpoint,
//                                        configured per account)
//     Authorization: <api key>          (apiKey scheme; sent verbatim)
//     Content-Type:  application/json
//     Accept:        application/json
//   → 200 with { "data": { "responseStatus": {…}, "coverages": [ … ] } }
//     where each coverage carries payerName / payerId / memberId /
//     planName / active / startDate / endDate.
//
// CONFIRM(oa-spec) for the issued account: the exact endpoint URL, request
// field names, and the response coverage-array key/field names. The parser
// below is deliberately tolerant of the common field aliases so a minor
// spec difference surfaces coverages rather than dropping them, but verify
// against the account's swagger before go-live.
//
// Security / PHI
// --------------
//   * The demographics in the request (and any SSN) are PHI; this module
//     never logs the request or the response body.
//   * The API key rides in the Authorization header and is never logged.

import { randomUUID } from "node:crypto";

import type { OfficeAllyDiscoveryConfig } from "../config";
import type {
  DiscoveredCoverage,
  InsuranceDiscoveryOutcome,
  InsuranceDiscoveryRequest,
  InsuranceDiscoveryTransport,
} from "./types";
import type { FetchLike } from "./realtime";

export interface DiscoveryTransportDeps {
  /** Inject a fake in tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Override the client request id (surfaced as the result sessionId for
   *  log correlation). Default: randomUUID. */
  requestId?: () => string;
}

/**
 * Build an insurance-discovery transport.
 *
 * When `config` is null the transport is a no-op that reports
 * `unavailable` — so a missing discovery config never throws and the
 * caller surfaces a clean "not configured" reason.
 */
export function createInsuranceDiscoveryTransport(
  config: OfficeAllyDiscoveryConfig | null,
  deps: DiscoveryTransportDeps = {},
): InsuranceDiscoveryTransport {
  if (!config) {
    return {
      kind: "noop",
      async discover(): Promise<InsuranceDiscoveryOutcome> {
        return {
          ok: false,
          kind: "unavailable",
          message: "insurance discovery not configured",
        };
      },
    };
  }

  const fetchImpl: FetchLike =
    deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const genRequestId = deps.requestId ?? randomUUID;

  return {
    kind: "https",
    async discover(
      req: InsuranceDiscoveryRequest,
    ): Promise<InsuranceDiscoveryOutcome> {
      const requestId = genRequestId();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let resp: Awaited<ReturnType<FetchLike>>;
      try {
        resp = await fetchImpl(config.url, {
          method: "POST",
          headers: {
            // Same apiKey scheme as real-time eligibility: the key value goes
            // in the Authorization header verbatim.
            Authorization: config.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(buildDiscoveryRequestBody(req)),
          signal: controller.signal,
        });
      } catch (err) {
        // AbortError (timeout) and any network throw are transient
        // connectivity failures.
        return {
          ok: false,
          kind: "connect_failed",
          message: isAbortError(err)
            ? `insurance discovery request timed out after ${config.timeoutMs}ms`
            : "insurance discovery request failed to connect",
        };
      } finally {
        clearTimeout(timer);
      }

      if (resp.status === 401 || resp.status === 403) {
        return {
          ok: false,
          kind: "auth_failed",
          message: `insurance discovery auth rejected (HTTP ${resp.status})`,
        };
      }
      if (!resp.ok) {
        // Surface a short, PHI-free reason. The error body is a server
        // message (it does not echo the demographics request).
        const detail = (await safeText(resp))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        return {
          ok: false,
          kind: "rejected",
          message: `insurance discovery endpoint returned HTTP ${resp.status}${
            detail ? `: ${detail}` : ""
          }`,
        };
      }

      const rawBody = await resp.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return {
          ok: false,
          kind: "rejected",
          message: "insurance discovery response was not valid JSON",
        };
      }

      const rows = extractCoverageRows(parsed);
      if (rows === null) {
        // No coverage array in the envelope — surface OA's PHI-free status
        // text (responseStatus.description), e.g. "Subject not found".
        const detail = extractStatusDetail(parsed);
        return {
          ok: false,
          kind: "rejected",
          message: `insurance discovery response carried no coverage list${
            detail ? `: ${detail}` : ""
          }`,
        };
      }
      const coverages = rows
        .map(normalizeCoverage)
        .filter((c): c is DiscoveredCoverage => c !== null);
      return { ok: true, coverages, sessionId: requestId };
    },
  };
}

/** Map our typed request to the discovery API's JSON body. Omits absent
 *  optional fields so we never send empty strings. Exported for tests. */
export function buildDiscoveryRequestBody(
  req: InsuranceDiscoveryRequest,
): Record<string, string> {
  const body: Record<string, string> = {
    firstName: req.firstName,
    lastName: req.lastName,
    dateOfBirth: req.dateOfBirth,
    gender: req.gender ?? "U",
    asOfDate: req.serviceDate ?? isoToday(),
  };
  if (req.ssn && req.ssn.trim()) body.ssn = req.ssn.replace(/\D/g, "");
  if (req.memberId && req.memberId.trim()) body.memberId = req.memberId.trim();
  if (req.postalCode && req.postalCode.trim()) {
    body.postalCode = req.postalCode.trim();
  }
  return body;
}

/** Pull the coverage array out of the v2 JSON envelope (data.coverages,
 *  tolerating data.results / data.matches aliases). Returns an array (which
 *  may be empty — searched, nothing found) or null when the envelope has no
 *  coverage list at all (an error/status-only response). Exported for tests. */
export function extractCoverageRows(parsed: unknown): unknown[] | null {
  const data = (parsed as { data?: unknown } | null | undefined)?.data;
  const container = (data ?? parsed) as Record<string, unknown> | null;
  if (!container || typeof container !== "object") return null;
  for (const key of ["coverages", "results", "matches"]) {
    const value = container[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/** Normalize one raw coverage row into a DiscoveredCoverage. Returns null
 *  for a row with no usable payer identity (no payer name AND no id) so
 *  junk rows don't surface as blank coverages. Exported for tests. */
export function normalizeCoverage(row: unknown): DiscoveredCoverage | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const payerName = firstString(r, ["payerName", "payer", "payerLegalName"]);
  const payerId = firstString(r, ["payerId", "cpid", "payerID"]);
  if (!payerName && !payerId) return null;
  return {
    payerName: payerName ?? "Unknown payer",
    payerId: payerId ?? null,
    memberId: firstString(r, ["memberId", "subscriberId", "memberID"]),
    planName: firstString(r, ["planName", "plan", "productName"]),
    isActive: coerceActive(r),
    coverageStart: firstString(r, [
      "startDate",
      "coverageStart",
      "effectiveDate",
    ]),
    coverageEnd: firstString(r, ["endDate", "coverageEnd", "terminationDate"]),
  };
}

function coerceActive(r: Record<string, unknown>): boolean {
  for (const key of ["active", "isActive"]) {
    const v = r[key];
    if (typeof v === "boolean") return v;
  }
  // status: "active" | "inactive" | "1" | "6" (X12 EB01)
  const status = firstString(r, [
    "status",
    "coverageStatus",
    "eligibilityStatus",
  ]);
  if (status) {
    const s = status.toLowerCase();
    if (s === "active" || s === "1" || s === "a") return true;
    if (s === "inactive" || s === "6" || s === "terminated") return false;
  }
  return false;
}

function firstString(
  r: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const v = r[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Best-effort, PHI-free reason string from the v2 envelope's status —
 *  data.responseStatus.description. Exported for tests. */
export function extractStatusDetail(parsed: unknown): string {
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

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
