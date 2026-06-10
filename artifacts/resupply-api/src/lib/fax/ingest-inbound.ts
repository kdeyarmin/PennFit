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

import { autoMatchInboundFaxToPaperwork } from "../billing/bill-hold";
import { isFeatureEnabled } from "../feature-flags";
import { ObjectStorageService } from "../object-storage/objectStorage";

import { autoFileSignedFax } from "./auto-file-signed";

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

/** Cap on manually-followed redirects for the media fetch. */
const MAX_MEDIA_REDIRECTS = 3;

/** Telnyx stores received-fax media on AWS S3 (pre-signed) or a
 *  telnyx.com host. Anything else is rejected to constrain SSRF. */
function isAllowedMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "amazonaws.com" ||
    host.endsWith(".amazonaws.com") ||
    host === "telnyx.com" ||
    host.endsWith(".telnyx.com")
  );
}

/**
 * Fetch `url`, following at most MAX_MEDIA_REDIRECTS redirects MANUALLY so
 * every hop is re-validated against the host allowlist. `redirect: "follow"`
 * would validate only the first URL, letting an allowlisted host 3xx-redirect
 * us to an internal/non-allowlisted address (an SSRF primitive). Returns the
 * final non-redirect Response, or null if a hop is rejected or the cap is hit.
 */
async function fetchAllowlistedMedia(
  url: string,
  signal: AbortSignal,
): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop++) {
    const resp = await fetch(current, { signal, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) return null;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return null;
      }
      if (next.protocol !== "https:" || !isAllowedMediaHost(next.hostname)) {
        return null;
      }
      current = next.toString();
      continue;
    }
    return resp;
  }
  return null; // exceeded the redirect cap
}

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
  const media = await tryPersistMedia(input, rowId, logger, storageImpl);

  // Step 3: barcode auto-file (opt-in). When `fax.auto_file_signed` is on
  // and this is a signed copy of a document we sent out, read the printed
  // PennFit tracking code, file the fax into the patient's chart, mark the
  // signature returned, and release the bill hold. Runs BEFORE the
  // fax-number match below so the precise per-document match takes
  // precedence. Best-effort — never throws; an unmatched fax just stays
  // for manual triage. Skipped entirely when no media was persisted.
  let barcodeFiled = false;
  if (media.persisted && media.bytes && media.contentType) {
    try {
      if (await isFeatureEnabled("fax.auto_file_signed")) {
        const outcome = await autoFileSignedFax(
          {
            faxId: rowId,
            bytes: Buffer.from(media.bytes),
            contentType: media.contentType,
          },
          { supabase, logger, storage: storageImpl },
        );
        barcodeFiled = outcome.status === "filed";
      }
    } catch (err) {
      logger.warn(
        { err, fax_id_first8: rowId.slice(0, 8) },
        "fax_inbound_auto_file_failed",
      );
    }
  }

  // Step 4: bill-hold auto-match by return fax number — the fallback for a
  // fax with no scannable barcode. SKIPPED when the barcode step already
  // filed this fax: the number matcher auto-satisfies on the single
  // remaining requirement for a shared provider fax number, so letting it
  // run after a barcode match could release an UNRELATED requirement's hold
  // with the same fax. Best-effort + never throws.
  if (!barcodeFiled) {
    await autoMatchInboundFaxToPaperwork(rowId, input.fromE164, supabase);
  }

  return { kind: "inserted", id: rowId, mediaPersisted: media.persisted };
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

/** Result of the media-download step. On success it carries the resolved
 *  object key, content type, and the downloaded bytes so the caller can
 *  feed them straight into the barcode auto-file step without a second
 *  fetch. On any failure `persisted` is false and the rest are null. */
interface PersistMediaResult {
  persisted: boolean;
  objectKey: string | null;
  contentType: string | null;
  bytes: Uint8Array | null;
}

const MEDIA_NOT_PERSISTED: PersistMediaResult = {
  persisted: false,
  objectKey: null,
  contentType: null,
  bytes: null,
};

async function tryPersistMedia(
  input: IngestInboundFaxInput,
  rowId: string,
  logger: Logger,
  storageImpl?: ObjectStorageService,
): Promise<PersistMediaResult> {
  if (!input.mediaUrl) {
    return MEDIA_NOT_PERSISTED;
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
    return MEDIA_NOT_PERSISTED;
  }
  if (parsed.protocol !== "https:" || !isAllowedMediaHost(parsed.hostname)) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        hostname: parsed.hostname,
      },
      "fax_inbound_media_url_host_rejected",
    );
    return MEDIA_NOT_PERSISTED;
  }

  // No Authorization header — the S3 pre-signed URL carries its own
  // SigV4 auth in the query string; adding a header would break it.
  // Redirects are followed manually so each hop's host is re-validated.
  //
  // The abort timer must stay armed through the BODY read, not just
  // the headers: fetchAllowlistedMedia resolves once headers arrive,
  // and a stalled S3 body would otherwise hold the Telnyx webhook open
  // indefinitely — Telnyx then times out and retries, and the
  // idempotency row from step 1 makes the retry return
  // `already_recorded` WITHOUT media, permanently losing the fax PDF.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let bytes: Uint8Array;
  let headerContentType: string;
  try {
    let resp: Response | null;
    try {
      resp = await fetchAllowlistedMedia(input.mediaUrl, controller.signal);
    } catch (err) {
      logger.warn(
        {
          fax_id_first8: input.telnyxFaxId.slice(0, 8),
          err: err instanceof Error ? err.message : String(err),
        },
        "fax_inbound_media_fetch_failed",
      );
      return MEDIA_NOT_PERSISTED;
    }
    if (!resp) {
      // A redirect pointed off-allowlist (or exceeded the cap) — treat the
      // same as a rejected host.
      logger.warn(
        { fax_id_first8: input.telnyxFaxId.slice(0, 8) },
        "fax_inbound_media_redirect_rejected",
      );
      return MEDIA_NOT_PERSISTED;
    }
    if (!resp.ok) {
      logger.warn(
        {
          fax_id_first8: input.telnyxFaxId.slice(0, 8),
          status: resp.status,
        },
        "fax_inbound_media_non_2xx",
      );
      return MEDIA_NOT_PERSISTED;
    }

    headerContentType = (resp.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();

    // Content-Length pre-check (when the server sends one) so an
    // oversized body is rejected before buffering it into RAM — the
    // post-read MAX_BYTES check below stays as the backstop for
    // chunked responses. Mirrors the MMS ingest path.
    const declaredLength = Number(resp.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
      logger.warn(
        {
          fax_id_first8: input.telnyxFaxId.slice(0, 8),
          size: declaredLength,
        },
        "fax_inbound_media_size_rejected",
      );
      return MEDIA_NOT_PERSISTED;
    }

    let arrayBuf: ArrayBuffer;
    try {
      arrayBuf = await resp.arrayBuffer();
    } catch (err) {
      logger.warn(
        {
          fax_id_first8: input.telnyxFaxId.slice(0, 8),
          err: err instanceof Error ? err.message : String(err),
        },
        "fax_inbound_media_body_read_failed",
      );
      return MEDIA_NOT_PERSISTED;
    }
    bytes = new Uint8Array(arrayBuf);
  } finally {
    clearTimeout(timer);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        size: bytes.byteLength,
      },
      "fax_inbound_media_size_rejected",
    );
    return MEDIA_NOT_PERSISTED;
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
    return MEDIA_NOT_PERSISTED;
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
      return MEDIA_NOT_PERSISTED;
    }
    const normalised = await storage.trySetObjectEntityAclPolicy(uploadUrl, {
      owner: "fax-inbound",
      visibility: "private",
    });
    if (!normalised) return MEDIA_NOT_PERSISTED;
    objectKey = normalised;
  } catch (err) {
    logger.warn(
      {
        fax_id_first8: input.telnyxFaxId.slice(0, 8),
        err: err instanceof Error ? err.message : String(err),
      },
      "fax_inbound_gcs_upload_failed",
    );
    return MEDIA_NOT_PERSISTED;
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
    // job (when one exists for fax orphans) will reap. Returning a
    // not-persisted result signals the caller to log media_persisted=false.
    return MEDIA_NOT_PERSISTED;
  }
  return { persisted: true, objectKey, contentType, bytes };
}
