// Worker-side GCS shim for the prescription-attachment PHI sweep.
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
// What lives here
// ---------------
// - The same Replit-sidecar credentialed `Storage` client the api
//   uses (auth shape MUST stay in lockstep with the api version —
//   see `objectStorage.ts` lines 12-30).
// - `listAttachmentObjects()` — paginates the bucket under the
//   `<entity-dir>/uploads/` prefix where attachments land, returns
//   each object's name + creation timestamp.
// - `deleteAttachmentObject()` — best-effort delete; the sweep
//   handler decides whether a thrown error means "object vanished
//   between list and delete (fine)" or "real failure (count it)".
// - `attachmentKeyForObjectName()` — turns a bucket-listed object
//   path into the same `/objects/uploads/<uuid>` shape the
//   `prescriptions.attachment_object_key` column stores, so the
//   sweep's reference check is a Set lookup against the DB column
//   value rather than per-row SQL.

import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

/**
 * Sidecar-credentialed GCS client. Auth shape MUST stay in lockstep
 * with `artifacts/resupply-api/src/lib/object-storage/objectStorage.ts`
 * — both processes hit the same Replit object-storage sidecar.
 */
export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export interface AttachmentObject {
  /** Bucket name as parsed from PRIVATE_OBJECT_DIR. */
  bucketName: string;
  /** Full object name within the bucket (e.g. `replit-objstore-…/uploads/abc`). */
  objectName: string;
  /** GCS `timeCreated` parsed to a Date. Null when GCS omitted it. */
  timeCreated: Date | null;
  /** Object size in bytes, parsed from GCS metadata. Null when GCS
   *  omitted `size` (rare; the sweep handles it as "delete on schedule
   *  but contribute 0 to bytes_reclaimed"). */
  size: number | null;
}

/**
 * Read PRIVATE_OBJECT_DIR and split it into `<bucket>/<entity-prefix>`.
 * Mirrors the parser in the api version (`parseObjectPath`) but
 * specialised to PRIVATE_OBJECT_DIR's "/<bucket>/<rest>" shape.
 *
 * Throws if the env var is missing or malformed — the worker should
 * surface this as a fatal at boot rather than silently no-op the
 * sweep job for the lifetime of the deploy.
 */
export function getPrivateObjectLocation(
  env: NodeJS.ProcessEnv = process.env,
): { bucketName: string; entityPrefix: string } {
  const dir = env.PRIVATE_OBJECT_DIR ?? "";
  if (!dir) {
    throw new Error(
      "PRIVATE_OBJECT_DIR not set. The PHI attachment sweep cannot run " +
        "without a private object directory configured.",
    );
  }
  const normalized = dir.startsWith("/") ? dir : `/${dir}`;
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.length < 1) {
    throw new Error(
      `PRIVATE_OBJECT_DIR is malformed: '${dir}' (expected '/<bucket>[/<entity-prefix>]')`,
    );
  }
  const [bucketName, ...rest] = parts;
  return {
    bucketName,
    entityPrefix: rest.join("/"),
  };
}

/**
 * List every object under `<entity-prefix>/uploads/` in the private
 * bucket. Uses GCS's auto-paginated `getFiles({ autoPaginate: true })`
 * so callers get a flat array; the prefix is small enough (single-
 * digit thousands of attachments at production scale) that we don't
 * need a streaming iterator.
 *
 * Returns an empty array when the prefix is empty.
 */
export async function listAttachmentObjects(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttachmentObject[]> {
  const { bucketName, entityPrefix } = getPrivateObjectLocation(env);
  const prefix = entityPrefix
    ? `${entityPrefix}/uploads/`
    : "uploads/";
  const bucket = objectStorageClient.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
  return files.map((f) => {
    const tcRaw = f.metadata.timeCreated;
    let timeCreated: Date | null = null;
    if (typeof tcRaw === "string") {
      const d = new Date(tcRaw);
      if (!Number.isNaN(d.getTime())) timeCreated = d;
    }
    // GCS returns `size` as a stringified integer; coerce defensively
    // and fall back to null on anything we can't parse so a single
    // weird metadata blob can't crash the sweep.
    const sizeRaw = f.metadata.size;
    let size: number | null = null;
    if (typeof sizeRaw === "string") {
      const n = Number.parseInt(sizeRaw, 10);
      if (Number.isFinite(n) && n >= 0) size = n;
    } else if (typeof sizeRaw === "number" && Number.isFinite(sizeRaw)) {
      size = sizeRaw;
    }
    return {
      bucketName,
      objectName: f.name,
      timeCreated,
      size,
    };
  });
}

/**
 * Delete one object from the private bucket. Throws on failure
 * (including 404 — caller decides whether a vanished-mid-sweep object
 * is benign).
 */
export async function deleteAttachmentObject(
  bucketName: string,
  objectName: string,
): Promise<void> {
  await objectStorageClient.bucket(bucketName).file(objectName).delete();
}

/**
 * Translate a bucket-listed object name (e.g.
 * `replit-objstore-abc/.private/uploads/<uuid>`) into the
 * `/objects/uploads/<uuid>` form the `prescriptions.attachment_object_key`
 * column stores. Returns null if the object doesn't sit under the
 * expected `<entity-prefix>/uploads/` prefix — those are not
 * attachment-PHI objects and the sweep should leave them alone.
 *
 * The DB column shape comes from
 * `ObjectStorageService.normalizeObjectEntityPath` in the api; the
 * api persists `/objects/<entityId>` where `<entityId>` is the path
 * after `<entity-prefix>/`. For attachments that path is always
 * `uploads/<uuid>`.
 */
export function attachmentKeyForObjectName(
  objectName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const { entityPrefix } = getPrivateObjectLocation(env);
  const expected = entityPrefix
    ? `${entityPrefix}/uploads/`
    : "uploads/";
  if (!objectName.startsWith(expected)) return null;
  const tail = objectName.slice(expected.length);
  if (!tail) return null;
  return `/objects/uploads/${tail}`;
}
