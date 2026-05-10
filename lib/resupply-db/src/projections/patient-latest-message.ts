import type { ResupplySupabaseClient } from "../supabase-client";

/**
 * Patient latest-message projection refresher.
 *
 * Call this exactly once per message INSERT — outbound and inbound,
 * SMS / email / voice. Best-effort by design: callers SHOULD use the
 * `tryUpsertPatientLatestMessageSb` wrapper so a projection failure
 * never aborts the underlying message send (the projection is a UX
 * accelerator; the message itself is the source of truth).
 *
 * Patient id is always derived from the conversation. We do NOT
 * accept it as a caller-supplied input on purpose: a mismatched
 * (conversationId, patientId) tuple from an upstream bug would write
 * THIS conversation's preview onto SOMEONE ELSE'S patient row. The
 * single PK lookup we do here is the cheapest possible safety net
 * (sub-millisecond on an indexed primary key) and removes that
 * footgun entirely.
 *
 * Out-of-order safety:
 *   Webhook redelivery and out-of-order channel callbacks can deliver
 *   an older message AFTER a newer one. PostgREST has no
 *   `ON CONFLICT DO UPDATE WHERE …` clause, so the guard is split
 *   into two atomic statements:
 *
 *     1. UPDATE WHERE patient_id = $1 AND last_message_at < $newAt
 *        RETURNING patient_id
 *        — applies the refresh iff the new timestamp is strictly newer.
 *
 *     2. If the UPDATE returned 0 rows, INSERT. If the INSERT collides
 *        with the unique on patient_id (23505), it means a concurrent
 *        writer (or a fresher existing row) won the race — no-op.
 *
 *   Net behavior: each call leaves the row with the strictly-freshest
 *   event ever seen, even under concurrent out-of-order redelivery.
 *
 * Preview truncation:
 *   We store at most PREVIEW_MAX_CHARS of plaintext. The preview is
 *   for "last message at a glance" surfaces only — full bodies
 *   render on the conversation page from `messages.body`.
 */

/**
 * Maximum plaintext characters stored in the preview. Exported for
 * tests and for UI clients that want to render an ellipsis only
 * past this length.
 */
export const PREVIEW_MAX_CHARS = 80;

export type LatestMessageDirection = "inbound" | "outbound";

export interface UpsertPatientLatestMessageInput {
  /**
   * The conversation the message belongs to. Patient id is always
   * derived from this — see the module-level comment for why we
   * deliberately do not accept patientId from the caller.
   */
  conversationId: string;
  /**
   * The message body (plaintext). Will be truncated to
   * PREVIEW_MAX_CHARS before storage.
   */
  body: string;
  /**
   * The message direction — mirrors `messages.direction`. Stored as-
   * is on the projection so UI can render the correct arrow icon.
   */
  direction: LatestMessageDirection;
  /**
   * The message timestamp. We use this for the out-of-order guard
   * AND store it as `last_message_at`. Pass either the message's
   * `sentAt` (preferred when set) or `createdAt` as a fallback.
   */
  messageAt: Date;
}

/**
 * Truncate a plaintext body to PREVIEW_MAX_CHARS, collapsing inner
 * whitespace to a single space so the preview reads cleanly even when
 * the source body has line breaks (TwiML auto-replies, multi-line
 * voice transcripts). Exported for unit testing.
 */
export function buildPreview(body: string): string {
  // Normalize all whitespace runs (including newlines and tabs) to
  // a single space, then trim. Older patients dictate voice
  // transcripts with long pauses — those become extra-long
  // whitespace runs in the transcribed body.
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= PREVIEW_MAX_CHARS) return normalized;
  // Cut at PREVIEW_MAX_CHARS - 1 and append a single Unicode
  // ellipsis so the visual width stays inside the budget for any
  // monospaced render. The "- 1" gives a 1-char headroom for the
  // ellipsis itself; the final preview is exactly PREVIEW_MAX_CHARS.
  return `${normalized.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
}

/**
 * Apply the latest-message projection refresh.
 *
 * Returns `true` if a row was inserted or updated, `false` if the
 * incoming event was older-or-equal vs the existing projection (out-
 * of-order or duplicate redelivery — no-op). Callers may use the
 * return for telemetry but should not branch on it for correctness;
 * a `false` simply means a fresher (or identical) projection already
 * exists.
 */
export async function upsertPatientLatestMessageSb(
  supabase: ResupplySupabaseClient,
  input: UpsertPatientLatestMessageInput,
): Promise<boolean> {
  const preview = buildPreview(input.body);

  // Always derive patient id from the conversation.
  const { data: convRow, error: convErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("patient_id")
    .eq("id", input.conversationId)
    .limit(1)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!convRow || !convRow.patient_id) {
    // Either the conversation was deleted (FK should prevent this) or
    // the conversation is customer-keyed in_app with patient_id NULL —
    // see the module-level comment for the no-op rationale.
    return false;
  }
  const patientId = convRow.patient_id;

  const messageAtIso = input.messageAt.toISOString();

  // Step 1: conditional UPDATE. Atomic out-of-order guard.
  const { data: updated, error: updateErr } = await supabase
    .schema("resupply")
    .from("patient_latest_message")
    .update({
      last_message_at: messageAtIso,
      last_message_direction: input.direction,
      last_message_preview: preview,
      last_message_conversation_id: input.conversationId,
      updated_at: new Date().toISOString(),
    })
    .eq("patient_id", patientId)
    .lt("last_message_at", messageAtIso)
    .select("patient_id");
  if (updateErr) throw updateErr;
  if ((updated ?? []).length > 0) return true;

  // Step 2: nothing to update — either no row exists, or the
  // existing row's timestamp is >= ours. Try INSERT. If we collide
  // on the unique, that's a no-op (existing row is fresher OR
  // a parallel writer beat us).
  const { error: insertErr } = await supabase
    .schema("resupply")
    .from("patient_latest_message")
    .insert({
      patient_id: patientId,
      last_message_at: messageAtIso,
      last_message_direction: input.direction,
      last_message_preview: preview,
      last_message_conversation_id: input.conversationId,
    });
  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      // A concurrent writer beat us to the INSERT, so the row exists
      // now. Re-run the conditional UPDATE: if our timestamp is
      // fresher than whichever writer won, the lt() guard lets us
      // overwrite. Without this, two simultaneous writers can leave
      // the older message in the projection (the writer that loses
      // the INSERT race exits before checking timestamps).
      const { data: retried, error: retryErr } = await supabase
        .schema("resupply")
        .from("patient_latest_message")
        .update({
          last_message_at: messageAtIso,
          last_message_direction: input.direction,
          last_message_preview: preview,
          last_message_conversation_id: input.conversationId,
          updated_at: new Date().toISOString(),
        })
        .eq("patient_id", patientId)
        .lt("last_message_at", messageAtIso)
        .select("patient_id");
      if (retryErr) throw retryErr;
      return (retried ?? []).length > 0;
    }
    throw insertErr;
  }
  return true;
}

/**
 * Best-effort wrapper. Logs through the supplied (or process-wide
 * default) logger on failure and returns `false`; never throws. Use
 * this from message-write callsites where a projection failure must
 * not abort the send.
 *
 * The logger interface matches both pino (req.log) and the
 * application-level singleton logger.
 */
export interface ProjectionLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

// Process-wide default logger. The library deliberately stays free
// of any internal logging dependency (resupply-db must not pull in
// pino, the dashboard's logger, etc.), so the API/worker registers
// its own logger at boot via `setProjectionLogger`. Until that
// happens we fall back to a console.warn shim so projection
// failures still surface — silent failures here would degrade the
// patients list with no operational signal.
const consoleFallbackLogger: ProjectionLogger = {
  warn(obj, msg) {
    console.warn(msg ?? "patient_latest_message: refresh failed", obj);
  },
};

let defaultLogger: ProjectionLogger = consoleFallbackLogger;

/**
 * Register a process-wide logger for projection failures. Call
 * once at process boot — currently the resupply-api entrypoint,
 * which also hosts the in-process pg-boss worker.
 */
export function setProjectionLogger(logger: ProjectionLogger): void {
  defaultLogger = logger;
}

export async function tryUpsertPatientLatestMessageSb(
  supabase: ResupplySupabaseClient,
  input: UpsertPatientLatestMessageInput,
  logger?: ProjectionLogger,
): Promise<boolean> {
  try {
    return await upsertPatientLatestMessageSb(supabase, input);
  } catch (err) {
    (logger ?? defaultLogger).warn(
      {
        err: err instanceof Error ? err.message : String(err),
        conversationId: input.conversationId,
        direction: input.direction,
      },
      "patient_latest_message: refresh failed",
    );
    return false;
  }
}
