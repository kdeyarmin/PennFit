// Tests for objectAcl.ts — the Supabase-backed object ACL layer
// introduced in this PR (replaces the old GCS custom-metadata path).
//
// The module calls `getSupabaseServiceRoleClient()` and chains
// `.from("object_storage_acls").*` on the result.  We mock the client
// inline with vi.hoisted() + vi.mock() so state is available when
// Vitest evaluates the hoisted mock factory.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state — hoisted so they're ready when vi.mock factory runs.
// ---------------------------------------------------------------------------

const { staged, upsertPayloads, resetMockState } = vi.hoisted(() => {
  const staged: Map<
    string,
    Array<{ data: unknown; error: unknown }>
  > = new Map();
  const upsertPayloads: unknown[] = [];

  function resetMockState() {
    staged.clear();
    upsertPayloads.length = 0;
  }

  return { staged, upsertPayloads, resetMockState };
});

// ---------------------------------------------------------------------------
// Inline Supabase mock
// ---------------------------------------------------------------------------

vi.mock("@workspace/resupply-db", () => {
  function popStage(
    table: string,
    op: string,
  ): { data: unknown; error: unknown } {
    const k = `${table}.${op}`;
    const list = staged.get(k);
    if (!list || list.length === 0) return { data: null, error: null };
    return list.shift()!;
  }

  function makeBuilder(table: string) {
    let lockedOp: string | null = null;

    const chain: Record<string, (...args: unknown[]) => unknown> = {};

    const resolve = () =>
      Promise.resolve(popStage(table, lockedOp ?? "select"));

    chain["select"] = () => {
      lockedOp ??= "select";
      return chain;
    };
    chain["insert"] = (p: unknown) => {
      lockedOp ??= "insert";
      upsertPayloads.push(p);
      return chain;
    };
    chain["update"] = (_p: unknown) => {
      lockedOp ??= "update";
      return chain;
    };
    chain["upsert"] = (p: unknown, _opts?: unknown) => {
      lockedOp ??= "upsert";
      upsertPayloads.push(p);
      return chain;
    };
    chain["delete"] = () => {
      lockedOp ??= "delete";
      return chain;
    };
    chain["eq"] = () => chain;
    chain["neq"] = () => chain;
    chain["in"] = () => chain;
    chain["is"] = () => chain;
    chain["order"] = () => chain;
    chain["limit"] = () => chain;
    chain["maybeSingle"] = () => resolve();
    chain["single"] = () => resolve();
    chain["then"] = (
      ok: (v: unknown) => unknown,
      fail?: (e: unknown) => unknown,
    ) => resolve().then(ok, fail);

    return chain;
  }

  return {
    getSupabaseServiceRoleClient: () => ({
      from: (table: string) => makeBuilder(table),
      schema: () => ({
        from: (table: string) => makeBuilder(table),
      }),
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports under test (AFTER mock registration)
// ---------------------------------------------------------------------------

import {
  setObjectAclPolicy,
  getObjectAclPolicy,
  canAccessObject,
  ObjectAlreadyOwnedError,
  ObjectPermission,
} from "./objectAcl";
import type { StoredObject, ObjectAclPolicy } from "./objectAcl";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function pushStage(
  table: string,
  op: string,
  result: { data: unknown; error: unknown },
): void {
  const k = `${table}.${op}`;
  const list = staged.get(k) ?? [];
  list.push(result);
  staged.set(k, list);
}

const OBJ: StoredObject = { bucket: "attachments", path: "uploads/abc-uuid" };

const POLICY: ObjectAclPolicy = {
  owner: "user-123",
  visibility: "private",
};

beforeEach(() => {
  resetMockState();
});

// ---------------------------------------------------------------------------
// setObjectAclPolicy
// ---------------------------------------------------------------------------

describe("setObjectAclPolicy", () => {
  it("writes an ACL row when the object has no prior owner", async () => {
    // Stage: no existing row
    pushStage("object_storage_acls", "select", { data: null, error: null });
    // Stage: upsert succeeds
    pushStage("object_storage_acls", "upsert", { data: null, error: null });

    await expect(setObjectAclPolicy(OBJ, POLICY)).resolves.toBeUndefined();
    expect(upsertPayloads).toHaveLength(1);
    const written = upsertPayloads[0] as Record<string, unknown>;
    expect(written).toMatchObject({
      bucket: "attachments",
      path: "uploads/abc-uuid",
      owner_id: "user-123",
      visibility: "private",
    });
    expect(written["policy"]).toMatchObject(POLICY);
  });

  it("allows the same owner to overwrite their own policy", async () => {
    // Existing row belongs to same owner
    pushStage("object_storage_acls", "select", {
      data: { owner_id: "user-123" },
      error: null,
    });
    pushStage("object_storage_acls", "upsert", { data: null, error: null });

    await expect(setObjectAclPolicy(OBJ, POLICY)).resolves.toBeUndefined();
  });

  it("throws ObjectAlreadyOwnedError when a different owner has claimed the object", async () => {
    // Existing row belongs to a DIFFERENT owner
    pushStage("object_storage_acls", "select", {
      data: { owner_id: "other-owner" },
      error: null,
    });

    await expect(
      setObjectAclPolicy(OBJ, { ...POLICY, owner: "user-123" }),
    ).rejects.toThrow(ObjectAlreadyOwnedError);
  });

  it("throws when the read for the existing row fails", async () => {
    pushStage("object_storage_acls", "select", {
      data: null,
      error: { message: "DB connection error" },
    });

    await expect(setObjectAclPolicy(OBJ, POLICY)).rejects.toThrow(
      "Failed to read existing ACL",
    );
  });

  it("throws when the upsert fails", async () => {
    // No existing owner
    pushStage("object_storage_acls", "select", { data: null, error: null });
    // Upsert error
    pushStage("object_storage_acls", "upsert", {
      data: null,
      error: { message: "upsert failed" },
    });

    await expect(setObjectAclPolicy(OBJ, POLICY)).rejects.toThrow(
      "Failed to write ACL",
    );
  });

  it("stores the correct policy JSONB and visibility", async () => {
    const publicPolicy: ObjectAclPolicy = {
      owner: "owner-abc",
      visibility: "public",
    };

    pushStage("object_storage_acls", "select", { data: null, error: null });
    pushStage("object_storage_acls", "upsert", { data: null, error: null });

    await setObjectAclPolicy(OBJ, publicPolicy);

    const written = upsertPayloads[0] as Record<string, unknown>;
    expect(written["visibility"]).toBe("public");
    expect((written["policy"] as ObjectAclPolicy).owner).toBe("owner-abc");
  });

  it("includes bucket and path in the read-error message", async () => {
    pushStage("object_storage_acls", "select", {
      data: null,
      error: { message: "timeout" },
    });

    await expect(setObjectAclPolicy(OBJ, POLICY)).rejects.toThrow(
      `${OBJ.bucket}/${OBJ.path}`,
    );
  });

  it("includes bucket and path in the write-error message", async () => {
    pushStage("object_storage_acls", "select", { data: null, error: null });
    pushStage("object_storage_acls", "upsert", {
      data: null,
      error: { message: "constraint violation" },
    });

    await expect(setObjectAclPolicy(OBJ, POLICY)).rejects.toThrow(
      `${OBJ.bucket}/${OBJ.path}`,
    );
  });
});

// ---------------------------------------------------------------------------
// getObjectAclPolicy
// ---------------------------------------------------------------------------

describe("getObjectAclPolicy", () => {
  it("returns the policy when a row exists", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: POLICY },
      error: null,
    });

    const result = await getObjectAclPolicy(OBJ);
    expect(result).toEqual(POLICY);
  });

  it("returns null when no row exists", async () => {
    pushStage("object_storage_acls", "select", {
      data: null,
      error: null,
    });

    const result = await getObjectAclPolicy(OBJ);
    expect(result).toBeNull();
  });

  it("returns null when the row exists but policy field is null", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: null },
      error: null,
    });

    const result = await getObjectAclPolicy(OBJ);
    expect(result).toBeNull();
  });

  it("throws when the Supabase query returns an error", async () => {
    pushStage("object_storage_acls", "select", {
      data: null,
      error: { message: "connection refused" },
    });

    await expect(getObjectAclPolicy(OBJ)).rejects.toThrow("Failed to read ACL");
  });

  it("includes bucket and path in the error message", async () => {
    pushStage("object_storage_acls", "select", {
      data: null,
      error: { message: "timeout" },
    });

    await expect(getObjectAclPolicy(OBJ)).rejects.toThrow(
      `${OBJ.bucket}/${OBJ.path}`,
    );
  });
});

// ---------------------------------------------------------------------------
// canAccessObject
// ---------------------------------------------------------------------------

describe("canAccessObject", () => {
  it("returns false when no ACL policy exists for the object", async () => {
    pushStage("object_storage_acls", "select", { data: null, error: null });

    const result = await canAccessObject({
      userId: "user-123",
      objectFile: OBJ,
      requestedPermission: ObjectPermission.READ,
    });
    expect(result).toBe(false);
  });

  it("allows public READ without a userId", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: { owner: "owner-abc", visibility: "public" } },
      error: null,
    });

    const result = await canAccessObject({
      objectFile: OBJ,
      requestedPermission: ObjectPermission.READ,
    });
    expect(result).toBe(true);
  });

  it("denies public WRITE even for a public object when no userId is provided", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: { owner: "owner-abc", visibility: "public" } },
      error: null,
    });

    const result = await canAccessObject({
      objectFile: OBJ,
      requestedPermission: ObjectPermission.WRITE,
    });
    expect(result).toBe(false);
  });

  it("allows READ for the object owner", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: { owner: "user-123", visibility: "private" } },
      error: null,
    });

    const result = await canAccessObject({
      userId: "user-123",
      objectFile: OBJ,
      requestedPermission: ObjectPermission.READ,
    });
    expect(result).toBe(true);
  });

  it("allows WRITE for the object owner", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: { owner: "user-123", visibility: "private" } },
      error: null,
    });

    const result = await canAccessObject({
      userId: "user-123",
      objectFile: OBJ,
      requestedPermission: ObjectPermission.WRITE,
    });
    expect(result).toBe(true);
  });

  it("denies READ for a non-owner with no ACL rules on a private object", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: { owner: "owner-abc", visibility: "private" } },
      error: null,
    });

    const result = await canAccessObject({
      userId: "stranger",
      objectFile: OBJ,
      requestedPermission: ObjectPermission.READ,
    });
    expect(result).toBe(false);
  });

  it("denies access when userId is absent for a private object", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: { owner: "owner-abc", visibility: "private" } },
      error: null,
    });

    const result = await canAccessObject({
      objectFile: OBJ,
      requestedPermission: ObjectPermission.READ,
    });
    expect(result).toBe(false);
  });

  it("denies WRITE to a non-owner even on a public object", async () => {
    pushStage("object_storage_acls", "select", {
      data: { policy: { owner: "owner-abc", visibility: "public" } },
      error: null,
    });

    const result = await canAccessObject({
      userId: "not-the-owner",
      objectFile: OBJ,
      requestedPermission: ObjectPermission.WRITE,
    });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ObjectAlreadyOwnedError shape
// ---------------------------------------------------------------------------

describe("ObjectAlreadyOwnedError", () => {
  it("has the correct name", () => {
    const err = new ObjectAlreadyOwnedError();
    expect(err.name).toBe("ObjectAlreadyOwnedError");
  });

  it("is an instanceof Error", () => {
    expect(new ObjectAlreadyOwnedError()).toBeInstanceOf(Error);
  });

  it("carries a descriptive message", () => {
    const err = new ObjectAlreadyOwnedError();
    expect(err.message).toMatch(/already claimed/i);
  });
});
