// @workspace/resupply-audit
//
// Append-only audit-log helper for the resupply product. EVERY write
// to `resupply.audit_log` MUST go through `logAudit()` in this
// package. Direct `db.insert(auditLog)` (Drizzle) and direct raw SQL
// `INSERT INTO resupply.audit_log` from outside this package are
// forbidden by Rule 8 in `scripts/check-resupply-architecture.sh`.
//
// Why a single chokepoint?
//   * The metadata sanitizer (`./sanitize`) is the only thing
//     standing between a careless caller and a HIPAA-reportable PHI
//     leak into a plaintext jsonb column. If callers can bypass it,
//     it doesn't matter how strict the sanitizer is.
//   * Audit rows are operationally precious — they outlive the rows
//     they describe. Centralizing the write gives us one place to
//     evolve the row shape (e.g. add a request-id column, an actor
//     id alongside the email) without hunting down N call sites.
//   * It gives us one place to wire AsyncLocalStorage actor
//     propagation when that lands (see ADR 006).
//
// Phase 0 keeps the helper tiny: validate metadata, raw INSERT via
// the shared pool. No transactional context yet — when audit rows
// need to participate in a request transaction, we'll add an
// overload that accepts a `PoolClient` rather than fetching one
// fresh.

import { getDbPool } from "@workspace/resupply-db";

import { sanitizeMetadata } from "./sanitize";

export {
  AUDIT_METADATA_MAX_BYTES,
  AUDIT_METADATA_MAX_DEPTH,
  AuditMetadataDepthError,
  AuditMetadataPhiError,
  AuditMetadataShapeError,
  AuditMetadataSizeError,
  sanitizeMetadata,
} from "./sanitize";

export interface AuditEvent {
  /**
   * Free-form verb namespaced like `patient.view`,
   * `episode.confirm`, `fulfillment.upload_csv`. The list of valid
   * actions is documented per-feature; this field is deliberately
   * `string` rather than a closed enum so a new feature can ship
   * its audit verb in one PR.
   */
  action: string;

  /**
   * Admin email at write time, denormalized from the auth provider so the
   * row remains readable if the auth user is later deleted. Null
   * for system actions (cron jobs, queue workers).
   */
  adminEmail?: string | null;

  /**
   * Admin's auth user id. Null for system actions.
   */
  adminUserId?: string | null;

  /**
   * Logical pointer to the row this action touched. Opaque — see
   * the schema comment for why we don't FK-constrain it.
   */
  targetTable?: string | null;
  targetId?: string | null;

  /**
   * Plaintext jsonb context. MUST NOT contain PHI; the sanitizer
   * enforces this with a denylist + size + depth limits and throws
   * `AuditMetadataPhiError` on violation.
   */
  metadata?: Record<string, unknown>;

  /** Request envelope. Both optional. */
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Write one audit row. Throws on:
 *   * `AuditMetadataPhiError` — metadata contained a PHI-shaped key
 *     at any depth.
 *   * `AuditMetadataSizeError` — serialized metadata exceeded the
 *     byte cap.
 *   * `AuditMetadataDepthError` — nested too deep.
 *   * `AuditMetadataShapeError` — metadata wasn't a plain object.
 *   * Any pg error from the INSERT itself (caller is responsible
 *     for transactional semantics + retry policy).
 *
 * The metadata-validation errors are PROGRAMMER errors — surface as
 * 500s, do not silently swallow. The point of this gate is to make
 * the bug LOUD so we don't ship silent PHI leakage to plaintext.
 */
/**
 * Optional bridge from a host process's request-context mechanism
 * (e.g. AsyncLocalStorage in the API) to this lib. When set, every
 * `logAudit()` call automatically adds `_request_id: <id>` to its
 * metadata so an audit row from inside a request handler ties back
 * to the same correlation key the access log + structured log lines
 * already carry.
 *
 * Kept as a registration pattern (not a direct import of the API's
 * AsyncLocalStorage) so this lib stays usable from places without
 * a request context — worker jobs, CLI scripts, tests. Outside an
 * API process, the resolver is unset and audit rows simply don't
 * gain the field.
 */
let resolveRequestId: (() => string | null) | null = null;

export function registerAuditRequestIdResolver(
  fn: (() => string | null) | null,
): void {
  resolveRequestId = fn;
}

export async function logAudit(event: AuditEvent): Promise<void> {
  const requestId = resolveRequestId?.() ?? null;
  // Don't mutate the caller's metadata object. `_request_id` uses an
  // underscore prefix so it's visually distinct from the
  // caller-supplied keys in the resulting jsonb and so the
  // sanitizer's denylist (which targets PHI-shaped keys) doesn't
  // accidentally match it.
  const metadataInput =
    requestId !== null
      ? { _request_id: requestId, ...event.metadata }
      : event.metadata;
  const metadata = sanitizeMetadata(metadataInput);

  await getDbPool().query(
    "INSERT INTO resupply.audit_log " +
      "(operator_email, operator_user_id, action, " +
      " target_table, target_id, metadata, ip, user_agent) " +
      "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)",
    [
      event.adminEmail ?? null,
      event.adminUserId ?? null,
      event.action,
      event.targetTable ?? null,
      event.targetId ?? null,
      JSON.stringify(metadata),
      event.ip ?? null,
      event.userAgent ?? null,
    ],
  );
}

/**
 * Best-effort variant of `logAudit` for call sites where audit-write
 * failure must NOT block the user-visible flow (post-success
 * background tasks, webhook handlers, worker jobs).
 *
 * Behavior:
 *   * Sanitizer errors (PHI, shape, size, depth) STILL THROW. The
 *     metadata-validation gate is a programmer correctness check —
 *     a silent-eat there would defeat its purpose, so we re-throw
 *     so the call site sees the bug.
 *   * DB-level errors (pool exhaustion, deadlock, transient
 *     connection issue) are swallowed and logged via the caller-
 *     provided `onWriteFailure` callback (or no-op if none given).
 *   * The callback receives the original error AND a stable event
 *     name (`audit_write_failed`) so a logging adapter can grep
 *     for systemic outages: a single failure is normal noise; a
 *     run of them under a few minutes is a signal that the audit
 *     DB or pool is unhealthy.
 *
 * Returns `true` on successful write, `false` on swallowed DB
 * failure, and re-throws on sanitizer / programmer errors.
 *
 * Call sites adopt this helper instead of try/catch so the
 * categorization of "what's a programmer bug vs what's transient"
 * stays in one place.
 */
export async function logAuditBestEffort(
  event: AuditEvent,
  options: {
    /** Stable label for the failure log — e.g. "post_login_audit". */
    contextLabel: string;
    /**
     * Caller-provided logger hook. Receives the categorized failure
     * envelope so a pino consumer can grep for `audit_write_failed`
     * across services without depending on this lib's logger choice.
     */
    onWriteFailure?: (failure: {
      event: "audit_write_failed";
      contextLabel: string;
      action: string;
      err: unknown;
    }) => void;
  },
): Promise<boolean> {
  try {
    await logAudit(event);
    return true;
  } catch (err) {
    // Re-throw programmer errors. The classes are exported above so
    // call sites can also instanceof-check; here we use name-equality
    // to avoid an import cycle on the sanitize file.
    const name =
      err instanceof Error
        ? err.name
        : null;
    if (
      name === "AuditMetadataPhiError" ||
      name === "AuditMetadataSizeError" ||
      name === "AuditMetadataDepthError" ||
      name === "AuditMetadataShapeError"
    ) {
      throw err;
    }
    options.onWriteFailure?.({
      event: "audit_write_failed",
      contextLabel: options.contextLabel,
      action: event.action,
      err,
    });
    return false;
  }
}
