// MMS media ingestion — copy Twilio-hosted media bytes into our
// private object store and persist `message_attachments` rows.
//
// Why we mirror to our own storage rather than referencing the
// Twilio media URL directly:
//   1. Authentication — Twilio media URLs require basic-auth with
//      the account SID + auth token. Surfacing those credentials to
//      the dashboard is unacceptable; making the API proxy every
//      thumbnail render request would couple every conversation
//      view to Twilio's availability.
//   2. Retention — Twilio retains media for ~365 days then deletes
//      it without warning. PHI in a clinical conversation has to be
//      retrievable for the audit window the practice negotiated
//      with their counsel, which can be years.
//   3. ACL — once mirrored, the bytes inherit the same private GCS
//      ACL the rest of our PHI uses; one place to revoke, one place
//      to audit.
//
// Why best-effort rather than transactional with the message row:
//   The inbound webhook MUST respond to Twilio in <15s or Twilio
//   retries (which would create duplicate message rows guarded only
//   by the partial unique index — wasted work and noisy logs). A
//   patient sending a 4-image MMS could blow the budget if any one
//   download stalls. So we cap each download at 5s, run them
//   sequentially (Twilio rate-limits parallel reads from the same
//   account), and on ANY failure we log + continue rather than
//   throwing — the message body is already persisted, the missing
//   attachment is a degraded-but-correct state.
//
// What's enforced server-side at ingest:
//   - Per-media size cap (MAX_BYTES below). MMS spec is ~600KB to
//     1.2MB depending on carrier; we accept up to 5MB to leave
//     headroom for future iMessage/RCS uplift.
//   - Content-type allowlist (image/*, application/pdf). Anything
//     else is rejected before the bytes leave Twilio.
//   - Total media count cap (MAX_MEDIA_PER_MESSAGE). Twilio's own
//     cap is 10; we mirror that as a defense-in-depth backstop.

import { drizzle } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import { Readable } from "node:stream";

import { getDbPool, messageAttachments } from "@workspace/resupply-db";

import { ObjectStorageService } from "../object-storage/objectStorage";

// 5 MB — comfortably above MMS's de-facto 1.2MB cap, well below the
// 10 MB prescription cap. A patient occasionally sends a multi-page
// PDF via SMS shortcuts; this leaves room without inviting video.
const MAX_BYTES = 5 * 1024 * 1024;

// Twilio MMS spec caps at 10 media. We mirror as a backstop so a
// malformed webhook with NumMedia=99 can't fan out a flood of GCS
// uploads.
const MAX_MEDIA_PER_MESSAGE = 10;

// Per-media download timeout. Twilio's media CDN is fast (<1s
// typical) but we budget 5s for tail latency.
const PER_MEDIA_TIMEOUT_MS = 5_000;

// Overall ingestion budget. Twilio's webhook timeout is 15s — past
// that they retry, which would create duplicate inbound message
// rows guarded only by the partial unique index. We give ourselves
// 9s for the whole batch (downloads + GCS uploads + DB inserts)
// which leaves the rest of the handler ~6s of headroom for the
// reply TwiML render and the audit writes.
const OVERALL_BUDGET_MS = 9_000;

const ALLOWED_CONTENT_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

export interface IngestMmsMediaInput {
  /** Message row id we're attaching to (already persisted). */
  messageId: string;
  /**
   * Parsed inbound webhook params — we read MediaUrl0..MediaUrlN-1
   * and MediaContentType0..MediaContentTypeN-1 directly because
   * those keys aren't whitelisted in inboundSmsParamsSchema (Twilio
   * sends them as numbered fields, not an array).
   */
  rawWebhookBody: Record<string, unknown>;
  numMedia: number;
  twilioAccountSid: string;
  twilioAuthToken: string;
}

export interface IngestMmsMediaResult {
  /** How many MediaUrl[N] keys we attempted (≤ numMedia and MAX). */
  attempted: number;
  /** How many ended up persisted as message_attachments rows. */
  succeeded: number;
  /** How many were rejected for type/size/etc. */
  rejected: number;
  /** How many failed transiently (network/GCS). */
  errored: number;
}

interface MediaSlot {
  url: string;
  declaredContentType: string | null;
}

/**
 * Resolve numbered MediaUrl/MediaContentType keys from the raw
 * Twilio body. Twilio sends `MediaUrl0`, `MediaUrl1`, …,
 * `MediaUrlN-1`. We don't trust NumMedia blindly — we cross-check
 * against actual key presence so a tampered NumMedia=99 with no
 * URLs is bounded.
 */
function readMediaSlots(
  body: Record<string, unknown>,
  numMedia: number,
): MediaSlot[] {
  const cap = Math.min(numMedia, MAX_MEDIA_PER_MESSAGE);
  const slots: MediaSlot[] = [];
  for (let i = 0; i < cap; i++) {
    const url = body[`MediaUrl${i}`];
    if (typeof url !== "string" || !url.startsWith("https://")) continue;
    const ct = body[`MediaContentType${i}`];
    slots.push({
      url,
      declaredContentType: typeof ct === "string" ? ct : null,
    });
  }
  return slots;
}

/**
 * Extract the Twilio media SID from the canonical media URL
 * (https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages/<msid>/Media/<mediaSid>).
 * Returns null when the URL doesn't follow the expected shape — a
 * future Twilio URL change would gracefully degrade to "no SID,
 * replay-protection on this row disabled" rather than throwing
 * inside the webhook handler.
 */
function extractTwilioMediaSid(url: string): string | null {
  const match = url.match(/\/Media\/(ME[a-zA-Z0-9]+)(?:\/|$|\?)/);
  return match ? (match[1] ?? null) : null;
}

/**
 * Download bytes from `url` using Twilio basic auth. Returns the
 * bytes + the GCS-confirmed content-type/size, or null on any
 * failure (timeout, non-2xx, oversize, disallowed type).
 *
 * Why we re-validate content-type AFTER download rather than just
 * trusting MediaContentType[N] from the webhook: Twilio's webhook
 * params are signed so they can't be tampered in transit, but
 * MediaContentType is what Twilio CLAIMS — a future ingestion path
 * (forwarded MMS via a third-party gateway) might not be as
 * disciplined. Re-reading the response Content-Type means our
 * allowlist check is grounded in what we actually received.
 */
async function downloadOneMedia(
  slot: MediaSlot,
  twilioAccountSid: string,
  twilioAuthToken: string,
  logger: Logger,
): Promise<{
  bytes: Uint8Array;
  contentType: string;
  twilioMediaSid: string | null;
} | null> {
  const twilioMediaSid = extractTwilioMediaSid(slot.url);
  const auth = Buffer.from(
    `${twilioAccountSid}:${twilioAuthToken}`,
  ).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_MEDIA_TIMEOUT_MS);
  try {
    // Twilio media URL responds with a 307 redirect to a temporary
    // signed URL on Twilio's CDN that does NOT require auth. Fetch
    // follows redirects by default; we just need to send the basic
    // auth on the first hop.
    const resp = await fetch(slot.url, {
      headers: { Authorization: `Basic ${auth}` },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn(
        {
          status: resp.status,
          twilio_media_sid: twilioMediaSid,
        },
        "mms_ingest_download_non_2xx",
      );
      return null;
    }
    const actualContentType = (resp.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (!actualContentType || !ALLOWED_CONTENT_TYPES.has(actualContentType)) {
      logger.warn(
        {
          twilio_media_sid: twilioMediaSid,
          actual_content_type: actualContentType,
        },
        "mms_ingest_rejected_content_type",
      );
      return null;
    }

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
      logger.warn(
        {
          twilio_media_sid: twilioMediaSid,
          size: buf.byteLength,
        },
        "mms_ingest_rejected_size",
      );
      return null;
    }
    return { bytes: buf, contentType: actualContentType, twilioMediaSid };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        twilio_media_sid: twilioMediaSid,
      },
      "mms_ingest_download_failed",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload `bytes` to GCS via the existing presigned-URL flow used by
 * prescription attachments, then set the private ACL with the
 * "messaging-inbound" pseudo-owner.
 *
 * Returns the normalised `/objects/uploads/<uuid>` path or null on
 * failure.
 */
async function uploadToGcs(
  bytes: Uint8Array,
  contentType: string,
  storage: ObjectStorageService,
  logger: Logger,
): Promise<string | null> {
  try {
    const uploadUrl = await storage.getObjectEntityUploadURL();
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    if (!putResp.ok) {
      logger.warn(
        { status: putResp.status },
        "mms_ingest_gcs_put_non_2xx",
      );
      return null;
    }
    const normalised = await storage.trySetObjectEntityAclPolicy(uploadUrl, {
      // Pseudo-owner — there is no admin user "owning" an inbound
      // attachment. Mirrors the prescription ACL field for forward
      // compatibility (we may later gate per-conversation visibility
      // by the assigned admin's user id).
      owner: "messaging-inbound",
      visibility: "private",
    });
    return normalised;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "mms_ingest_gcs_upload_failed",
    );
    return null;
  }
}

/**
 * Best-effort MMS ingestion. Never throws — any partial failure is
 * logged and counted in the returned summary so the caller can audit
 * the overall outcome without crashing the webhook.
 */
export async function ingestInboundMmsMedia(
  input: IngestMmsMediaInput,
  logger: Logger,
  storageImpl?: ObjectStorageService,
): Promise<IngestMmsMediaResult> {
  const slots = readMediaSlots(input.rawWebhookBody, input.numMedia);
  const result: IngestMmsMediaResult = {
    attempted: slots.length,
    succeeded: 0,
    rejected: 0,
    errored: 0,
  };
  if (slots.length === 0) return result;

  const storage = storageImpl ?? new ObjectStorageService();
  const db = drizzle(getDbPool());

  type Outcome = "succeeded" | "rejected" | "errored";

  async function processOne(
    slot: MediaSlot,
    ordinal: number,
  ): Promise<Outcome> {
    const downloaded = await downloadOneMedia(
      slot,
      input.twilioAccountSid,
      input.twilioAuthToken,
      logger,
    );
    if (!downloaded) return "rejected";
    const objectKey = await uploadToGcs(
      downloaded.bytes,
      downloaded.contentType,
      storage,
      logger,
    );
    if (!objectKey) return "errored";

    // Filename: Twilio doesn't supply one for MMS. Synthesise from
    // the media SID + a sane extension so "Save as…" pre-fills
    // sensibly without leaking PHI.
    const ext = extensionForContentType(downloaded.contentType);
    const filename = downloaded.twilioMediaSid
      ? `mms-${downloaded.twilioMediaSid}${ext}`
      : `mms-${ordinal}${ext}`;

    try {
      await db.insert(messageAttachments).values({
        messageId: input.messageId,
        objectKey,
        filename,
        contentType: downloaded.contentType,
        sizeBytes: downloaded.bytes.byteLength,
        twilioMediaSid: downloaded.twilioMediaSid,
      });
      return "succeeded";
    } catch (err) {
      // Most likely the unique partial index on twilio_media_sid
      // fired — replayed webhook re-ingesting the same media. The
      // GCS bytes we just uploaded are now an orphan that the
      // attachment sweep job will reap. Log + count, don't throw.
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          twilio_media_sid: downloaded.twilioMediaSid,
        },
        "mms_ingest_db_insert_failed",
      );
      return "errored";
    }
  }

  // Parallelize per-media: each task is already bounded by its own
  // PER_MEDIA_TIMEOUT_MS download timeout (5s). Worst case for a
  // 10-media MMS is therefore ~5s end-to-end + GCS upload latency,
  // not 50s+ of serialized waits. We additionally race against an
  // OVERALL_BUDGET_MS wall-clock cap so a stalled GCS PUT can't
  // hold the webhook past Twilio's 15s retry threshold — anything
  // still pending past the budget is counted as `errored`.
  const tasks = slots.map((slot, i) => processOne(slot, i));
  const BUDGET_SENTINEL = Symbol("budget_exceeded");
  const settled = await Promise.race([
    Promise.allSettled(tasks),
    new Promise<typeof BUDGET_SENTINEL>((resolve) =>
      setTimeout(() => resolve(BUDGET_SENTINEL), OVERALL_BUDGET_MS),
    ),
  ]);

  if (settled === BUDGET_SENTINEL) {
    // Overall budget blew. We can't actually cancel the in-flight
    // fetches (no AbortSignal plumbed at this scope), but we MUST
    // return so the webhook handler can answer Twilio in time. The
    // background tasks either finish quietly (their DB insert
    // lands a few hundred ms late, harmless) or get GC'd if the
    // process restarts. Count every slot as errored for the audit.
    logger.warn(
      {
        budget_ms: OVERALL_BUDGET_MS,
        attempted: result.attempted,
      },
      "mms_ingest_overall_budget_exceeded",
    );
    result.errored = result.attempted;
    return result;
  }

  for (const r of settled) {
    if (r.status === "rejected") {
      result.errored += 1;
      continue;
    }
    result[r.value] += 1;
  }
  return result;
}

function extensionForContentType(ct: string): string {
  switch (ct) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

// Re-export for tests + downstream tooling.
export {
  ALLOWED_CONTENT_TYPES,
  MAX_BYTES,
  MAX_MEDIA_PER_MESSAGE,
  PER_MEDIA_TIMEOUT_MS,
};

// Streaming hook — tests use this to inject a fixed Readable in
// place of the global fetch's body. Currently unused by the runtime
// (fetch handles streaming internally) but exported so the test
// harness can build a deterministic Response. Kept here so the
// import surface of this module advertises every test seam.
export type ReadableLike = Readable;
