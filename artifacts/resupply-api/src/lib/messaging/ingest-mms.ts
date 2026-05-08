// Inbound message-attachment ingestion.
//
// Two callers today:
//   1. The Twilio MMS webhook, which knows nothing but a list of
//      Twilio-hosted MediaUrl[N] strings. The downloader here pulls
//      those bytes (basic-auth, with a per-media timeout), validates
//      type+size, uploads to GCS, inserts a `message_attachments`
//      row. Public entry point: `ingestInboundMmsMedia`.
//   2. The SendGrid Inbound Parse webhook, which arrives with the
//      attachment bytes already in-process (multipart/form-data).
//      That path re-uses the validate+upload+insert tail end via
//      the exported `persistInboundAttachment` helper, so the
//      allowlist + size cap + GCS ACL + DB insert behaviour is
//      identical across channels. Public entry point: callers
//      import `persistInboundAttachment` directly.
//
// MMS-specific framing notes preserved for future readers:
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
  accountSid: string;
  messageSid: string;
  mediaSid: string;
  declaredContentType: string | null;
}

/**
 * Resolve numbered MediaUrl/MediaContentType keys from the raw
 * Twilio body. Twilio sends `MediaUrl0`, `MediaUrl1`, …,
 * `MediaUrlN-1`. We don't trust NumMedia blindly — we cross-check
 * against actual key presence so a tampered NumMedia=99 with no
 * URLs is bounded.
 */
function parseAllowedTwilioMediaRef(raw: string): {
  accountSid: string;
  messageSid: string;
  mediaSid: string;
} | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "api.twilio.com") return null;
    // Match strictly alphanumeric segments (with Twilio's documented
    // SID prefixes). We extract only identifiers and construct the
    // request URL later from trusted constants.
    const match =
      /^\/2010-04-01\/Accounts\/(AC[A-Za-z0-9]+)\/Messages\/((?:MM|SM)[A-Za-z0-9]+)\/Media\/(ME[A-Za-z0-9]+)$/.exec(
        parsed.pathname,
      );
    if (!match) return null;
    const [, accountSid, messageSid, mediaSid] = match;
    return { accountSid, messageSid, mediaSid };
  } catch {
    return null;
  }
}

function readMediaSlots(
  body: Record<string, unknown>,
  numMedia: number,
): MediaSlot[] {
  const cap = Math.min(numMedia, MAX_MEDIA_PER_MESSAGE);
  const slots: MediaSlot[] = [];
  for (let i = 0; i < cap; i++) {
    const rawUrl = body[`MediaUrl${i}`];
    if (typeof rawUrl !== "string") continue;
    const mediaRef = parseAllowedTwilioMediaRef(rawUrl);
    if (!mediaRef) continue;
    const ct = body[`MediaContentType${i}`];
    slots.push({
      accountSid: mediaRef.accountSid,
      messageSid: mediaRef.messageSid,
      mediaSid: mediaRef.mediaSid,
      declaredContentType: typeof ct === "string" ? ct : null,
    });
  }
  return slots;
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
  const twilioMediaSid = slot.mediaSid;
  const ACCOUNT_SID_RE = /^AC[A-Za-z0-9]{32}$/;
  const MESSAGE_SID_RE = /^SM[A-Za-z0-9]{32}$/;
  const MEDIA_SID_RE = /^ME[A-Za-z0-9]{32}$/;
  if (
    !ACCOUNT_SID_RE.test(slot.accountSid) ||
    !MESSAGE_SID_RE.test(slot.messageSid) ||
    !MEDIA_SID_RE.test(slot.mediaSid) ||
    slot.accountSid !== twilioAccountSid
  ) {
    logger.warn(
      {
        twilio_media_sid: twilioMediaSid,
        account_sid: slot.accountSid,
        message_sid: slot.messageSid,
      },
      "mms_ingest_rejected_invalid_twilio_media_ref",
    );
    return null;
  }
  const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${slot.accountSid}/Messages/${slot.messageSid}/Media/${slot.mediaSid}`;
  const auth = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString(
    "base64",
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_MEDIA_TIMEOUT_MS);
  try {
    // Twilio media URL responds with a 307 redirect to a temporary
    // signed URL on Twilio's CDN that does NOT require auth. Fetch
    // follows redirects by default; we just need to send the basic
    // auth on the first hop.
    const resp = await fetch(mediaUrl, {
      headers: { Authorization: `Basic ${auth}` },
      redirect: "manual",
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
 * Validate `contentType` + `bytes` size against the same allowlist /
 * cap the MMS path uses, then mirror the bytes into our private GCS
 * bucket and insert the matching `message_attachments` row. Used by
 * both the MMS path (post-download) and the SendGrid Inbound Parse
 * path (bytes already in hand).
 *
 * Returns:
 *   - "succeeded" when the row landed,
 *   - "rejected" for type/size violations (no GCS upload occurred),
 *   - "errored"  for transient GCS / DB failures (callers should
 *                count this and continue).
 *
 * Never throws — internal failures are logged and folded into the
 * outcome enum so a webhook handler can keep its 200 SLA.
 */
export interface PersistInboundAttachmentInput {
  /** Message row id to attach to (already persisted). */
  messageId: string;
  /** Raw bytes of the attachment. */
  bytes: Uint8Array;
  /** MIME type (will be lower-cased + checked against the allowlist). */
  contentType: string;
  /**
   * Best-effort original filename. Truncated to fit the
   * `varchar(255)` column. Pass null to synthesize one from a
   * sensible source-specific prefix.
   */
  filename: string | null;
  /**
   * Twilio's per-media SID when the source is MMS — drives the
   * partial-unique replay-protection index. Null for non-Twilio
   * sources (e.g. inbound email).
   */
  twilioMediaSid?: string | null;
  /** Short tag for log lines + filename fallback ("mms" / "email"). */
  source?: string;
}

export type PersistInboundAttachmentOutcome =
  | "succeeded"
  | "rejected"
  | "errored";

export async function persistInboundAttachment(
  input: PersistInboundAttachmentInput,
  logger: Logger,
  storageImpl?: ObjectStorageService,
): Promise<PersistInboundAttachmentOutcome> {
  const declaredType =
    (input.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!declaredType || !ALLOWED_CONTENT_TYPES.has(declaredType)) {
    logger.warn(
      {
        source: input.source ?? "unknown",
        actual_content_type: declaredType,
      },
      "attachment_ingest_rejected_content_type",
    );
    return "rejected";
  }
  if (
    !input.bytes ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > MAX_BYTES
  ) {
    logger.warn(
      {
        source: input.source ?? "unknown",
        size: input.bytes?.byteLength ?? 0,
      },
      "attachment_ingest_rejected_size",
    );
    return "rejected";
  }

  const storage = storageImpl ?? new ObjectStorageService();
  const objectKey = await uploadToGcs(
    input.bytes,
    declaredType,
    storage,
    logger,
  );
  if (!objectKey) return "errored";

  const filename = sanitizeFilename(
    input.filename,
    declaredType,
    input.source ?? "inbound",
    input.twilioMediaSid ?? null,
  );

  const db = drizzle(getDbPool());
  try {
    await db.insert(messageAttachments).values({
      messageId: input.messageId,
      objectKey,
      filename,
      contentType: declaredType,
      sizeBytes: input.bytes.byteLength,
      twilioMediaSid: input.twilioMediaSid ?? null,
    });
    return "succeeded";
  } catch (err) {
    // Most likely the partial-unique index on twilio_media_sid fired
    // (replayed MMS webhook). The GCS bytes we just uploaded are now
    // an orphan that the attachment sweep job will reap.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        twilio_media_sid: input.twilioMediaSid ?? null,
        source: input.source ?? "unknown",
      },
      "attachment_ingest_db_insert_failed",
    );
    return "errored";
  }
}

/**
 * Build a safe filename for the persisted row. We never trust the
 * source-supplied name verbatim:
 *   - Strip path separators and control characters,
 *   - Force a sensible extension matching the validated content type,
 *   - Truncate to fit the schema's varchar(255).
 *
 * When the caller supplies no filename we synthesize one from
 * `<source>-<sid|random>.<ext>` so "Save as…" pre-fills with a
 * recognisable label without leaking PHI.
 */
function sanitizeFilename(
  raw: string | null,
  contentType: string,
  source: string,
  twilioMediaSid: string | null,
): string {
  const ext = extensionForContentType(contentType);
  if (raw && raw.trim().length > 0) {
    const cleaned = raw
      // Strip ASCII control chars (U+0000-U+001F) and path separators
      // from caller-supplied filenames. The control-char range is
      // intentional - we are sanitising hostile input, not embedding
      // literal control characters in the regex source.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f/\\]+/g, "_")
      .trim()
      .slice(0, 240);
    if (cleaned.length > 0) {
      // Preserve the caller's extension if any; otherwise append the
      // type-derived one so downstream tools open it correctly.
      return /\.[a-zA-Z0-9]{1,8}$/.test(cleaned) ? cleaned : `${cleaned}${ext}`;
    }
  }
  const tail = twilioMediaSid ?? Math.random().toString(36).slice(2, 10);
  return `${source}-${tail}${ext}`;
}

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
      logger.warn({ status: putResp.status }, "mms_ingest_gcs_put_non_2xx");
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

  type Outcome = "succeeded" | "rejected" | "errored";

  async function processOne(
    slot: MediaSlot,
    _ordinal: number,
  ): Promise<Outcome> {
    const downloaded = await downloadOneMedia(
      slot,
      input.twilioAccountSid,
      input.twilioAuthToken,
      logger,
    );
    if (!downloaded) return "rejected";
    // Hand off to the shared validate→upload→insert tail. The MMS
    // path supplies twilio_media_sid (drives the partial-unique
    // replay-protection index) and a null filename so the helper
    // synthesizes "mms-<sid>.<ext>" from the source tag — same
    // string the original MMS-only code path produced.
    return persistInboundAttachment(
      {
        messageId: input.messageId,
        bytes: downloaded.bytes,
        contentType: downloaded.contentType,
        filename: null,
        twilioMediaSid: downloaded.twilioMediaSid,
        source: "mms",
      },
      logger,
      storage,
    );
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
