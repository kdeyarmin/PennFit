// Inbound fax ingest — download Twilio-hosted fax media into our
// private GCS bucket and persist an `inbound_faxes` row.
//
// Why we mirror the bytes vs. lazy-fetching from Twilio
// -----------------------------------------------------
//   1. Twilio media auth: the inbound fax MediaUrl requires Twilio
//      basic-auth (account SID + auth token). Surfacing those
//      credentials to the dashboard is unacceptable; making the API
//      proxy every PDF view through Twilio would couple every triage
//      view to Twilio's availability.
//   2. Retention: Twilio retains fax media for ~365 days, then
//      deletes without notice. Sleep-study faxes and signed
//      prescriptions are PHI we need to keep for the audit window
//      our practice negotiated (years, not months).
//   3. ACL: mirrored bytes inherit the same private GCS ACL as
//      patient_documents — one place to audit and one place to
//      revoke.
//
// Mirrors the messaging/ingest-mms.ts pattern: validate type+size,
// upload, normalize ACL, return the object key. Differences:
//   - Fax inbound is a SINGLE media per webhook (no MMS-style
//     MediaUrl0..N indirection).
//   - Allowed types are PDF (Twilio's default) and TIFF (some
//     senders' default). Image types are NOT allowed here even
//     though the MMS path allows them — a fax is by definition a
//     document, and accepting JPEGs would invite "I screenshotted
//     the patient chart and sent it via fax" workflows that bypass
//     the supplier's retention policy.

import type { Logger } from "pino";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { ObjectStorageService } from "../object-storage/objectStorage";

/** 10 MB cap — fax PDFs are typically 50-500 KB per page; a 10MB cap
 *  comfortably handles a 50-page chart-note fax with room to spare. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Per-fetch timeout. Twilio fax media CDN is sometimes slower than
 *  MMS (multi-page PDFs are larger), so we budget 10s vs. MMS's 5s. */
const FETCH_TIMEOUT_MS = 10_000;

const ALLOWED_CONTENT_TYPES = new Set<string>([
  "application/pdf",
  "image/tiff",
  "image/tif",
]);

export interface IngestInboundFaxInput {
  twilioFaxSid: string;
  fromE164: string | null;
  toE164: string | null;
  numPages: number | null;
  receivedAt: string;
  mediaUrl: string | null;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
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
 *      means a Twilio retry — we look up the existing id and return
 *      `already_recorded` without re-downloading.
 *   2. If TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + MediaUrl are
 *      configured, download the fax bytes; otherwise skip silently
 *      (the row exists, media_object_key stays null, CSR sees the
 *      fax in the queue without the PDF).
 *   3. Validate type + size; upload to GCS with private ACL;
 *      patch the row with media metadata.
 *
 * Never throws — caller (the webhook) needs to keep its 200 SLA so
 * Twilio doesn't retry. Any failure becomes a logged warning + an
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
      twilio_fax_sid: input.twilioFaxSid,
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
      // Unique violation on twilio_fax_sid — Twilio retry. Look up
      // the existing row id and exit; we trust the prior attempt's
      // media-download outcome rather than re-running it.
      const existing = await supabase
        .schema("resupply")
        .from("inbound_faxes")
        .select("id")
        .eq("twilio_fax_sid", input.twilioFaxSid)
        .limit(1)
        .maybeSingle();
      if (existing.data) {
        return { kind: "already_recorded", id: existing.data.id };
      }
    }
    logger.warn(
      {
        err: insertRes.error.message,
        twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
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

async function tryPersistMedia(
  input: IngestInboundFaxInput,
  rowId: string,
  logger: Logger,
  storageImpl?: ObjectStorageService,
): Promise<boolean> {
  if (!input.mediaUrl || !input.twilioAccountSid || !input.twilioAuthToken) {
    return false;
  }

  // Validate the Twilio media URL — same host check as MMS to keep
  // an attacker from coaxing us into fetching arbitrary HTTPS URLs
  // with our Twilio credentials.
  let parsed: URL;
  try {
    parsed = new URL(input.mediaUrl);
  } catch {
    logger.warn(
      { twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8) },
      "fax_inbound_media_url_malformed",
    );
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.twilio.com") {
    logger.warn(
      {
        twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
        hostname: parsed.hostname,
      },
      "fax_inbound_media_url_host_rejected",
    );
    return false;
  }

  const auth = Buffer.from(
    `${input.twilioAccountSid}:${input.twilioAuthToken}`,
  ).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(input.mediaUrl, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    clearTimeout(timer);
    logger.warn(
      {
        twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
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
        twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
        status: resp.status,
      },
      "fax_inbound_media_non_2xx",
    );
    return false;
  }

  const contentType = (resp.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    logger.warn(
      {
        twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
        actual_content_type: contentType,
      },
      "fax_inbound_media_content_type_rejected",
    );
    return false;
  }

  const arrayBuf = await resp.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    logger.warn(
      {
        twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
        size: bytes.byteLength,
      },
      "fax_inbound_media_size_rejected",
    );
    return false;
  }

  // Upload to GCS, normalize ACL, then patch the row with the
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
          twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
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
        twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
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
        twilio_fax_sid_first8: input.twilioFaxSid.slice(0, 8),
        err: patchErr.message,
      },
      "fax_inbound_db_patch_failed",
    );
    // The GCS bytes are now an orphan that the storage sweep job
    // (when one exists for fax orphans) will reap. Returning false
    // signals the caller to log media_persisted=false in the
    // audit so the CSR can re-pull from Twilio while the media is
    // still in the retention window.
    return false;
  }
  return true;
}
