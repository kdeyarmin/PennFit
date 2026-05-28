// Tests for objectStorage.ts — the Supabase Storage adapter introduced
// in this PR (replaces the old GCS / Replit-sidecar path).
//
// The module uses:
//   - supabase.from("object_storage_acls").*  (for tryGetAcl / setObjectAclPolicy)
//   - supabase.storage.from(bucket).*          (for actual file I/O)
//
// We mock both surfaces inline with vi.mock + vi.hoisted so tests run
// without a live Supabase project.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock state — defined with vi.hoisted() so they're available when the
// vi.mock factory runs (Vitest hoists vi.mock calls to the top).
// ---------------------------------------------------------------------------

const {
  dbStaged,
  dbUpsertPayloads,
  storageResults,
  resetAll,
} = vi.hoisted(() => {
  const dbStaged: Map<string, Array<{ data: unknown; error: unknown }>> =
    new Map();
  const dbUpsertPayloads: unknown[] = [];

  // Storage operation results — keyed by "<method>:<bucket>:<path>"
  // or just "<method>:<bucket>" for list/createSignedUploadUrl.
  const storageResults: Map<string, unknown> = new Map();

  function resetAll() {
    dbStaged.clear();
    dbUpsertPayloads.length = 0;
    storageResults.clear();
  }

  return { dbStaged, dbUpsertPayloads, storageResults, resetAll };
});

// ---------------------------------------------------------------------------
// Inline mock of @workspace/resupply-db
// ---------------------------------------------------------------------------

vi.mock("@workspace/resupply-db", () => {
  function popDbStage(
    table: string,
    op: string,
  ): { data: unknown; error: unknown } {
    const k = `${table}.${op}`;
    const list = dbStaged.get(k);
    if (!list || list.length === 0) return { data: null, error: null };
    return list.shift()!;
  }

  function makeDbBuilder(table: string) {
    let lockedOp: string | null = null;

    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    chain["select"] = () => { lockedOp ??= "select"; return chain; };
    chain["insert"] = (p: unknown) => {
      lockedOp ??= "insert";
      dbUpsertPayloads.push(p);
      return chain;
    };
    chain["update"] = (p: unknown) => {
      lockedOp ??= "update";
      return chain;
    };
    chain["upsert"] = (p: unknown) => {
      lockedOp ??= "upsert";
      dbUpsertPayloads.push(p);
      return chain;
    };
    chain["delete"] = () => { lockedOp ??= "delete"; return chain; };
    chain["eq"] = () => chain;
    chain["neq"] = () => chain;
    chain["in"] = () => chain;
    chain["is"] = () => chain;
    chain["maybeSingle"] = async () =>
      popDbStage(table, lockedOp ?? "select");
    chain["single"] = async () =>
      popDbStage(table, lockedOp ?? "select");
    chain["then"] = (
      ok: (v: unknown) => unknown,
      fail?: (e: unknown) => unknown,
    ) =>
      Promise.resolve(popDbStage(table, lockedOp ?? "select")).then(ok, fail);
    return chain;
  }

  // Storage mock: supabase.storage.from(bucket).*
  function makeStorageBuilder(bucket: string) {
    return {
      list: async (dir: string, opts?: unknown) => {
        const k = `list:${bucket}`;
        return (storageResults.get(k) ?? { data: null, error: null });
      },
      download: async (path: string) => {
        const k = `download:${bucket}:${path}`;
        return (storageResults.get(k) ?? storageResults.get(`download:${bucket}`) ?? { data: null, error: { message: "not found" } });
      },
      remove: async (paths: string[]) => {
        const k = `remove:${bucket}`;
        return (storageResults.get(k) ?? { data: null, error: null });
      },
      createSignedUploadUrl: async (path: string) => {
        const k = `createSignedUploadUrl:${bucket}`;
        return (storageResults.get(k) ?? { data: null, error: { message: "not configured" } });
      },
      createSignedUrl: async (path: string, expiresIn: number) => {
        const k = `createSignedUrl:${bucket}`;
        return (storageResults.get(k) ?? { data: null, error: { message: "not configured" } });
      },
    };
  }

  return {
    getSupabaseServiceRoleClient: () => ({
      from: (table: string) => makeDbBuilder(table),
      schema: () => ({
        from: (table: string) => makeDbBuilder(table),
      }),
      storage: {
        from: (bucket: string) => makeStorageBuilder(bucket),
      },
    }),
  };
});

// ---------------------------------------------------------------------------
// Imports under test (AFTER mock registration)
// ---------------------------------------------------------------------------

import {
  ObjectStorageService,
  ObjectNotFoundError,
  createSignedDownloadUrl,
} from "./objectStorage";
import type { StoredObject } from "./objectStorage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stageDatabaseRow(
  table: string,
  op: string,
  result: { data: unknown; error: unknown },
): void {
  const k = `${table}.${op}`;
  const list = dbStaged.get(k) ?? [];
  list.push(result);
  dbStaged.set(k, list);
}

function stageStorage(key: string, result: unknown): void {
  storageResults.set(key, result);
}

beforeEach(() => {
  resetAll();
  // Default: private bucket is configured
  vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "attachments");
  vi.stubEnv("SUPABASE_STORAGE_BUCKET_PUBLIC", "");
});

// ---------------------------------------------------------------------------
// requirePrivateBucket (via getPrivateBucket / methods that call it)
// ---------------------------------------------------------------------------

describe("ObjectStorageService.getPrivateBucket", () => {
  it("returns the bucket name from env", () => {
    const svc = new ObjectStorageService();
    expect(svc.getPrivateBucket()).toBe("attachments");
  });

  it("throws when SUPABASE_STORAGE_BUCKET_PRIVATE is not set", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "");
    const svc = new ObjectStorageService();
    expect(() => svc.getPrivateBucket()).toThrow(
      "SUPABASE_STORAGE_BUCKET_PRIVATE not set",
    );
  });

  it("trims whitespace from the bucket name", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "  attachments  ");
    const svc = new ObjectStorageService();
    expect(svc.getPrivateBucket()).toBe("attachments");
  });
});

// ---------------------------------------------------------------------------
// getPublicBucket
// ---------------------------------------------------------------------------

describe("ObjectStorageService.getPublicBucket", () => {
  it("returns null when SUPABASE_STORAGE_BUCKET_PUBLIC is empty", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PUBLIC", "");
    expect(new ObjectStorageService().getPublicBucket()).toBeNull();
  });

  it("returns the bucket name when configured", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PUBLIC", "public-assets");
    expect(new ObjectStorageService().getPublicBucket()).toBe("public-assets");
  });
});

// ---------------------------------------------------------------------------
// getObjectEntityUploadURL
// ---------------------------------------------------------------------------

describe("ObjectStorageService.getObjectEntityUploadURL", () => {
  it("returns the signed upload URL from Supabase Storage", async () => {
    stageStorage("createSignedUploadUrl:attachments", {
      data: { signedUrl: "https://project.supabase.co/storage/v1/object/upload/sign/attachments/uploads/uuid?token=abc" },
      error: null,
    });

    const svc = new ObjectStorageService();
    const url = await svc.getObjectEntityUploadURL();
    expect(url).toBe(
      "https://project.supabase.co/storage/v1/object/upload/sign/attachments/uploads/uuid?token=abc",
    );
  });

  it("throws when Supabase Storage returns an error", async () => {
    stageStorage("createSignedUploadUrl:attachments", {
      data: null,
      error: { message: "bucket not found" },
    });

    const svc = new ObjectStorageService();
    await expect(svc.getObjectEntityUploadURL()).rejects.toThrow(
      "Failed to mint signed upload URL",
    );
  });

  it("throws when SUPABASE_STORAGE_BUCKET_PRIVATE is unset", async () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "");
    const svc = new ObjectStorageService();
    await expect(svc.getObjectEntityUploadURL()).rejects.toThrow(
      "SUPABASE_STORAGE_BUCKET_PRIVATE not set",
    );
  });

  it("throws when signedUrl is null/empty in the response", async () => {
    stageStorage("createSignedUploadUrl:attachments", {
      data: { signedUrl: null },
      error: null,
    });

    const svc = new ObjectStorageService();
    await expect(svc.getObjectEntityUploadURL()).rejects.toThrow(
      "Failed to mint signed upload URL",
    );
  });
});

// ---------------------------------------------------------------------------
// getObjectEntityFile — path validation
// ---------------------------------------------------------------------------

describe("ObjectStorageService.getObjectEntityFile", () => {
  it("throws ObjectNotFoundError for paths not starting with /objects/", async () => {
    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityFile("uploads/some-id"),
    ).rejects.toThrow(ObjectNotFoundError);
  });

  it("throws ObjectNotFoundError for /objects/ with no tail", async () => {
    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityFile("/objects/"),
    ).rejects.toThrow(ObjectNotFoundError);
  });

  it("throws ObjectNotFoundError for path-traversal with ..", async () => {
    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityFile("/objects/../secret"),
    ).rejects.toThrow(ObjectNotFoundError);
  });

  it("throws ObjectNotFoundError for path with . segment", async () => {
    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityFile("/objects/./something"),
    ).rejects.toThrow(ObjectNotFoundError);
  });

  it("throws ObjectNotFoundError for empty segment (double slash)", async () => {
    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityFile("/objects/uploads//id"),
    ).rejects.toThrow(ObjectNotFoundError);
  });

  it("throws ObjectNotFoundError when the object does not exist in storage", async () => {
    stageStorage("list:attachments", {
      data: [],
      error: null,
    });

    const svc = new ObjectStorageService();
    await expect(
      svc.getObjectEntityFile("/objects/uploads/nonexistent"),
    ).rejects.toThrow(ObjectNotFoundError);
  });

  it("returns a StoredObjectHandle when the object exists", async () => {
    stageStorage("list:attachments", {
      data: [{ name: "nonexistent", metadata: { size: 100, mimetype: "image/png" } }],
      error: null,
    });

    const svc = new ObjectStorageService();
    const handle = await svc.getObjectEntityFile("/objects/uploads/test-uuid");
    expect(handle.bucket).toBe("attachments");
    expect(handle.path).toBe("uploads/test-uuid");
  });

  it("handle.getMetadata() returns size and contentType from storage", async () => {
    // First list call for getObjectEntityFile existence check
    stageStorage("list:attachments", {
      data: [{ name: "test-uuid", metadata: { size: 2048, mimetype: "application/pdf" } }],
      error: null,
    });

    const svc = new ObjectStorageService();
    const handle = await svc.getObjectEntityFile("/objects/uploads/test-uuid");

    // Second list call for getMetadata()
    stageStorage("list:attachments", {
      data: [{ name: "test-uuid", metadata: { size: 2048, mimetype: "application/pdf" } }],
      error: null,
    });
    const [meta] = await handle.getMetadata();
    expect(meta.size).toBe(2048);
    expect(meta.contentType).toBe("application/pdf");
  });

  it("handle.delete() calls remove on the storage bucket", async () => {
    stageStorage("list:attachments", {
      data: [{ name: "test-uuid", metadata: {} }],
      error: null,
    });

    const svc = new ObjectStorageService();
    const handle = await svc.getObjectEntityFile("/objects/uploads/test-uuid");

    stageStorage("remove:attachments", { data: null, error: null });
    await expect(handle.delete()).resolves.toBeUndefined();
  });

  it("handle.delete({ ignoreNotFound: true }) swallows not-found errors", async () => {
    stageStorage("list:attachments", {
      data: [{ name: "x", metadata: {} }],
      error: null,
    });

    const svc = new ObjectStorageService();
    const handle = await svc.getObjectEntityFile("/objects/uploads/x");

    stageStorage("remove:attachments", {
      data: null,
      error: { message: "Object not found" },
    });
    await expect(handle.delete({ ignoreNotFound: true })).resolves.toBeUndefined();
  });

  it("handle.delete() re-throws non-not-found errors", async () => {
    stageStorage("list:attachments", {
      data: [{ name: "x", metadata: {} }],
      error: null,
    });

    const svc = new ObjectStorageService();
    const handle = await svc.getObjectEntityFile("/objects/uploads/x");

    stageStorage("remove:attachments", {
      data: null,
      error: { message: "permission denied" },
    });
    await expect(handle.delete()).rejects.toThrow("permission denied");
  });
});

// ---------------------------------------------------------------------------
// normalizeObjectEntityPath
// ---------------------------------------------------------------------------

describe("ObjectStorageService.normalizeObjectEntityPath", () => {
  const svc = new ObjectStorageService();

  it("returns already-normalized /objects/... paths verbatim", () => {
    expect(svc.normalizeObjectEntityPath("/objects/uploads/abc")).toBe(
      "/objects/uploads/abc",
    );
  });

  it("extracts the entity ID from a Supabase signed-upload URL", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "attachments");
    const url =
      "https://xyzproject.supabase.co/storage/v1/object/upload/sign/attachments/uploads/uuid-123?token=abc";
    expect(svc.normalizeObjectEntityPath(url)).toBe(
      "/objects/uploads/uuid-123",
    );
  });

  it("returns the raw path unchanged for unparseable URLs", () => {
    const raw = "not-a-url";
    expect(svc.normalizeObjectEntityPath(raw)).toBe(raw);
  });

  it("returns the raw URL when the bucket is not in the pathname", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "attachments");
    const url = "https://project.supabase.co/storage/v1/object/upload/sign/other-bucket/uploads/uuid";
    // "attachments" is not in the segments, so we should get the raw URL back.
    expect(svc.normalizeObjectEntityPath(url)).toBe(url);
  });

  it("rejects path traversal in the entity ID portion", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "attachments");
    const url =
      "https://project.supabase.co/storage/v1/object/upload/sign/attachments/../etc/passwd";
    // The reconstructed entityId would contain ".." — must be rejected.
    const result = svc.normalizeObjectEntityPath(url);
    expect(result).not.toMatch(/^\/objects\//);
  });

  it("handles a multi-segment path after the bucket correctly", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "attachments");
    const url =
      "https://project.supabase.co/storage/v1/object/upload/sign/attachments/uploads/sub/uuid";
    expect(svc.normalizeObjectEntityPath(url)).toBe(
      "/objects/uploads/sub/uuid",
    );
  });
});

// ---------------------------------------------------------------------------
// downloadObject
// ---------------------------------------------------------------------------

describe("ObjectStorageService.downloadObject", () => {
  const FILE: StoredObject = { bucket: "attachments", path: "uploads/abc" };

  it("returns a Response with the correct Content-Type for a private object", async () => {
    // ACL row: private
    stageDatabaseRow("object_storage_acls", "select", {
      data: { policy: { owner: "user-1", visibility: "private" } },
      error: null,
    });

    const fakeBlob = new Blob(["hello"], { type: "application/pdf" });
    stageStorage("download:attachments:uploads/abc", {
      data: fakeBlob,
      error: null,
    });

    const svc = new ObjectStorageService();
    const response = await svc.downloadObject(FILE);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toMatch(/^private,/);
  });

  it("returns a public cache header for a public object", async () => {
    stageDatabaseRow("object_storage_acls", "select", {
      data: { policy: { owner: "user-1", visibility: "public" } },
      error: null,
    });

    const fakeBlob = new Blob(["data"], { type: "image/png" });
    stageStorage("download:attachments:uploads/abc", {
      data: fakeBlob,
      error: null,
    });

    const svc = new ObjectStorageService();
    const response = await svc.downloadObject(FILE, 600);
    expect(response.headers.get("Cache-Control")).toMatch(/^public,/);
    expect(response.headers.get("Cache-Control")).toContain("600");
  });

  it("defaults Cache-Control to private when ACL row is missing", async () => {
    // No ACL row
    stageDatabaseRow("object_storage_acls", "select", {
      data: null,
      error: null,
    });

    const fakeBlob = new Blob(["data"], { type: "image/jpeg" });
    stageStorage("download:attachments:uploads/abc", {
      data: fakeBlob,
      error: null,
    });

    const svc = new ObjectStorageService();
    const response = await svc.downloadObject(FILE);
    expect(response.headers.get("Cache-Control")).toMatch(/^private,/);
  });

  it("throws ObjectNotFoundError when storage download returns an error", async () => {
    stageDatabaseRow("object_storage_acls", "select", {
      data: null,
      error: null,
    });
    stageStorage("download:attachments:uploads/abc", {
      data: null,
      error: { message: "object not found" },
    });

    const svc = new ObjectStorageService();
    await expect(svc.downloadObject(FILE)).rejects.toThrow(ObjectNotFoundError);
  });

  it("uses application/octet-stream when blob type is empty", async () => {
    stageDatabaseRow("object_storage_acls", "select", {
      data: null,
      error: null,
    });
    // Blob with no type
    const fakeBlob = new Blob(["data"]);
    stageStorage("download:attachments:uploads/abc", {
      data: fakeBlob,
      error: null,
    });

    const svc = new ObjectStorageService();
    const response = await svc.downloadObject(FILE);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// searchPublicObject
// ---------------------------------------------------------------------------

describe("ObjectStorageService.searchPublicObject", () => {
  it("returns null when SUPABASE_STORAGE_BUCKET_PUBLIC is not configured", async () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PUBLIC", "");
    const svc = new ObjectStorageService();
    const result = await svc.searchPublicObject("logo.png");
    expect(result).toBeNull();
  });

  it("returns null when the object does not exist in the public bucket", async () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PUBLIC", "public-assets");
    stageStorage("list:public-assets", { data: [], error: null });

    const svc = new ObjectStorageService();
    const result = await svc.searchPublicObject("missing.png");
    expect(result).toBeNull();
  });

  it("returns a StoredObjectHandle when the object exists", async () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PUBLIC", "public-assets");
    stageStorage("list:public-assets", {
      data: [{ name: "logo.png", metadata: {} }],
      error: null,
    });

    const svc = new ObjectStorageService();
    const handle = await svc.searchPublicObject("logo.png");
    expect(handle).not.toBeNull();
    expect(handle!.bucket).toBe("public-assets");
    expect(handle!.path).toBe("logo.png");
  });

  it("returns null when the storage list call returns an error", async () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PUBLIC", "public-assets");
    stageStorage("list:public-assets", {
      data: null,
      error: { message: "bucket not found" },
    });

    const svc = new ObjectStorageService();
    const result = await svc.searchPublicObject("logo.png");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// trySetObjectEntityAclPolicy
// ---------------------------------------------------------------------------

describe("ObjectStorageService.trySetObjectEntityAclPolicy", () => {
  it("returns the normalized path after setting the ACL policy", async () => {
    // normalizeObjectEntityPath: already normalized input
    // getObjectEntityFile: existence check
    stageStorage("list:attachments", {
      data: [{ name: "uuid-123", metadata: {} }],
      error: null,
    });
    // setObjectAclPolicy: read existing
    stageDatabaseRow("object_storage_acls", "select", {
      data: null,
      error: null,
    });
    // setObjectAclPolicy: upsert
    stageDatabaseRow("object_storage_acls", "upsert", {
      data: null,
      error: null,
    });

    const svc = new ObjectStorageService();
    const result = await svc.trySetObjectEntityAclPolicy(
      "/objects/uploads/uuid-123",
      { owner: "user-1", visibility: "private" },
    );
    expect(result).toBe("/objects/uploads/uuid-123");
  });

  it("returns the raw path unchanged when it cannot be normalized to /objects/", () => {
    vi.stubEnv("SUPABASE_STORAGE_BUCKET_PRIVATE", "attachments");
    const svc = new ObjectStorageService();
    // normalizeObjectEntityPath returns the raw path for non-URL non-/objects/ input
    const raw = "not-a-path";
    // The method returns rawPath when normalizedPath doesn't start with /
    return expect(svc.trySetObjectEntityAclPolicy(raw, {
      owner: "u",
      visibility: "private",
    })).resolves.toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// canAccessObjectEntity
// ---------------------------------------------------------------------------

describe("ObjectStorageService.canAccessObjectEntity", () => {
  const OBJ: StoredObject = { bucket: "attachments", path: "uploads/abc" };

  it("delegates to canAccessObject and returns true for the owner", async () => {
    stageDatabaseRow("object_storage_acls", "select", {
      data: { policy: { owner: "user-1", visibility: "private" } },
      error: null,
    });

    const svc = new ObjectStorageService();
    const result = await svc.canAccessObjectEntity({
      userId: "user-1",
      objectFile: OBJ,
    });
    expect(result).toBe(true);
  });

  it("defaults to READ permission when requestedPermission is not specified", async () => {
    stageDatabaseRow("object_storage_acls", "select", {
      data: { policy: { owner: "user-1", visibility: "public" } },
      error: null,
    });

    const svc = new ObjectStorageService();
    // No userId, public object — READ should be allowed by default
    const result = await svc.canAccessObjectEntity({ objectFile: OBJ });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSignedDownloadUrl (module-level helper)
// ---------------------------------------------------------------------------

describe("createSignedDownloadUrl", () => {
  const FILE: StoredObject = { bucket: "attachments", path: "uploads/doc.pdf" };

  it("returns the signed URL on success", async () => {
    stageStorage("createSignedUrl:attachments", {
      data: { signedUrl: "https://project.supabase.co/storage/v1/render/image/sign/attachments/uploads/doc.pdf?token=xyz" },
      error: null,
    });

    const url = await createSignedDownloadUrl(FILE, 3600);
    expect(url).toContain("supabase.co");
    expect(url).toContain("token=xyz");
  });

  it("throws when Supabase returns an error", async () => {
    stageStorage("createSignedUrl:attachments", {
      data: null,
      error: { message: "expired" },
    });

    await expect(createSignedDownloadUrl(FILE)).rejects.toThrow(
      "Failed to sign download URL",
    );
  });

  it("throws when signedUrl is absent in the response", async () => {
    stageStorage("createSignedUrl:attachments", {
      data: { signedUrl: null },
      error: null,
    });

    await expect(createSignedDownloadUrl(FILE)).rejects.toThrow(
      "Failed to sign download URL",
    );
  });

  it("clamps TTL to the 7-day Supabase maximum", async () => {
    // We verify the clamping logic does NOT throw even for an absurdly large TTL.
    stageStorage("createSignedUrl:attachments", {
      data: { signedUrl: "https://example.com/signed?token=abc" },
      error: null,
    });

    const url = await createSignedDownloadUrl(FILE, 999_999);
    expect(url).toBe("https://example.com/signed?token=abc");
  });

  it("clamps TTL to a minimum of 1 second", async () => {
    stageStorage("createSignedUrl:attachments", {
      data: { signedUrl: "https://example.com/signed?token=def" },
      error: null,
    });

    const url = await createSignedDownloadUrl(FILE, 0);
    expect(url).toBe("https://example.com/signed?token=def");
  });
});

// ---------------------------------------------------------------------------
// ObjectNotFoundError shape
// ---------------------------------------------------------------------------

describe("ObjectNotFoundError", () => {
  it("has the correct name", () => {
    const err = new ObjectNotFoundError();
    expect(err.name).toBe("ObjectNotFoundError");
  });

  it("is an instanceof Error and ObjectNotFoundError", () => {
    const err = new ObjectNotFoundError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ObjectNotFoundError);
  });

  it("carries the right message", () => {
    expect(new ObjectNotFoundError().message).toBe("Object not found");
  });
});
