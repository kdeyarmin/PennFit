// Tests for lib/resupply-audit/src/index.ts
//
// PR change: removed `AUDIT_HMAC_KEY_ENV` export ("RESUPPLY_AUDIT_HMAC_KEY").
// The HIPAA §164.312(b) tamper-evident audit chain was retired; the env-var
// constant is no longer exported from the public surface.
//
// These tests verify:
//   1. `AUDIT_HMAC_KEY_ENV` is NOT exported (removed in this PR).
//   2. The remaining public constants and no-op functions are still exported
//      with the correct shapes so back-compat call sites keep compiling.

import { describe, expect, it, vi } from "vitest";

import * as auditIndex from "./index";

// ---------------------------------------------------------------------------
// AUDIT_HMAC_KEY_ENV — removed in this PR
// ---------------------------------------------------------------------------

describe("resupply-audit index — AUDIT_HMAC_KEY_ENV removed", () => {
  it("does NOT export AUDIT_HMAC_KEY_ENV", () => {
    expect("AUDIT_HMAC_KEY_ENV" in auditIndex).toBe(false);
  });

  it("does NOT export a value for the old key string RESUPPLY_AUDIT_HMAC_KEY", () => {
    // Belt-and-suspenders: confirm neither the key name nor the string value
    // appears as a named export on the module.
    const keys = Object.keys(auditIndex);
    expect(keys).not.toContain("AUDIT_HMAC_KEY_ENV");
    expect(keys).not.toContain("RESUPPLY_AUDIT_HMAC_KEY");
  });
});

// ---------------------------------------------------------------------------
// Remaining constants — still present after the PR
// ---------------------------------------------------------------------------

describe("resupply-audit index — constants still exported", () => {
  it("exports AUDIT_METADATA_MAX_BYTES = 4096", () => {
    expect(auditIndex.AUDIT_METADATA_MAX_BYTES).toBe(4096);
  });

  it("exports AUDIT_METADATA_MAX_DEPTH = 6", () => {
    expect(auditIndex.AUDIT_METADATA_MAX_DEPTH).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Error classes — still exported
// ---------------------------------------------------------------------------

describe("resupply-audit index — error classes still exported", () => {
  it("exports AuditMetadataPhiError as an Error subclass", () => {
    expect(new auditIndex.AuditMetadataPhiError("test")).toBeInstanceOf(Error);
  });

  it("exports AuditMetadataSizeError", () => {
    expect(new auditIndex.AuditMetadataSizeError("test")).toBeInstanceOf(Error);
  });

  it("exports AuditMetadataDepthError", () => {
    expect(new auditIndex.AuditMetadataDepthError("test")).toBeInstanceOf(Error);
  });

  it("exports AuditMetadataShapeError", () => {
    expect(new auditIndex.AuditMetadataShapeError("test")).toBeInstanceOf(Error);
  });

  it("exports AuditHmacKeyError", () => {
    expect(new auditIndex.AuditHmacKeyError("test")).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// No-op functions — correct shapes and return values
// ---------------------------------------------------------------------------

describe("resupply-audit index — no-op functions", () => {
  it("sanitizeMetadata returns the value unchanged (no-op)", () => {
    const obj = { foo: "bar", nested: { x: 1 } };
    expect(auditIndex.sanitizeMetadata(obj)).toBe(obj);
  });

  it("sanitizeMetadata handles primitives", () => {
    expect(auditIndex.sanitizeMetadata(42)).toBe(42);
    expect(auditIndex.sanitizeMetadata(null)).toBeNull();
    expect(auditIndex.sanitizeMetadata("hello")).toBe("hello");
  });

  it("requireAuditHmacKey returns an empty Buffer", () => {
    const buf = auditIndex.requireAuditHmacKey();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(0);
  });

  it("signAuditRow returns an empty string", () => {
    const sig = auditIndex.signAuditRow(Buffer.alloc(32), {
      chainSeq: 1,
      prevSignature: null,
      action: "test_action",
      actorEmail: null,
      targetTable: null,
      targetId: null,
      metadata: {},
      occurredAt: new Date().toISOString(),
    });
    expect(sig).toBe("");
  });

  it("registerAuditRequestIdResolver accepts a function and does nothing", () => {
    // Should not throw
    expect(() => {
      auditIndex.registerAuditRequestIdResolver(() => "req-123");
    }).not.toThrow();
    expect(() => {
      auditIndex.registerAuditRequestIdResolver(null);
    }).not.toThrow();
  });

  it("logAudit resolves to undefined (no-op async)", async () => {
    const result = await auditIndex.logAudit({
      action: "patient_viewed",
      adminEmail: "admin@example.com",
    });
    expect(result).toBeUndefined();
  });

  it("logAuditBestEffort resolves to true (no-op async)", async () => {
    const result = await auditIndex.logAuditBestEffort(
      { action: "patient_viewed" },
      { contextLabel: "test" },
    );
    expect(result).toBe(true);
  });

  it("logAuditBestEffort never calls onWriteFailure (it always 'succeeds')", async () => {
    const onWriteFailure = vi.fn();
    await auditIndex.logAuditBestEffort(
      { action: "patient_viewed" },
      { contextLabel: "test", onWriteFailure },
    );
    expect(onWriteFailure).not.toHaveBeenCalled();
  });
});

