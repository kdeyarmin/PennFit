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
// `not_found`, the job logs a count and moves on.
//
// This makes that first run explicit and small: one patient, four named
// steps, and a report of which one failed. An operator runs it the day
// credentials arrive, and again whenever a sync starts looking thin.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It does not persist the vendor payload. The point is to prove the pipe,
// and storing a snapshot from a "test" run would put real patient therapy
// data in a diagnostic record. It reports SHAPES and counts.

import {
  integrationSnapshotSchema,
  type IntegrationSource,
} from "@workspace/resupply-integrations";

import { getIntegrationAdaptersForOrg } from "./registry";

export type ValidationStepName =
  /** Credentials present and well-formed enough to build a client. */
  | "configured"
  /** The vendor accepted our client credentials. */
  | "authenticated"
  /** A patient fetch returned something. */
  | "fetched"
  /** What came back matches the contract we map from. */
  | "schema";

export type ValidationStepStatus = "pass" | "fail" | "skipped";

export interface ValidationStep {
  name: ValidationStepName;
  status: ValidationStepStatus;
  /** Operator-facing, and safe to display: vendor error CODES and step
   *  outcomes only, never a response body. */
  detail: string;
}

export interface ValidateConnectionResult {
  source: IntegrationSource;
  ok: boolean;
  steps: ValidationStep[];
  /** Which sub-resources came back, when the fetch succeeded. Tells an
   *  operator that (say) therapy nights arrived but supplies did not —
   *  the difference between a broken connection and a partial one. */
  received?: {
    settings: boolean;
    compliance: boolean;
    recentNights: number;
    supplies: number;
  };
}

/**
 * Run one end-to-end probe for a source, against a partner patient id the
 * operator supplies.
 *
 * Never throws: a validator that can fail is a validator nobody runs when
 * things are already broken.
 */
export async function validateIntegrationConnection(args: {
  orgId: string;
  source: IntegrationSource;
  partnerPatientId: string;
  windowDays?: number;
}): Promise<ValidateConnectionResult> {
  const steps: ValidationStep[] = [];
  const fail = (
    name: ValidationStepName,
    detail: string,
  ): ValidateConnectionResult => {
    steps.push({ name, status: "fail", detail });
    // Everything after a failed step is unknown, not passing. Marking the
    // rest `skipped` keeps the report honest about what was actually
    // proven.
    const remaining: ValidationStepName[] = [
      "configured",
      "authenticated",
      "fetched",
      "schema",
    ].slice(
      ["configured", "authenticated", "fetched", "schema"].indexOf(name) + 1,
    ) as ValidationStepName[];
    for (const r of remaining) {
      steps.push({ name: r, status: "skipped", detail: "not reached" });
    }
    return { source: args.source, ok: false, steps };
  };

  let adapter;
  try {
    const adapters = await getIntegrationAdaptersForOrg(args.orgId);
    adapter = adapters.get(args.source);
  } catch (err) {
    return fail(
      "configured",
      `could not build the adapter (${err instanceof Error ? err.name : "unknown"})`,
    );
  }
  if (!adapter) {
    return fail("configured", "no adapter registered for this source");
  }

  const availability = adapter.availability();
  if (availability.status !== "configured") {
    return fail(
      "configured",
      `credentials are not set for this practice (${availability.status})`,
    );
  }
  steps.push({
    name: "configured",
    status: "pass",
    detail: "credentials present",
  });

  const result = await adapter.fetchSnapshot({
    partnerPatientId: args.partnerPatientId,
    windowDays: args.windowDays ?? 30,
  });

  if (!result.ok) {
    // Auth failures are a credential problem; everything else is a
    // request problem. Saying which one saves an operator from rotating
    // a perfectly good secret because a path was wrong.
    if (result.error === "auth_failed") {
      return fail(
        "authenticated",
        "the vendor rejected these credentials (auth_failed)",
      );
    }
    steps.push({
      name: "authenticated",
      status: "pass",
      detail: "credentials accepted",
    });
    const hint =
      result.error === "not_found"
        ? "the vendor has no such patient, or the API path shape is wrong for this instance"
        : result.error === "rate_limited"
          ? "the vendor rate-limited this request; try again shortly"
          : result.error === "unavailable"
            ? "the vendor did not respond"
            : "the request failed";
    return fail("fetched", `${hint} (${result.error})`);
  }

  steps.push({
    name: "authenticated",
    status: "pass",
    detail: "credentials accepted",
  });
  steps.push({
    name: "fetched",
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
    return fail(
      "schema",
      `the response no longer matches the contract we map from (fields: ${fields || "unknown"})`,
    );
  }
  steps.push({
    name: "schema",
    status: "pass",
    detail: "the response matches the contract",
  });

  const snap = parsed.data;
  return {
    source: args.source,
    ok: true,
    steps,
    received: {
      settings: snap.settings != null,
      compliance: snap.compliance != null,
      recentNights: snap.recentNights?.length ?? 0,
      supplies: snap.supplies?.length ?? 0,
    },
  };
}
