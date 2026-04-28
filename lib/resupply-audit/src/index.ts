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
   * Admin email at write time, denormalized from Clerk so the
   * row remains readable if the Clerk user is later deleted. Null
   * for system actions (cron jobs, queue workers).
   */
  adminEmail?: string | null;

  /**
   * Admin's Clerk user id. Null for system actions.
   */
  adminClerkId?: string | null;

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
export async function logAudit(event: AuditEvent): Promise<void> {
  const metadata = sanitizeMetadata(event.metadata);

  await getDbPool().query(
    "INSERT INTO resupply.audit_log " +
      "(operator_email, operator_clerk_id, action, " +
      " target_table, target_id, metadata, ip, user_agent) " +
      "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)",
    [
      event.adminEmail ?? null,
      event.adminClerkId ?? null,
      event.action,
      event.targetTable ?? null,
      event.targetId ?? null,
      JSON.stringify(metadata),
      event.ip ?? null,
      event.userAgent ?? null,
    ],
  );
}
