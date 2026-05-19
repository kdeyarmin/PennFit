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
//
// Note on the mock shape: after migration 0116 logAudit reads the
// current chain tip before inserting, so the stub builder fakes
// BOTH the `from().select().not().order().limit().maybeSingle()`
// read and the `from().insert()` write. The fluent chain returns
// itself at every step so any call order resolves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: vi.fn(),
}));

const { getSupabaseServiceRoleClient } = await import("@workspace/resupply-db");
const { logAuditBestEffort, registerAuditHmacKeyForTesting } = await import(
  "./index"
);

type InsertResult = { error: unknown };
type LatestRow = { chain_seq: number; signature: string } | null;

function makeSupabaseStub({
  insert,
  latest = null,
}: {
  insert: (row: Record<string, unknown>) => Promise<InsertResult>;
  latest?: LatestRow;
}) {
  const readChain = {
    select: () => readChain,
    not: () => readChain,
    order: () => readChain,
    limit: () => readChain,
    maybeSingle: async () => ({ data: latest, error: null }),
  };
  const writeChain = { insert };
  return {
    schema: () => ({
      from: () => ({
        ...readChain,
        ...writeChain,
      }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>;
}

describe("logAuditBestEffort", () => {
  beforeEach(() => {
    vi.mocked(getSupabaseServiceRoleClient).mockReset();
    // Deterministic 32-byte key so the chain insert path doesn't
    // throw on missing env. Tests don't verify signatures here —
    // that's `sign.test.ts`'s job.
    registerAuditHmacKeyForTesting(Buffer.alloc(32, 0x11));
  });
  afterEach(() => {
    vi.clearAllMocks();
    registerAuditHmacKeyForTesting(null);
  });

  it("returns true on a successful write", async () => {
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
      makeSupabaseStub({ insert: async () => ({ error: null }) }),
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
      makeSupabaseStub({ insert: async () => ({ error: null }) }),
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
      makeSupabaseStub({ insert: async () => ({ error: dbErr }) }),
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
      makeSupabaseStub({ insert: async () => ({ error: new Error("transient") }) }),
    );
    const ok = await logAuditBestEffort(
      { action: "test.audit" },
      { contextLabel: "no-hook" },
    );
    // Returns false on swallow even when no hook is registered.
    expect(ok).toBe(false);
  });

  it("starts the chain at seq 1 when the table is empty", async () => {
    const insert = vi.fn<(row: Record<string, unknown>) => Promise<InsertResult>>(
      async () => ({ error: null }),
    );
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
      makeSupabaseStub({ insert, latest: null }),
    );
    await logAuditBestEffort(
      { action: "test.genesis" },
      { contextLabel: "genesis" },
    );
    expect(insert).toHaveBeenCalledOnce();
    const row = insert.mock.calls[0]![0] as {
      chain_seq: number;
      prev_signature: string | null;
      signature: string;
    };
    expect(row.chain_seq).toBe(1);
    expect(row.prev_signature).toBeNull();
    expect(typeof row.signature).toBe("string");
    expect(row.signature.length).toBeGreaterThan(0);
  });

  it("advances chain_seq from the latest row when one exists", async () => {
    const insert = vi.fn<(row: Record<string, unknown>) => Promise<InsertResult>>(
      async () => ({ error: null }),
    );
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
      makeSupabaseStub({
        insert,
        latest: { chain_seq: 42, signature: "prev-sig-base64" },
      }),
    );
    await logAuditBestEffort(
      { action: "test.next" },
      { contextLabel: "next" },
    );
    const row = insert.mock.calls[0]![0] as {
      chain_seq: number;
      prev_signature: string | null;
    };
    expect(row.chain_seq).toBe(43);
    expect(row.prev_signature).toBe("prev-sig-base64");
  });

  it("retries on chain_seq unique-violation and succeeds on a later attempt", async () => {
    // First two inserts return 23505 (chain_seq collision). The
    // third returns success. The chain loop should call insert
    // three times and resolve to true.
    const insert = vi.fn<(row: Record<string, unknown>) => Promise<InsertResult>>(
      async () => ({ error: null }),
    );
    insert
      .mockResolvedValueOnce({ error: { code: "23505" } })
      .mockResolvedValueOnce({ error: { code: "23505" } })
      .mockResolvedValueOnce({ error: null });
    vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
      makeSupabaseStub({ insert, latest: null }),
    );
    const ok = await logAuditBestEffort(
      { action: "test.contention" },
      { contextLabel: "contention" },
    );
    expect(ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(3);
  });

  it("throws when the audit HMAC key is unregistered and env is unset", async () => {
    registerAuditHmacKeyForTesting(null);
    const prior = process.env.RESUPPLY_AUDIT_HMAC_KEY;
    delete process.env.RESUPPLY_AUDIT_HMAC_KEY;
    try {
      vi.mocked(getSupabaseServiceRoleClient).mockReturnValue(
        makeSupabaseStub({ insert: async () => ({ error: null }) }),
      );
      // logAudit (called via best-effort) throws synchronously on missing
      // key. best-effort treats only Postgres errors as swallow-eligible;
      // a missing-key error is a programmer/deploy bug, so it surfaces.
      await expect(
        logAuditBestEffort(
          { action: "test.no-key" },
          { contextLabel: "no-key" },
        ),
      ).rejects.toThrow(/RESUPPLY_AUDIT_HMAC_KEY/);
    } finally {
      if (prior !== undefined) process.env.RESUPPLY_AUDIT_HMAC_KEY = prior;
    }
  });
});
