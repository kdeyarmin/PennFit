// Unit tests for logAuditBestEffort.
//
// We mock the Supabase service-role client so the helper can run in
// three scenarios:
//   1. Happy path: returns true.
//   2. Programmer error (PHI metadata): re-throws — these MUST NOT
//      be swallowed because the sanitizer gate is what protects us
//      from leaking PHI into a plaintext jsonb column.
//   3. Transient DB error (PostgREST returns `{ error }`): swallowed,
//      onWriteFailure called once with the categorized envelope,
//      returns false.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

const { getSupabaseServiceRoleClient } = await import("@workspace/resupply-db");
const { logAuditBestEffort } = await import("./index");

type InsertResult = { error: unknown };

function makeSupabaseStub(insert: () => Promise<InsertResult>) {
  return {
    schema: () => ({
      from: () => ({
        insert,
      }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>;
}

describe("logAuditBestEffort", () => {
  beforeEach(() => {
    vi.mocked(getSupabaseServiceRoleClient).mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns true on a successful write", async () => {
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
      makeSupabaseStub(async () => ({ error: null })),
    );
    const onWriteFailure = vi.fn();
    const ok = await logAuditBestEffort(
      {
        action: "test.audit",
        adminEmail: "ops@example.com",
        targetTable: "test",
        targetId: "123",
      },
      { contextLabel: "unit-test", onWriteFailure },
    );
    expect(ok).toBe(true);
    expect(onWriteFailure).not.toHaveBeenCalled();
  });

  it("re-throws sanitizer errors (PHI metadata is a programmer bug)", async () => {
    // We don't even need a working client here — the sanitizer rejects
    // before the insert is issued.
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
      makeSupabaseStub(async () => ({ error: null })),
    );
    const onWriteFailure = vi.fn();
    await expect(
      logAuditBestEffort(
        {
          action: "test.phi-leak",
          // `phone` is on the sanitizer's denylist.
          metadata: { phone: "+15551234567" },
        },
        { contextLabel: "unit-test", onWriteFailure },
      ),
    ).rejects.toMatchObject({ name: "AuditMetadataPhiError" });
    // Programmer-bug path must NOT call the failure hook — it's a
    // re-throw, not a swallow.
    expect(onWriteFailure).not.toHaveBeenCalled();
  });

  it("swallows DB failures and invokes onWriteFailure with the envelope", async () => {
    const dbErr = new Error("connection terminated");
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
      makeSupabaseStub(async () => ({ error: dbErr })),
    );
    const onWriteFailure = vi.fn();
    const ok = await logAuditBestEffort(
      { action: "test.audit", adminEmail: null },
      { contextLabel: "post_login", onWriteFailure },
    );
    expect(ok).toBe(false);
    expect(onWriteFailure).toHaveBeenCalledTimes(1);
    expect(onWriteFailure).toHaveBeenCalledWith({
      event: "audit_write_failed",
      contextLabel: "post_login",
      action: "test.audit",
      err: dbErr,
    });
  });

  it("works without an onWriteFailure callback", async () => {
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
      makeSupabaseStub(async () => ({ error: new Error("transient") })),
    );
    const ok = await logAuditBestEffort(
      { action: "test.audit" },
      { contextLabel: "no-hook" },
    );
    // Returns false on swallow even when no hook is registered.
    expect(ok).toBe(false);
  });
});
