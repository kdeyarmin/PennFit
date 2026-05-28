// Object storage adapter — Supabase Storage.
//
// History: this module used to talk to GCS through the Replit sidecar
// (token exchange at http://127.0.0.1:1106, signed URLs minted by the
// sidecar). On Railway we drop the sidecar dependency entirely and
// move to Supabase Storage, which we already authenticate against via
// the service-role client in `@workspace/resupply-db`.
//
// Public API surface is unchanged from the GCS-era version so callers
// (routes, message ingestion, fax ingestion, the PHI sweep job) keep
// using `ObjectStorageService` exactly as before:
//
//   getObjectEntityUploadURL()
//   getObjectEntityFile(objectPath)
//   downloadObject(file, ttl)
//   normalizeObjectEntityPath(rawPath)
//   trySetObjectEntityAclPolicy(rawPath, policy)
//
// Internally, "files" are now `StoredObject` (bucket+path) — no
// vendor-specific File type.
//
// Env contract:
//   SUPABASE_STORAGE_BUCKET_PRIVATE   (required)
//     Bucket name for private/PHI uploads (e.g. "attachments"). Every
//     "/objects/<entity>" path resolves into this bucket.
//   SUPABASE_STORAGE_BUCKET_PUBLIC    (optional)
//     Bucket name for the public asset path used by searchPublicObject.

import { randomUUID } from "crypto";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  ObjectAclPolicy,
  ObjectPermission,
  StoredObject,
  canAccessObject,
  setObjectAclPolicy,
} from "./objectAcl";

// Re-export so callers that import { StoredObject } from the storage
// barrel keep working when the type moves.
export type { StoredObject } from "./objectAcl";

// 7 days is the Supabase signed-URL cap.
const MAX_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

/**
 * Live handle returned by `ObjectStorageService.getObjectEntityFile`.
 * Exposes a small subset of methods that mirror the GCS `File` API
 * the codebase was previously written against, so existing callers
 * keep working. New code should prefer the dedicated
 * `ObjectStorageService.getObjectMetadata` / `.deleteObject` methods.
 */
export interface StoredObjectHandle extends StoredObject {
  /**
   * Returns a single-element tuple `[meta]` matching the shape the
   * GCS `File.getMetadata()` returned. Only the fields the codebase
   * actually reads (`size`, `contentType`) are populated.
   */
  getMetadata(): Promise<[{ size: number; contentType: string }]>;
  /**
   * Best-effort delete. `ignoreNotFound: true` was honored by GCS;
   * Supabase Storage's `remove` returns a result entry per path
   * regardless of whether the object existed, so we treat all
   * not-found shapes as a no-op.
   */
  delete(opts?: { ignoreNotFound?: boolean }): Promise<void>;
}

async function readObjectMetadata(
  obj: StoredObject,
): Promise<{ size: number; contentType: string }> {
  const supabase = getSupabaseServiceRoleClient();
  const slashIdx = obj.path.lastIndexOf("/");
  const dir = slashIdx >= 0 ? obj.path.slice(0, slashIdx) : "";
  const base = slashIdx >= 0 ? obj.path.slice(slashIdx + 1) : obj.path;
  const { data, error } = await supabase.storage
    .from(obj.bucket)
    .list(dir, { search: base, limit: 1 });
  if (error || !data?.length) {
    throw new ObjectNotFoundError();
  }
  const entry = data[0]!;
  const md = (entry.metadata as { size?: number | string; mimetype?: string } | null) ?? null;
  const sizeRaw = md?.size;
  let size = 0;
  if (typeof sizeRaw === "number" && Number.isFinite(sizeRaw)) {
    size = sizeRaw;
  } else if (typeof sizeRaw === "string") {
    const n = Number.parseInt(sizeRaw, 10);
    if (Number.isFinite(n) && n >= 0) size = n;
  }
  return {
    size,
    contentType: md?.mimetype ?? "application/octet-stream",
  };
}

async function deleteObject(
  obj: StoredObject,
  opts: { ignoreNotFound?: boolean } = {},
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase.storage
    .from(obj.bucket)
    .remove([obj.path]);
  if (error) {
    if (opts.ignoreNotFound && /not found|does not exist/i.test(error.message)) {
      return;
    }
    throw new Error(
      `Failed to delete ${obj.bucket}/${obj.path}: ${error.message}`,
    );
  }
}

function makeStoredObjectHandle(obj: StoredObject): StoredObjectHandle {
  return {
    bucket: obj.bucket,
    path: obj.path,
    getMetadata: async () => [await readObjectMetadata(obj)],
    delete: (opts) => deleteObject(obj, opts ?? {}),
  };
}

function requirePrivateBucket(): string {
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET_PRIVATE ?? "").trim();
  if (!bucket) {
    throw new Error(
      "SUPABASE_STORAGE_BUCKET_PRIVATE not set. Create a bucket in " +
        "Supabase Studio → Storage and set SUPABASE_STORAGE_BUCKET_PRIVATE " +
        "to its name.",
    );
  }
  return bucket;
}

function optionalPublicBucket(): string | null {
  const bucket = (process.env.SUPABASE_STORAGE_BUCKET_PUBLIC ?? "").trim();
  return bucket || null;
}

export class ObjectStorageService {
  constructor() {}

  /** Bucket name for private/PHI uploads. Throws when unset. */
  getPrivateBucket(): string {
    return requirePrivateBucket();
  }

  /** Bucket name for public assets. Null when not configured. */
  getPublicBucket(): string | null {
    return optionalPublicBucket();
  }

  /**
   * Locate a public-bucket object by relative path. Returns null when
   * the public bucket isn't configured or the object doesn't exist.
   */
  async searchPublicObject(
    filePath: string,
  ): Promise<StoredObjectHandle | null> {
    const bucket = optionalPublicBucket();
    if (!bucket) return null;
    const supabase = getSupabaseServiceRoleClient();
    const slashIdx = filePath.lastIndexOf("/");
    const dir = slashIdx >= 0 ? filePath.slice(0, slashIdx) : "";
    const base = slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(dir, { search: base, limit: 1 });
    if (error || !data?.length) return null;
    return makeStoredObjectHandle({ bucket, path: filePath });
  }

  /**
   * Stream the object back to the caller, wrapped in a Response with
   * the right Content-Type / Cache-Control / Content-Length headers.
   * The ACL controls whether the cache header is public or private.
   */
  async downloadObject(
    file: StoredObject,
    cacheTtlSec: number = 3600,
  ): Promise<Response> {
    const supabase = getSupabaseServiceRoleClient();
    const aclPolicy = await this.tryGetAcl(file);
    const isPublic = aclPolicy?.visibility === "public";

    const { data, error } = await supabase.storage
      .from(file.bucket)
      .download(file.path);
    if (error || !data) {
      throw new ObjectNotFoundError();
    }

    const contentType = data.type || "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (typeof data.size === "number") {
      headers["Content-Length"] = String(data.size);
    }

    return new Response(data.stream() as ReadableStream, { headers });
  }

  /**
   * Mint a short-lived signed URL the browser PUTs the upload to. The
   * caller is expected to follow this with `trySetObjectEntityAclPolicy`
   * so the object has an owner before any sibling lookup uses it.
   */
  async getObjectEntityUploadURL(): Promise<string> {
    const bucket = requirePrivateBucket();
    const supabase = getSupabaseServiceRoleClient();
    const objectId = randomUUID();
    const path = `uploads/${objectId}`;

    const { data, error } = await supabase.storage
      .from(bucket)
      .createSignedUploadUrl(path);
    if (error || !data?.signedUrl) {
      throw new Error(
        `Failed to mint signed upload URL for ${bucket}/${path}: ${error?.message ?? "unknown error"}`,
      );
    }
    return data.signedUrl;
  }

  /**
   * Resolve a stored object key (the `/objects/<id>` form the DB
   * persists) into a handle the rest of the API can pass around.
   * Throws ObjectNotFoundError when the path is malformed, contains
   * traversal segments, or doesn't exist in the private bucket.
   *
   * The returned `StoredObjectHandle` exposes `.getMetadata()` and
   * `.delete()` mirroring the GCS `File` shape; older callers stay
   * unchanged.
   */
  async getObjectEntityFile(objectPath: string): Promise<StoredObjectHandle> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }
    const tail = objectPath.slice("/objects/".length);
    if (!tail) {
      throw new ObjectNotFoundError();
    }
    // Reject path-traversal segments and empty path segments. Without
    // this a signed-in customer who submitted `/objects/../foo` would
    // otherwise read across into objects they don't own.
    const segments = tail.split("/");
    if (segments.some((p) => p === ".." || p === "." || p === "")) {
      throw new ObjectNotFoundError();
    }

    const bucket = requirePrivateBucket();

    // Existence check via list with a single-result search.
    const supabase = getSupabaseServiceRoleClient();
    const slashIdx = tail.lastIndexOf("/");
    const dir = slashIdx >= 0 ? tail.slice(0, slashIdx) : "";
    const base = slashIdx >= 0 ? tail.slice(slashIdx + 1) : tail;
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(dir, { search: base, limit: 1 });
    if (error || !data?.length) {
      throw new ObjectNotFoundError();
    }
    return makeStoredObjectHandle({ bucket, path: tail });
  }

  /**
   * Translate the raw signed-upload URL the browser used (which carries
   * the bucket + path inside the URL pathname) into the canonical
   * `/objects/<entityId>` form the DB stores.
   */
  normalizeObjectEntityPath(rawPath: string): string {
    // Accept already-normalized paths verbatim.
    if (rawPath.startsWith("/objects/")) {
      return rawPath;
    }

    // The Supabase signed-upload URL is shaped
    //   https://<project>.supabase.co/storage/v1/object/upload/sign/<bucket>/<path>?token=...
    // We only need the <path> after the bucket segment.
    let url: URL;
    try {
      url = new URL(rawPath);
    } catch {
      return rawPath;
    }

    const bucket = requirePrivateBucket();
    const segments = url.pathname.split("/").filter(Boolean);
    const bucketIdx = segments.lastIndexOf(bucket);
    if (bucketIdx < 0 || bucketIdx >= segments.length - 1) {
      return rawPath;
    }
    const entityId = segments.slice(bucketIdx + 1).join("/");
    if (entityId.split("/").some((p) => p === ".." || p === ".")) {
      return rawPath;
    }
    return `/objects/${entityId}`;
  }

  /**
   * Attach an ACL policy to the object identified by `rawPath` (either
   * the canonical `/objects/...` form or the upload URL).
   */
  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: StoredObject;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  /**
   * Internal helper used by `downloadObject` for cache-policy
   * selection. Swallows ACL-table errors so a missing ACL row falls
   * back to a private cache header rather than 500ing the download.
   */
  private async tryGetAcl(file: StoredObject): Promise<ObjectAclPolicy | null> {
    try {
      const supabase = getSupabaseServiceRoleClient();
      const { data } = await supabase
        .from("object_storage_acls")
        .select("policy")
        .eq("bucket", file.bucket)
        .eq("path", file.path)
        .maybeSingle();
      return (data?.policy as ObjectAclPolicy | undefined) ?? null;
    } catch {
      return null;
    }
  }
}

// Re-export so callers can `import { ObjectAclPolicy, ObjectPermission }
// from "../object-storage/objectStorage"`.
export type { ObjectAclPolicy } from "./objectAcl";
export { ObjectPermission } from "./objectAcl";

// Signed download URLs for direct browser-facing reads (used when we
// want the client to fetch the bytes directly from Supabase rather than
// streaming through this Node process).
export async function createSignedDownloadUrl(
  file: StoredObject,
  ttlSec: number = 900,
): Promise<string> {
  const supabase = getSupabaseServiceRoleClient();
  const expiresIn = Math.min(Math.max(1, ttlSec), MAX_SIGNED_URL_TTL_SECONDS);
  const { data, error } = await supabase.storage
    .from(file.bucket)
    .createSignedUrl(file.path, expiresIn);
  if (error || !data?.signedUrl) {
    throw new Error(
      `Failed to sign download URL for ${file.bucket}/${file.path}: ${error?.message ?? "unknown error"}`,
    );
  }
  return data.signedUrl;
}
