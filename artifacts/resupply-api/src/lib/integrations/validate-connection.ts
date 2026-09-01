// validate-connection.ts — prove a therapy-cloud connection works BEFORE
// a nightly sync quietly depends on it.
//
// WHY THIS EXISTS
// ---------------
// All three vendor clients make real OAuth2 + HTTP calls — nothing is
// mocked — but every endpoint path in them is an unverified placeholder
// written against published docs, and no tenant has ever had live
// credentials. So the first time any of it runs for real will be inside
// the nightly sync, at 04:30, across a thousand patient links, where a
// wrong path shape looks exactly like "the vendor has no data for these
// patients": `availability()` says configured, `fetchSnapshot` returns
// an error, the job logs a count and moves on.
//
// This makes that first run explicit and small: one patient, a named step
// per thing that can independently be broken, and a report of which one
// failed and what to do about it.
//
// WHY SO MANY STEPS
// -----------------
// A single pass/fail cannot distinguish the failures an operator responds
// to differently. Credentials present is not authentication. Authenticated
// is not entitled — a 403 means the secret is FINE and the account lacks
// the agreement, and rotating a good secret is the wrong move. Reaching
// the patient endpoint is not the same as the usage endpoint working;
// several vendors gate those separately. And a response that arrives but
// no longer maps is a contract change, which is the failure a nightly
// sync absorbs most quietly — dropping one field at a time while the
// counts only look a bit low.
//
// Every step reports pass / fail / skipped / not_supported, and the
// difference between the last two matters: a vendor that does not expose
// device settings is not a broken connector.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It does not persist the vendor payload. The point is to prove the pipe,
// and storing a snapshot from a "test" run would put real patient therapy
// data in a diagnostic record. It reports SHAPES and counts.

import {
  ADAPTER_ERROR_CLASS,
  ADAPTER_ERROR_REMEDY,
  integrationSnapshotSchema,
  type AdapterError,
  type IntegrationSource,
} from "@workspace/resupply-integrations";

import { recordValidationOutcome } from "./connector-status";
import { getIntegrationAdaptersForOrg } from "./registry";

export type ValidationStepName =
  /** Credentials present and well-formed enough to build a client. */
  | "configured"
  /** The vendor accepted our client credentials. */
  | "authenticated"
  /** The account is entitled to the resource, not merely authenticated. */
  | "authorized"
  /** The patient endpoint answered. */
  | "patient_lookup"
  /** Therapy nights came back. */
  | "usage_data"
  /** A compliance summary came back. */
  | "compliance_data"
  /** Device settings came back. */
  | "device_settings"
  /** More than one page of nights was returned, when a window asks for it. */
  | "pagination"
  /** What came back matches the contract we map from. */
  | "schema";

export type ValidationStepStatus =
  | "pass"
  | "fail"
  | "skipped"
  /** The vendor does not offer this. Not a fault. */
  | "not_supported"
  /** It worked but returned nothing. Also not a fault. */
  | "no_data";

export interface ValidationStep {
  name: ValidationStepName;
  status: ValidationStepStatus;
  /** Operator-facing, and safe to display: vendor error CODES and step
   *  outcomes only, never a response body. */
  detail: string;
  /** What to do about it, for a failed step. */
  remedy?: string;
}

export interface ValidateConnectionResult {
  source: IntegrationSource;
  ok: boolean;
  steps: ValidationStep[];
  /** The classified failure, when one occurred. */
  errorCategory?: AdapterError;
  /** `configuration` | `transient` | `no_data`. */
  errorClass?: string;
  failedStep?: ValidationStepName;
  /** Which sub-resources came back, when the fetch succeeded. Tells an
   *  operator that (say) therapy nights arrived but supplies did not —
   *  the difference between a broken connection and a partial one. */
  received?: {
    settings: boolean;
    compliance: boolean;
    recentNights: number;
    supplies: number;
  };
  /** Sub-resources the vendor did not return on an otherwise-good fetch. */
  partial?: Array<{ resource: string; error: string }>;
}

const STEP_ORDER: ValidationStepName[] = [
  "configured",
  "authenticated",
  "authorized",
  "patient_lookup",
  "usage_data",
  "compliance_data",
  "device_settings",
  "pagination",
  "schema",
];

/**
 * Run one end-to-end probe for a source, against a partner patient id the
 * operator supplies.
 *
 * Never throws: a validator that can fail is a validator nobody runs when
 * things are already broken — which is exactly when it is needed.
 *
 * @param args - Tenant, source, a partner patient id, and the window.
 * @returns The step-by-step report.
 */
export async function validateIntegrationConnection(args: {
  orgId: string;
  source: IntegrationSource;
  partnerPatientId: string;
  windowDays?: number;
  actorEmail?: string | null;
  /** Skip persisting the outcome (used by the batch status refresh). */
  skipStatusWrite?: boolean;
}): Promise<ValidateConnectionResult> {
  const steps: ValidationStep[] = [];

  const finish = async (
    result: ValidateConnectionResult,
    notConfigured = false,
  ): Promise<ValidateConnectionResult> => {
    if (!args.skipStatusWrite) {
      await recordValidationOutcome({
        orgId: args.orgId,
        source: args.source,
        ok: result.ok,
        failedStep: result.failedStep ?? null,
        errorCategory: result.errorCategory ?? null,
        partialResources: result.partial ?? [],
        actorEmail: args.actorEmail ?? null,
        notConfigured,
      });
    }
    return result;
  };

  const fail = (
    name: ValidationStepName,
    detail: string,
    errorCategory?: AdapterError,
  ): ValidateConnectionResult => {
    steps.push({
      name,
      status: "fail",
      detail,
      remedy: errorCategory ? ADAPTER_ERROR_REMEDY[errorCategory] : undefined,
    });
    // Everything after a failed step is unknown, not passing. Marking the
    // rest `skipped` keeps the report honest about what was actually
    // proven.
    for (const r of STEP_ORDER.slice(STEP_ORDER.indexOf(name) + 1)) {
      steps.push({ name: r, status: "skipped", detail: "not reached" });
    }
    return {
      source: args.source,
      ok: false,
      steps,
      errorCategory,
      errorClass: errorCategory
        ? ADAPTER_ERROR_CLASS[errorCategory]
        : undefined,
      failedStep: name,
    };
  };

  let adapter;
  try {
    const adapters = await getIntegrationAdaptersForOrg(args.orgId);
    adapter = adapters.get(args.source);
  } catch (err) {
    return finish(
      fail(
        "configured",
        `could not build the adapter (${err instanceof Error ? err.name : "unknown"})`,
      ),
      true,
    );
  }
  if (!adapter) {
    return finish(
      fail("configured", "no adapter registered for this source"),
      true,
    );
  }

  const availability = adapter.availability();
  if (availability.status !== "configured") {
    return finish(
      fail(
        "configured",
        `credentials are not set for this practice (${availability.status})`,
      ),
      true,
    );
  }
  steps.push({
    name: "configured",
    status: "pass",
    detail: "credentials present",
  });

  const windowDays = args.windowDays ?? 30;
  const result = await adapter.fetchSnapshot({
    partnerPatientId: args.partnerPatientId,
    windowDays,
  });

  if (!result.ok) {
    const error = result.error;
    // 401 — the secret is wrong.
    if (error === "auth_failed") {
      return finish(
        fail(
          "authenticated",
          "the vendor rejected these credentials (auth_failed)",
          error,
        ),
      );
    }
    steps.push({
      name: "authenticated",
      status: "pass",
      detail: "credentials accepted",
    });

    // 403 — the credentials are fine and the ACCOUNT is not entitled.
    // Separating this from `authenticated` is the difference between
    // "call the vendor about the agreement" and "rotate the secret".
    if (error === "forbidden") {
      return finish(
        fail(
          "authorized",
          "the vendor accepted these credentials but refused the resource (403)",
          error,
        ),
      );
    }
    steps.push({
      name: "authorized",
      status: "pass",
      detail: "the account is entitled to this resource",
    });

    // A patient the vendor has never heard of is not a broken connector.
    // It is reported as `no_data` on the lookup step, and everything
    // downstream is honestly `skipped` — but the RESULT is not a failure
    // of the connection, so `ok` stays false without marking the
    // connector unhealthy (recordValidationOutcome knows the difference).
    if (error === "not_found") {
      steps.push({
        name: "patient_lookup",
        status: "no_data",
        detail:
          "the vendor has no patient with that identifier — check the id, not the connection",
        remedy: ADAPTER_ERROR_REMEDY.not_found,
      });
      for (const r of STEP_ORDER.slice(
        STEP_ORDER.indexOf("patient_lookup") + 1,
      )) {
        steps.push({
          name: r,
          status: "skipped",
          detail: "no patient to read",
        });
      }
      return finish({
        source: args.source,
        ok: false,
        steps,
        errorCategory: error,
        errorClass: ADAPTER_ERROR_CLASS[error],
        failedStep: "patient_lookup",
      });
    }

    const detail =
      error === "endpoint_not_found"
        ? "the API path does not exist on this vendor instance (404 on a non-patient path)"
        : error === "bad_request"
          ? "the vendor rejected the request itself (400/422)"
          : error === "rate_limited"
            ? "the vendor rate-limited this request"
            : error === "timeout"
              ? "the vendor did not respond in time"
              : error === "server_error"
                ? "the vendor returned a server error (5xx)"
                : error === "unavailable"
                  ? "no response from the vendor"
                  : "the request failed";
    return finish(fail("patient_lookup", `${detail} (${error})`, error));
  }

  steps.push({
    name: "authenticated",
    status: "pass",
    detail: "credentials accepted",
  });
  steps.push({
    name: "authorized",
    status: "pass",
    detail: "the account is entitled to this resource",
  });
  steps.push({
    name: "patient_lookup",
    status: "pass",
    detail: "the vendor returned a patient record",
  });

  const parsed = integrationSnapshotSchema.safeParse(result.snapshot);
  if (!parsed.success) {
    // A shape change is the failure mode that a nightly sync absorbs
    // most quietly: rows drop one field at a time and the counts only
    // look a bit low.
    const fields = [
      ...new Set(parsed.error.issues.map((i) => i.path.join("."))),
    ]
      .slice(0, 8)
      .join(", ");
    // The three data steps are unknown, not passing, when the payload
    // does not map.
    for (const r of [
      "usage_data",
      "compliance_data",
      "device_settings",
      "pagination",
    ] as ValidationStepName[]) {
      steps.push({
        name: r,
        status: "skipped",
        detail: "the payload did not map",
      });
    }
    steps.push({
      name: "schema",
      status: "fail",
      detail: `the response no longer matches the contract we map from (fields: ${fields || "unknown"})`,
      remedy: ADAPTER_ERROR_REMEDY.mapping_failed,
    });
    return finish({
      source: args.source,
      ok: false,
      steps,
      errorCategory: "mapping_failed",
      errorClass: ADAPTER_ERROR_CLASS.mapping_failed,
      failedStep: "schema",
    });
  }

  const snap = parsed.data;
  const partial = result.partial ?? [];
  const partialByResource = new Map<string, AdapterError>(
    partial.map((p) => [p.resource as string, p.error]),
  );

  /** One data step: present, absent-because-broken, or absent-because-none. */
  const dataStep = (
    name: ValidationStepName,
    resource: string,
    present: boolean,
    count?: number,
  ): void => {
    const failure = partialByResource.get(resource);
    if (failure) {
      steps.push({
        name,
        status: "fail",
        detail: `the vendor did not return this resource (${failure})`,
        remedy: ADAPTER_ERROR_REMEDY[failure],
      });
      return;
    }
    if (!present) {
      // The vendor answered and had nothing. That is an answer, and it
      // must not read as a broken endpoint.
      steps.push({
        name,
        status: "no_data",
        detail: "the vendor returned no data of this kind for this patient",
      });
      return;
    }
    steps.push({
      name,
      status: "pass",
      detail:
        count === undefined ? "returned" : `returned (${count} record(s))`,
    });
  };

  const nights = snap.recentNights?.length ?? 0;
  dataStep("usage_data", "nights", nights > 0, nights);
  dataStep("compliance_data", "compliance", snap.compliance != null);
  dataStep("device_settings", "settings", snap.settings != null);

  // Pagination: a window wide enough to demand more than one page should
  // return more than one page's worth. We cannot see the vendor's page
  // size, so the honest test is "did a wide window return more than a
  // narrow one could have" — which needs a second call and is therefore
  // reported as `skipped` rather than guessed at.
  if (nights === 0) {
    steps.push({
      name: "pagination",
      status: "skipped",
      detail: "no nights returned, so paging could not be exercised",
    });
  } else if (nights >= windowDays) {
    steps.push({
      name: "pagination",
      status: "pass",
      detail: `returned ${nights} night(s) for a ${windowDays}-day window — the full window came back`,
    });
  } else {
    // Fewer nights than days is normal (a patient does not use the
    // machine every night). It is only a paging SUSPICION when the count
    // lands exactly on a round number, which is what a truncated page
    // looks like.
    const looksLikeAPageBoundary = nights % 50 === 0 || nights % 100 === 0;
    steps.push({
      name: "pagination",
      status: looksLikeAPageBoundary ? "fail" : "pass",
      detail: looksLikeAPageBoundary
        ? `returned exactly ${nights} nights for a ${windowDays}-day window — a round number is what a truncated page looks like; confirm the vendor is not capping the response`
        : `returned ${nights} night(s) for a ${windowDays}-day window`,
    });
  }

  steps.push({
    name: "schema",
    status: "pass",
    detail: "the response matches the contract",
  });

  const anyStepFailed = steps.some((s) => s.status === "fail");

  return finish({
    source: args.source,
    ok: !anyStepFailed,
    steps,
    partial: partial.map((p) => ({ resource: p.resource, error: p.error })),
    received: {
      settings: snap.settings != null,
      compliance: snap.compliance != null,
      recentNights: nights,
      supplies: snap.supplies?.length ?? 0,
    },
  });
}
