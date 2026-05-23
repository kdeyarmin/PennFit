// @workspace/resupply-audit — no-op stub.
//
// The HIPAA §164.312(b) tamper-evident audit chain has been retired
// from the resupply product. The original implementation hashed each
// audit row into an append-only chain in `resupply.audit_log` so that
// tampering with a single row broke the chain. The table is gone.
//
// 150+ files across the codebase still call `logAudit()` /
// `logAuditBestEffort()` on the assumption the package exists. Rather
// than chase every call site (a tractable but separate cleanup), this
// file preserves the original public API as no-ops so the rest of the
// codebase keeps compiling. The functions accept the same arguments
// they always did, return what they always returned, and do nothing.
//
// If you're writing new audit logic, do NOT call these — they're
// kept for back-compat only. Pick a different observability path
// (the application logger, a webhook, a domain event).

export const AUDIT_METADATA_MAX_BYTES = 4096;
export const AUDIT_METADATA_MAX_DEPTH = 6;
export const AUDIT_HMAC_KEY_ENV = "RESUPPLY_AUDIT_HMAC_KEY";

export class AuditMetadataPhiError extends Error {}
export class AuditMetadataSizeError extends Error {}
export class AuditMetadataDepthError extends Error {}
export class AuditMetadataShapeError extends Error {}
export class AuditHmacKeyError extends Error {}

export function sanitizeMetadata(value: unknown): unknown {
  return value;
}

export function requireAuditHmacKey(): Buffer {
  return Buffer.alloc(0);
}

export interface AuditChainContent {
  chainSeq: number;
  prevSignature: string | null;
  action: string;
  actorEmail: string | null;
  targetTable: string | null;
  targetId: string | null;
  metadata: unknown;
  occurredAt: string;
}

export function signAuditRow(
  _key: Buffer,
  _content: AuditChainContent,
): string {
  return "";
}

export interface AuditEvent {
  action: string;
  adminEmail?: string | null;
  adminUserId?: string | null;
  targetTable?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

export function registerAuditRequestIdResolver(
  _fn: (() => string | null) | null,
): void {
  /* no-op */
}

export async function logAudit(_event: AuditEvent): Promise<void> {
  /* no-op — audit_log table retired */
}

export async function logAuditBestEffort(
  _event: AuditEvent,
  _options: {
    contextLabel: string;
    onWriteFailure?: (envelope: {
      event: "audit_write_failed";
      contextLabel: string;
      action: string;
      err: unknown;
    }) => void;
  },
): Promise<boolean> {
  return true;
}
