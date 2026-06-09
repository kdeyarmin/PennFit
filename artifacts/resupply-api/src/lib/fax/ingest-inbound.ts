// Inbound fax ingest — download the Telnyx-hosted fax media into our
// private object-storage bucket and persist an `inbound_faxes` row.
//
// Why we mirror the bytes vs. lazy-fetching from Telnyx
// -----------------------------------------------------
//   1. Media expiry: a Telnyx `fax.received` media_url is an AWS S3
//      pre-signed URL that stops working ~10 minutes after the event.
//      We MUST pull the bytes promptly or they're gone — there is no
//      "fetch it later" like Twilio's basic-auth media endpoint.
//   2. Retention: sleep-study faxes and signed prescriptions are PHI we
//      need to keep for the audit window our practice negotiated (years).
//   3. ACL: mirrored bytes inherit the same private object-storage ACL
//      as patient_documents — one place to audit and one place to revoke.
//
// Telnyx vs. Twilio media differences (this is why the auth fields are
// gone):
//   - Telnyx media_url is a pre-signed S3 URL — auth is embedded in the
//     query string, so NO Authorization header is sent (sending one
//     would actually break SigV4). Twilio required account-SID basic
//     auth; that's why the old input carried twilioAccountSid/AuthToken.
//   - Host is AWS S3 (or a telnyx.com storage host), not api.twilio.com.
//
// Allowed document types are PDF (Telnyx's default) and TIFF. Image
// types are NOT allowed — a fax is by definition a document.
//
// NOTE: the DB column is still named `twilio_fax_sid` (renaming it is a
// production migration tracked separately); we store the Telnyx fax id
// in it. It remains the unique idempotency key.

import type { Logger } from "pino";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { ObjectStorageService } from "../object-storage/objectStorage";

/** 10 MB cap — fax PDFs are typically 50-500 KB per page; a 10MB cap
 *  comfortably handles a 50-page chart-note fax with room to spare. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Per-fetch timeout. The S3 pre-signed URL is short-lived (~10 min),
 *  so budget 10s for a multi-page PDF and fail fast otherwise. */
const FETCH_TIMEOUT_MS = 10_000;

const ALLOWED_CONTENT_TYPES = new Set<string>([
  "application/pdf",
  "image/tiff",
  "image/tif",
]);

export interface IngestInboundFaxInput {
  /** Telnyx fax id (UUID). Stored in the `twilio_fax_sid` column. */
  telnyxFaxId: string;
  fromE164: string | null;
  toE164: string | null;
  numPages: number | null;
  receivedAt: string;
  /** Telnyx S3 pre-signed media URL (no auth header). */
  mediaUrl: string | null;
}

export type IngestInboundFaxOutcome =
  | { kind: "inserted"; id: string; mediaPersisted: boolean }
  | { kind: "already_recorded"; id: string }
  | { kind: "errored" };

/**
 * Idempotent inbound-fax ingest.
 *
 * Flow:
 *   1. Insert the row (returning id). Conflict on twilio_fax_sid
 *      means a Telnyx retry — we look up the existing id and return
 *      `already_recorded` without re-downloading.
 *   2. If a media URL is present, download the fax bytes; otherwise
 *      skip silently (the row exists, media_object_key stays null, the
 *      CSR sees the fax in the queue without the PDF).
 *   3. Validate type + size; upload to object storage with private ACL;
 *      patch the row with media metadata.
 *
 * Never throws — caller (the webhook) needs to keep its 200 SLA so
 * Telnyx doesn't retry. Any failure becomes a logged warning + an
 * outcome enum the caller can record.
 */
export async function ingestInboundFax(
  input: IngestInboundFaxInput,
  logger: Logger,
  storageImpl?: ObjectStorageService,
): Promise<IngestInboundFaxOutcome> {
  const supabase = getSupabaseServiceRoleClient();

  // Step 1: insert (or learn it already exists).
  const insertRes = await supabase
    .schema("resupply")
    .from("inbound_faxes")
    .insert({
      twilio_fax_sid: input.telnyxFaxId,
      from_e164: input.fromE164 ?? null,
      to_e164: input.toE164 ?? null,
      num_pages: input.numPages ?? null,
      received_at: input.receivedAt,
      status: "new",
    })
    .select("id")
    .single();

  let rowId: string;
  if (insertRes.error) {
    const code = (insertRes.error as { code?: string }).code;
    if (code === "23505") {
      // Unique violation on twilio_fax_sid — Telnyx retry. Look up
      // the existing row id and exit; we trust the prior attempt's
      // media-download outcome rather than re-running it.
      const existing = await supabase
        .schema("resupply")
        .from("inbound_faxes")
        .select("id")
        .eq("twilio_fax_sid", input.telnyxFaxId)
        .limit(1)
        .maybeSingle();
      if (existing.data) {
        return { kind: "already_recorded", id: existing.data.id };
      }
    }
    logger.warn(
      {
        err: insertRes.error.message,
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
      },
      "fax_inbound_db_insert_failed",
    );
    return { kind: "errored" };
  }
  rowId = insertRes.data.id;

  // Step 2: try to download the media bytes. Best-effort.
  const mediaPersisted = await tryPersistMedia(
    input,
    rowId,
    logger,
    storageImpl,
  );
  return { kind: "inserted", id: rowId, mediaPersisted };
}

/** Sniff a PDF/TIFF magic-byte signature. S3 pre-signed URLs sometimes
 *  serve a generic `application/octet-stream`, so we trust the bytes
 *  over the header. Returns the canonical content type or null. */
function sniffDocumentType(bytes: Uint8Array): string | null {
  // %PDF
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "application/pdf";
  }
  // TIFF: little-endian "II*\0" or big-endian "MM\0*"
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
      (bytes[0] === 0x4d &&
        bytes[1] === 0x4d &&
        bytes[2] === 0x00 &&
        bytes[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  return null;
}

async function tryPersistMedia(
  input: IngestInboundFaxInput,
  rowId: string,
  logger: Logger,
  storageImpl?: ObjectStorageService,
): Promise<boolean> {
  if (!input.mediaUrl) {
    return false;
  }

  // Validate the Telnyx media URL host to keep an attacker from coaxing
  // us into fetching arbitrary HTTPS URLs. Telnyx stores received-fax
  // media on AWS S3 (pre-signed) or a telnyx.com storage host.
  let parsed: URL;
  try {
    parsed = new URL(input.mediaUrl);
  } catch {
    logger.warn(
      { fax_id_first8: input.telnyxFaxId.slice(0, 8) },
      "fax_inbound_media_url_malformed",
    );
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const hostAllowed =
    host === "amazonaws.com" ||
    host.endsWith(".amazonaws.com") ||
    host === "telnyx.com" ||
    host.endsWith(".telnyx.com");
  if (parsed.protocol !== "https:" || !hostAllowed) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        hostname: parsed.hostname,
      },
      "fax_inbound_media_url_host_rejected",
    );
    return false;
  }

  // No Authorization header — the S3 pre-signed URL carries its own
  // SigV4 auth in the query string; adding a header would break it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(input.mediaUrl, {
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timer);
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        err: err instanceof Error ? err.message : String(err),
      },
      "fax_inbound_media_fetch_failed",
    );
    return false;
  }
  clearTimeout(timer);
  if (!resp.ok) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        status: resp.status,
      },
      "fax_inbound_media_non_2xx",
    );
    return false;
  }

  const headerContentType = (resp.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();

  const arrayBuf = await resp.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        size: bytes.byteLength,
      },
      "fax_inbound_media_size_rejected",
    );
    return false;
  }

  // Resolve the content type from the bytes first (S3 often serves a
  // generic octet-stream), falling back to the header allowlist.
  const sniffed = sniffDocumentType(bytes);
  const contentType =
    sniffed ??
    (ALLOWED_CONTENT_TYPES.has(headerContentType) ? headerContentType : null);
  if (!contentType) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        actual_content_type: headerContentType,
      },
      "fax_inbound_media_content_type_rejected",
    );
    return false;
  }

  // Upload to object storage, normalize ACL, then patch the row with the
  // resolved object key + metadata.
  const storage = storageImpl ?? new ObjectStorageService();
  let objectKey: string;
  try {
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    if (!putResp.ok) {
      logger.warn(
        {
          fax_id_first8: input.telnyxFaxId.slice(0, 8),
          status: putResp.status,
        },
        "fax_inbound_gcs_put_non_2xx",
      );
      return false;
    }
    const normalised = await storage.trySetObjectEntityAclPolicy(uploadUrl, {
      owner: "fax-inbound",
      visibility: "private",
    });
    if (!normalised) return false;
    objectKey = normalised;
  } catch (err) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        err: err instanceof Error ? err.message : String(err),
      },
      "fax_inbound_gcs_upload_failed",
    );
    return false;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { error: patchErr } = await supabase
    .schema("resupply")
    .from("inbound_faxes")
    .update({
      media_object_key: objectKey,
      media_content_type: contentType,
      media_size_bytes: bytes.byteLength,
    })
    .eq("id", rowId);
  if (patchErr) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        err: patchErr.message,
      },
      "fax_inbound_db_patch_failed",
    );
    // The object-storage bytes are now an orphan that the storage sweep
    // job (when one exists for fax orphans) will reap. Returning false
    // signals the caller to log media_persisted=false in the audit.
    return false;
  }
  return true;
}
