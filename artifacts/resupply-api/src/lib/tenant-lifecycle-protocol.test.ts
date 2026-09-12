import { describe, expect, it } from "vitest";
import {
  tenantLifecycleDomain as domain,
  tenantLifecycleOperation,
  tenantLifecyclePreview,
  projectTenantLifecycleResult,
} from "./tenant-lifecycle-protocol";

const requestId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const targetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const revision = "a".repeat(64),
  digest = "b".repeat(64);
function request() {
  return tenantLifecycleOperation.parse({
    domain,
    operation: "preview",
    requestId,
    targetId,
    action: "organizations.setSuspension",
    parameters: { suspended: true },
    expectedRevision: revision,
    reason: "Suspend this reviewed tenant",
  });
}
function preview() {
  return {
    commandId,
    requestId,
    targetId,
    action: "organizations.setSuspension",
    parameters: { suspended: true },
    reason: "Suspend this reviewed tenant",
    createdAt: "2026-09-11T12:00:00Z",
    expiresAt: "2026-09-11T12:05:00Z",
    previewDigest: digest,
    before: {
      id: targetId,
      slug: "example-dme",
      name: null,
      status: "active",
      updatedAt: null,
      seedProtected: false,
      revision,
    },
    after: { status: "suspended" },
    canApplyThisSession: true,
    result: null,
  };
}
describe("closed tenant lifecycle review", () => {
  it("keeps nullable legacy metadata and matches the exact requested row revision", () => {
    expect(projectTenantLifecycleResult(preview(), request())).toMatchObject({
      before: { name: null, updatedAt: null, revision },
    });
    expect(() =>
      projectTenantLifecycleResult(
        {
          ...preview(),
          before: { ...preview().before, revision: "c".repeat(64) },
        },
        request(),
      ),
    ).toThrow();
  });
  it.each([
    {
      operation: "preview",
      parameters: { suspended: true, billingState: "canceled" },
    },
    { operation: "preview", targetId: "not-a-uuid" },
    { operation: "preview", reason: "includes\ncontrol" },
    { operation: "preview", reason: " padded reason " },
    { operation: "archive" },
    { domain: "unreviewed.domain" },
  ])("rejects unsupported request fields or operations %j", (patch) => {
    expect(
      tenantLifecycleOperation.safeParse({ ...request(), ...patch }).success,
    ).toBe(false);
  });
  it("rejects raw private metadata and forged actions in returned targets", () => {
    expect(
      tenantLifecyclePreview.safeParse({
        ...preview(),
        before: { ...preview().before, patientEmail: "hidden@example.test" },
      }).success,
    ).toBe(false);
    expect(
      tenantLifecyclePreview.safeParse({
        ...preview(),
        action: "billing.cancel",
      }).success,
    ).toBe(false);
  });
  it("does not accept seed suspension, archived reactivation, no-ops or mismatched result state", () => {
    expect(
      tenantLifecyclePreview.safeParse({
        ...preview(),
        before: { ...preview().before, seedProtected: true },
      }).success,
    ).toBe(false);
    expect(
      tenantLifecyclePreview.safeParse({
        ...preview(),
        before: { ...preview().before, status: "archived" },
      }).success,
    ).toBe(false);
    expect(
      tenantLifecyclePreview.safeParse({
        ...preview(),
        after: { status: "active" },
      }).success,
    ).toBe(false);
  });
  it("recovers an expired review by the original request ID without offering apply", () => {
    const saved = { ...preview(), canApplyThisSession: false };
    expect(
      projectTenantLifecycleResult(
        saved,
        tenantLifecycleOperation.parse({
          domain,
          operation: "resume",
          requestId,
        }),
      ),
    ).toEqual(saved);
    expect(() =>
      projectTenantLifecycleResult(
        saved,
        tenantLifecycleOperation.parse({
          domain,
          operation: "apply",
          commandId,
          expectedDigest: digest,
        }),
      ),
    ).toThrow();
    expect(() =>
      projectTenantLifecycleResult(
        saved,
        tenantLifecycleOperation.parse({
          domain,
          operation: "resume",
          requestId: commandId,
        }),
      ),
    ).toThrow();
  });
  it("accepts only an immutable receipt for the exact applied command and transition", () => {
    const result = {
      commandId,
      requestId,
      targetId,
      action: "organizations.setSuspension",
      beforeStatus: "active",
      afterStatus: "suspended",
      appliedAt: "2026-09-11T12:03:00Z",
      revision: "d".repeat(64),
    };
    const saved = { ...preview(), canApplyThisSession: false, result };
    const operation = tenantLifecycleOperation.parse({
      domain,
      operation: "apply",
      commandId,
      expectedDigest: digest,
    });
    expect(projectTenantLifecycleResult(saved, operation)).toEqual(saved);
    expect(() =>
      projectTenantLifecycleResult(
        { ...saved, result: { ...result, targetId: requestId } },
        operation,
      ),
    ).toThrow();
    expect(() =>
      projectTenantLifecycleResult(
        { ...saved, canApplyThisSession: true },
        operation,
      ),
    ).toThrow();
    expect(() =>
      projectTenantLifecycleResult(
        { ...saved, previewDigest: revision },
        operation,
      ),
    ).toThrow();
  });
});
