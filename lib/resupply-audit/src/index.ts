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
// Phase 0 keeps the helper tiny: validate metadata, INSERT via the
// shared Supabase service-role client. No transactional context yet —
// when audit rows need to participate in a request transaction, we'll
// add an overload that accepts a `ResupplySupabaseClient` against an
// open transaction (PostgREST does not expose transactions, so this
// would require a Postgres function).

import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";

import { sanitizeMetadata } from "./sanitize";
import {
  type AuditChainContent,
  requireAuditHmacKey,
  signAuditRow,
} from "./sign";

export {
  AUDIT_METADATA_MAX_BYTES,
  AUDIT_METADATA_MAX_DEPTH,
  AuditMetadataDepthError,
  AuditMetadataPhiError,
  AuditMetadataShapeError,
  AuditMetadataSizeError,
  sanitizeMetadata,
} from "./sanitize";
export {
  AUDIT_HMAC_KEY_ENV,
  AuditHmacKeyError,
  canonicalJson,
  registerAuditHmacKeyForTesting,
  requireAuditHmacKey,
  signAuditRow,
  type AuditChainContent,
} from "./sign";

/**
 * Max number of retries when two writers race on the same
 * chain_seq. Each retry costs one fast indexed SELECT plus the
 * losing INSERT, so the budget can be generous — 8 retries with
 * a unique constraint is dominated by the contention rate, not the
 * retry ceiling.
 */
const CHAIN_INSERT_MAX_ATTEMPTS = 8;

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

/**
 * Appends a single signed audit row to the `resupply.audit_log` table after validating metadata.
 *
 * The function augments the provided metadata with a resolved request id (if available), runs
 * metadata sanitization, constructs an HMAC-signed chain entry, and inserts the new row with the
 * next `chain_seq` and signature. On concurrent writers it retries the insert when the database
 * reports a `chain_seq` uniqueness violation, up to `CHAIN_INSERT_MAX_ATTEMPTS`.
 *
 * @param event - Audit event fields (action, optional operator/target info, metadata, ip, userAgent)
 * @throws AuditMetadataPhiError | AuditMetadataSizeError | AuditMetadataDepthError | AuditMetadataShapeError
 *         When metadata fails sanitization.
 * @throws AuditHmacKeyError
 *         When the required audit HMAC key cannot be loaded.
 * @throws Error
 *         On database/insert failures other than retriable chain-sequence contention, or when the
 *         retry budget for chain-sequence contention is exhausted.
 */
export async function logAudit(event: AuditEvent): Promise<void> {
  const requestId = resolveRequestId?.() ?? null;
  // Don't mutate the caller's metadata object. `_request_id` uses an
  // underscore prefix so it's visually distinct from the
  // caller-supplied keys in the resulting jsonb and so the
  // sanitizer's denylist (which targets PHI-shaped keys) doesn't
  // accidentally match it.
  const metadataInput =
    requestId !== null
      ? { ...event.metadata, _request_id: requestId }
      : event.metadata;
  const metadata = sanitizeMetadata(metadataInput);
  const key = requireAuditHmacKey();
  const supabase = getSupabaseServiceRoleClient();

  // HMAC chain: read the current tip, sign, insert with the next
  // chain_seq. Two concurrent writers can both read tip N and try
  // to insert N+1 — the unique partial index throws 23505 on the
  // loser, who reads the now-updated tip and retries.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < CHAIN_INSERT_MAX_ATTEMPTS; attempt++) {
    const { data: latest, error: latestErr } = await supabase
      .schema("resupply")
      .from("audit_log")
      .select("chain_seq, signature")
      .not("chain_seq", "is", null)
      .order("chain_seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) throw latestErr;

    const prevSeq = latest?.chain_seq ?? 0;
    const prevSignature = latest?.signature ?? null;
    // chain_seq is bigint in Postgres but `number` in the generated
    // Supabase types. JS numbers stay precise up to 2^53; the
    // canonical JSON encoding of chain_seq also goes through
    // JSON.stringify, so once the chain crosses that threshold the
    // signature input is lossy and verification breaks. Fail loudly
    // if we ever approach the boundary so the chain can be
    // rotated/segmented operationally before silent corruption.
    if (!Number.isSafeInteger(prevSeq) || prevSeq < 0) {
      throw new Error(
        `audit_log chain_seq ${prevSeq} is outside the safe-integer range; rotate the audit chain before continuing`,
      );
    }
    const chainSeq = prevSeq + 1;

    const content: AuditChainContent = {
      chain_seq: chainSeq,
      operator_email: event.adminEmail ?? null,
      operator_user_id: event.adminUserId ?? null,
      action: event.action,
      target_table: event.targetTable ?? null,
      target_id: event.targetId ?? null,
      metadata,
      ip: event.ip ?? null,
      user_agent: event.userAgent ?? null,
    };
    const signature = signAuditRow(key, prevSignature, content);

    const { error } = await supabase
      .schema("resupply")
      .from("audit_log")
      .insert({
        operator_email: event.adminEmail ?? null,
        operator_user_id: event.adminUserId ?? null,
        action: event.action,
        target_table: event.targetTable ?? null,
        target_id: event.targetId ?? null,
        metadata: metadata as unknown as Json,
        ip: event.ip ?? null,
        user_agent: event.userAgent ?? null,
        chain_seq: chainSeq,
        prev_signature: prevSignature,
        signature,
      });
    if (!error) return;
    // Retry only on chain_seq unique-violation; any other error
    // surfaces immediately so a permission / shape / network issue
    // doesn't masquerade as contention.
    if ((error as { code?: string }).code === "23505") {
      lastError = error;
      continue;
    }
    throw error;
  }
  throw new Error(
    `audit_log chain insert: chain_seq contention exceeded ${CHAIN_INSERT_MAX_ATTEMPTS} attempts` +
      (lastError ? ` (last: ${String(lastError)})` : ""),
  );
}

/**
 * Attempts to write an audit row but does not allow transient write failures to block the caller.
 *
 * Re-throws metadata/sanitizer and HMAC-key errors; calls `onWriteFailure` and returns `false` for DB/transient failures; returns `true` on successful write.
 *
 * @param event - The audit event to write.
 * @param options - Callsite options controlling failure handling.
 * @param options.contextLabel - Stable label identifying the callsite context (e.g. "post_login_audit").
 * @param options.onWriteFailure - Optional callback invoked with a failure envelope when a non-programmer/transient write error occurs.
 * @returns `true` if the audit write succeeded, `false` if a DB/transient failure was swallowed.
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
      name === "AuditMetadataShapeError" ||
      name === "AuditHmacKeyError"
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
