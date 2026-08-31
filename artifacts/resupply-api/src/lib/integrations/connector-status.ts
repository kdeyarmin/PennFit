// connector-status.ts — the per-tenant record of what each therapy-cloud
// connector last actually did.
//
// WHY THIS IS NOT `availability()`
// -------------------------------
// `availability()` reads environment variables. It answers "are the
// credentials present?" — which a revoked secret, a missing partnership
// entitlement, and a wrong endpoint path all pass. Every endpoint in the
// three vendor clients is an unverified placeholder written against
// published docs, and no tenant has ever had live credentials, so
// "configured" is close to meaningless as a health signal today.
//
// This records what happened when we actually called: attempted and
// succeeded kept SEPARATE, because "last tried at 04:30, last succeeded
// three weeks ago" is the shape of a connector that has been broken for
// three weeks and a single `last_run_at` cannot say it.
//
// `live_validated` is the only status that means a real vendor call
// succeeded for this tenant. Nothing in the product may claim production
// validation without it — that claim is the specific thing this table
// exists to make checkable rather than assertable.
//
// PHI / SECRETS: no credential, no vendor payload, no patient identifier.
// Timestamps, counts, a classified error CATEGORY, an API version string.

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  ADAPTER_ERROR_REMEDY,
  indicatesUnhealthyConnector,
  type AdapterError,
  type IntegrationSource,
} from "@workspace/resupply-integrations";

import { logger } from "../logger";

export type ConnectorStatus =
  /** Credentials may be present; nothing has proved they work. */
  | "unvalidated"
  /** Credentials are absent for this tenant. */
  | "not_configured"
  /** A real vendor call succeeded here. */
  | "live_validated"
  /** It worked before and is failing now, or returns partial data. */
  | "degraded"
  /** Consecutive failures; the circuit breaker is likely open. */
  | "failing"
  /** Deliberately switched off. */
  | "disabled";

export interface ConnectorStatusRow {
  source: IntegrationSource;
  status: ConnectorStatus;
  lastValidationAttemptAt: string | null;
  lastValidationSuccessAt: string | null;
  lastSyncAttemptAt: string | null;
  lastSyncSuccessAt: string | null;
  lastErrorCategory: AdapterError | null;
  lastErrorStep: string | null;
  /** What an operator should do about `lastErrorCategory`. */
  lastErrorRemedy: string | null;
  vendorApiVersion: string | null;
  partialResources: Array<{ resource: string; error: string }>;
  consecutiveFailures: number;
  lastReconciliationAt: string | null;
  lastReconciliationStatus: string | null;
  validatedByEmail: string | null;
  updatedAt: string | null;
}

interface DbRow {
  source: string;
  status: string;
  last_validation_attempt_at: string | null;
  last_validation_success_at: string | null;
  last_sync_attempt_at: string | null;
  last_sync_success_at: string | null;
  last_error_category: string | null;
  last_error_step: string | null;
  vendor_api_version: string | null;
  partial_resources: unknown;
  consecutive_failures: number;
  last_reconciliation_at: string | null;
  last_reconciliation_status: string | null;
  validated_by_email: string | null;
  updated_at: string | null;
}

const SELECT =
  "source, status, last_validation_attempt_at, last_validation_success_at, " +
  "last_sync_attempt_at, last_sync_success_at, last_error_category, " +
  "last_error_step, vendor_api_version, partial_resources, " +
  "consecutive_failures, last_reconciliation_at, last_reconciliation_status, " +
  "validated_by_email, updated_at";

function toRow(row: DbRow): ConnectorStatusRow {
  const category = row.last_error_category as AdapterError | null;
  return {
    source: row.source as IntegrationSource,
    status: row.status as ConnectorStatus,
    lastValidationAttemptAt: row.last_validation_attempt_at,
    lastValidationSuccessAt: row.last_validation_success_at,
    lastSyncAttemptAt: row.last_sync_attempt_at,
    lastSyncSuccessAt: row.last_sync_success_at,
    lastErrorCategory: category,
    lastErrorStep: row.last_error_step,
    lastErrorRemedy:
      category && category in ADAPTER_ERROR_REMEDY
        ? ADAPTER_ERROR_REMEDY[category]
        : null,
    vendorApiVersion: row.vendor_api_version,
    partialResources: Array.isArray(row.partial_resources)
      ? (row.partial_resources as Array<{ resource: string; error: string }>)
      : [],
    consecutiveFailures: row.consecutive_failures,
    lastReconciliationAt: row.last_reconciliation_at,
    lastReconciliationStatus: row.last_reconciliation_status,
    validatedByEmail: row.validated_by_email,
    updatedAt: row.updated_at,
  };
}

/**
 * Read every connector's recorded status for a tenant.
 *
 * A source with no row is not returned. Callers merge against the full
 * source list and treat an absent row as `unvalidated` — which is the
 * honest reading, and different from `not_configured`.
 *
 * @param orgId - Tenant.
 * @returns One entry per source that has a row.
 */
export async function readConnectorStatuses(
  orgId: string,
): Promise<Map<IntegrationSource, ConnectorStatusRow>> {
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await supabase
    .from("integration_connector_status")
    .select(SELECT);
  if (error) throw error;
  const out = new Map<IntegrationSource, ConnectorStatusRow>();
  for (const raw of (data ?? []) as unknown as DbRow[]) {
    const row = toRow(raw);
    out.set(row.source, row);
  }
  return out;
}

export interface RecordValidationInput {
  orgId: string;
  source: IntegrationSource;
  /** Did the whole probe succeed? */
  ok: boolean;
  /** Which step failed, when one did. */
  failedStep?: string | null;
  errorCategory?: AdapterError | null;
  vendorApiVersion?: string | null;
  partialResources?: Array<{ resource: string; error: string }>;
  actorEmail?: string | null;
  /** Credentials are absent — distinct from a failed call. */
  notConfigured?: boolean;
}

/**
 * Record the outcome of a validation probe.
 *
 * Fail-soft: a validator that throws because it could not write its own
 * bookkeeping is a validator nobody runs when things are already broken,
 * which is precisely when it is needed.
 *
 * @param input - The probe outcome.
 * @returns Whether the status row was written.
 */
export async function recordValidationOutcome(
  input: RecordValidationInput,
): Promise<boolean> {
  const now = new Date().toISOString();

  let status: ConnectorStatus;
  if (input.notConfigured) status = "not_configured";
  else if (input.ok) {
    status =
      (input.partialResources?.length ?? 0) > 0 ? "degraded" : "live_validated";
  } else status = "failing";

  // A `not_found` on a test patient is not a broken connector — the
  // operator gave an id the vendor has never heard of. Counting it as a
  // failure would make a working connection look unhealthy.
  const unhealthy =
    !input.ok &&
    (input.errorCategory === null ||
      input.errorCategory === undefined ||
      indicatesUnhealthyConnector(input.errorCategory));

  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data: existing, error: readErr } = await supabase
      .from("integration_connector_status")
      .select("consecutive_failures")
      .eq("source", input.source)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;

    const priorFailures =
      (existing as { consecutive_failures?: number } | null)
        ?.consecutive_failures ?? 0;

    const patch = {
      org_id: input.orgId,
      source: input.source,
      status,
      last_validation_attempt_at: now,
      // Only a real success moves this. Keeping it separate from the
      // attempt timestamp is what lets a status page say "last tried
      // today, last worked three weeks ago".
      ...(input.ok ? { last_validation_success_at: now } : {}),
      last_error_category: input.ok ? null : (input.errorCategory ?? null),
      last_error_step: input.ok ? null : (input.failedStep ?? null),
      vendor_api_version: input.vendorApiVersion ?? null,
      partial_resources: input.partialResources ?? [],
      consecutive_failures: input.ok
        ? 0
        : unhealthy
          ? priorFailures + 1
          : priorFailures,
      validated_by_email: input.actorEmail ?? null,
      updated_at: now,
    };

    if (existing) {
      const { error } = await supabase
        .from("integration_connector_status")
        .update(patch)
        .eq("source", input.source);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("integration_connector_status")
        .insert(patch);
      if (error) throw error;
    }
    return true;
  } catch (err) {
    logger.warn(
      {
        event: "integrations.connector_status_write_failed",
        orgId: input.orgId,
        source: input.source,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "integrations: could not record connector status",
    );
    return false;
  }
}

/**
 * Record the outcome of a SYNC (as opposed to an operator-run probe).
 *
 * Deliberately never promotes a connector to `live_validated`: a sync
 * that happens to succeed is not the deliberate, attributed validation an
 * operator ran and recorded evidence for. It can only DEMOTE a validated
 * connector to `degraded`/`failing`, or refresh the success timestamp of
 * one already validated.
 *
 * @param input - Sync outcome for one tenant/source.
 */
export async function recordSyncOutcome(input: {
  orgId: string;
  source: IntegrationSource;
  ok: boolean;
  errorCategory?: AdapterError | null;
  partialResources?: Array<{ resource: string; error: string }>;
}): Promise<void> {
  const now = new Date().toISOString();
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data: existing, error: readErr } = await supabase
      .from("integration_connector_status")
      .select("status, consecutive_failures")
      .eq("source", input.source)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;

    const prior = existing as {
      status?: string;
      consecutive_failures?: number;
    } | null;
    const priorFailures = prior?.consecutive_failures ?? 0;
    const wasValidated =
      prior?.status === "live_validated" || prior?.status === "degraded";

    let status: ConnectorStatus;
    if (input.ok) {
      status =
        (input.partialResources?.length ?? 0) > 0
          ? "degraded"
          : wasValidated
            ? "live_validated"
            : // A sync succeeding does not earn `live_validated` — see the
              // header. It stays unvalidated until someone runs the probe
              // and records the evidence.
              ((prior?.status as ConnectorStatus) ?? "unvalidated");
    } else {
      const unhealthy =
        !input.errorCategory ||
        indicatesUnhealthyConnector(input.errorCategory);
      status = unhealthy
        ? priorFailures + 1 >= 3
          ? "failing"
          : "degraded"
        : ((prior?.status as ConnectorStatus) ?? "unvalidated");
    }

    const patch = {
      org_id: input.orgId,
      source: input.source,
      status,
      last_sync_attempt_at: now,
      ...(input.ok ? { last_sync_success_at: now } : {}),
      last_error_category: input.ok ? null : (input.errorCategory ?? null),
      partial_resources: input.partialResources ?? [],
      consecutive_failures: input.ok ? 0 : priorFailures + 1,
      updated_at: now,
    };

    if (existing) {
      const { error } = await supabase
        .from("integration_connector_status")
        .update(patch)
        .eq("source", input.source);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("integration_connector_status")
        .insert(patch);
      if (error) throw error;
    }
  } catch (err) {
    logger.warn(
      {
        event: "integrations.connector_sync_status_write_failed",
        orgId: input.orgId,
        source: input.source,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "integrations: could not record sync status",
    );
  }
}

/** Record that a portal reconciliation ran. */
export async function recordReconciliationOutcome(input: {
  orgId: string;
  source: IntegrationSource;
  status: "completed" | "failed";
}): Promise<void> {
  const now = new Date().toISOString();
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data: existing } = await supabase
      .from("integration_connector_status")
      .select("source")
      .eq("source", input.source)
      .limit(1)
      .maybeSingle();
    const patch = {
      org_id: input.orgId,
      source: input.source,
      last_reconciliation_at: now,
      last_reconciliation_status: input.status,
      updated_at: now,
    };
    if (existing) {
      await supabase
        .from("integration_connector_status")
        .update(patch)
        .eq("source", input.source);
    } else {
      await supabase.from("integration_connector_status").insert(patch);
    }
  } catch (err) {
    logger.warn(
      {
        event: "integrations.reconciliation_status_write_failed",
        orgId: input.orgId,
        source: input.source,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "integrations: could not record reconciliation status",
    );
  }
}
