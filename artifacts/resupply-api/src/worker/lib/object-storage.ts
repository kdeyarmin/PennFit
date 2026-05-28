// Worker-side storage shim for the prescription-attachment PHI sweep.
//
// Why duplicated, not shared
// --------------------------
// The full ObjectStorageService lives in
// `artifacts/resupply-api/src/lib/object-storage/objectStorage.ts`
// and is bound to the api artifact (the worker can't import across
// artifact boundaries). The api version pulls in ACL helpers, signed-
// URL minting, range-aware download streaming, and the entity-path
// normalizer — none of which the sweep job needs. Hoisting all of
// that into a new `lib/resupply-object-storage` would cost a
// non-trivial refactor for one new caller, so we mirror only the
// list / delete / parse-key surface the sweep actually uses. If a
// THIRD caller ever needs object-storage access, that's the cue to
// promote this module + the api one into a shared lib.
//
// History: this module used to talk to GCS via the Replit sidecar
// (token exchange at http://127.0.0.1:1106). On Railway we use
// Supabase Storage through the same service-role client used
// elsewhere in the codebase.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

export interface AttachmentObject {
  /** Supabase bucket name (from SUPABASE_STORAGE_BUCKET_PRIVATE). */
  bucketName: string;
  /** Full object path within the bucket (e.g. `uploads/<uuid>`). */
  objectName: string;
  /** Created-at parsed to a Date. Null when Supabase omitted it. */
  timeCreated: Date | null;
  /** Object size in bytes. Null when Supabase omitted it. */
  size: number | null;
}

/**
 * Read SUPABASE_STORAGE_BUCKET_PRIVATE. Throws if unset — the worker
 * surfaces this as a fatal at boot rather than silently no-op the
 * sweep job for the lifetime of the deploy.
 */
export function getPrivateStorageBucket(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const bucket = (env.SUPABASE_STORAGE_BUCKET_PRIVATE ?? "").trim();
  if (!bucket) {
    throw new Error(
      "SUPABASE_STORAGE_BUCKET_PRIVATE not set. The PHI attachment " +
        "sweep cannot run without a private object bucket configured.",
    );
  }
  return bucket;
}

/**
 * Paginated list of every object under `uploads/` in the private
 * bucket. Supabase Storage's `list()` caps at 100 by default; we
 * iterate explicitly so callers get the complete set.
 */
export async function listAttachmentObjects(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttachmentObject[]> {
  const bucketName = getPrivateStorageBucket(env);
  const supabase = getSupabaseServiceRoleClient();
  const out: AttachmentObject[] = [];
  const pageSize = 100;
  let offset = 0;
  // Hard ceiling — guards against accidental unbounded listing if the
  // bucket grows past expectations. Production scale is sub-10k.
  const maxPages = 1000;
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list("uploads", { limit: pageSize, offset });
    if (error) {
      throw new Error(
        `Failed to list ${bucketName}/uploads: ${error.message}`,
      );
    }
    if (!data || data.length === 0) break;
    for (const entry of data) {
      if (!entry.name || entry.id === null) continue;
      const createdAt = entry.created_at ? new Date(entry.created_at) : null;
      const sizeRaw =
        (entry.metadata as { size?: number | string } | null)?.size ?? null;
      let size: number | null = null;
      if (typeof sizeRaw === "string") {
        const n = Number.parseInt(sizeRaw, 10);
        if (Number.isFinite(n) && n >= 0) size = n;
      } else if (typeof sizeRaw === "number" && Number.isFinite(sizeRaw)) {
        size = sizeRaw;
      }
      out.push({
        bucketName,
        objectName: `uploads/${entry.name}`,
        timeCreated:
          createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
        size,
      });
    }
    if (data.length < pageSize) break;
    offset += data.length;
  }
  return out;
}

/**
 * Delete one object from the private bucket. Throws on failure
 * (caller decides whether a vanished-mid-sweep object is benign).
 */
export async function deleteAttachmentObject(
  bucketName: string,
  objectName: string,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase.storage
    .from(bucketName)
    .remove([objectName]);
  if (error) {
    throw new Error(
      `Failed to delete ${bucketName}/${objectName}: ${error.message}`,
    );
  }
}

/**
 * Translate a bucket-listed object name (e.g. `uploads/<uuid>`) into
 * the `/objects/uploads/<uuid>` form the
 * `prescriptions.attachment_object_key` column stores. Returns null if
 * the object doesn't sit under the expected `uploads/` prefix.
 */
export function attachmentKeyForObjectName(objectName: string): string | null {
  if (!objectName.startsWith("uploads/")) return null;
  const tail = objectName.slice("uploads/".length);
  if (!tail) return null;
  return `/objects/uploads/${tail}`;
}
