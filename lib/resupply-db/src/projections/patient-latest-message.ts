import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { conversations } from "../schema/conversations";
import { patientLatestMessage } from "../schema/patient-latest-message";
import type { ResupplySupabaseClient } from "../supabase-client";

/**
 * Patient latest-message projection refresher.
 *
 * Call this exactly once per message INSERT — outbound and inbound,
 * SMS / email / voice. Best-effort by design: callers SHOULD use the
 * `tryUpsertPatientLatestMessage` wrapper so a projection failure
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
 *   an older message AFTER a newer one. We compare the incoming
 *   `messageAt` against the existing row in the `WHERE` clause of
 *   the conflict update — strict `<` so equal-timestamp redelivery
 *   becomes a no-op and the projection isn't churned. (For two
 *   genuinely-distinct messages with the exact same timestamp the
 *   first-writer wins; that's an acceptable corner for a UX
 *   projection where the messages table remains the source of
 *   truth.)
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
export async function upsertPatientLatestMessage(
  db: NodePgDatabase<Record<string, unknown>>,
  input: UpsertPatientLatestMessageInput,
): Promise<boolean> {
  const preview = buildPreview(input.body);

  // Always derive patient id from the conversation. See the
  // module-level comment for the rationale.
  const rows = await db
    .select({ patientId: conversations.patientId })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (rows.length === 0) {
    // Conversation must exist (foreign key on messages enforces
    // this), so reaching here means an upstream bug. Surface as
    // a no-op; the tryUpsert wrapper logs the failure path
    // separately if the underlying call throws.
    return false;
  }
  const patientId = rows[0]!.patientId;
  if (!patientId) {
    // Post-0033: conversations can be customer-keyed (in_app) with
    // patient_id NULL. The patient_latest_message projection is
    // patient-only by design (it powers the patient list page). For
    // an in-app, customer-keyed conversation we have nothing to
    // project here — surface as a no-op. The customer-facing
    // /shop/me/messages endpoint reads from `messages` directly.
    return false;
  }

  const result = await db
    .insert(patientLatestMessage)
    .values({
      patientId,
      lastMessageAt: input.messageAt,
      lastMessageDirection: input.direction,
      lastMessagePreview: preview,
      lastMessageConversationId: input.conversationId,
    })
    .onConflictDoUpdate({
      target: patientLatestMessage.patientId,
      set: {
        lastMessageAt: input.messageAt,
        lastMessageDirection: input.direction,
        lastMessagePreview: preview,
        lastMessageConversationId: input.conversationId,
        updatedAt: sql`now()`,
      },
      // Out-of-order guard. EXCLUDED is the proposed new row;
      // the bare column reference is the existing row. Strict `<`
      // means equal-timestamp redelivery becomes a no-op (rather
      // than churning the row with the same content). Vendor
      // timestamps are second-resolution at best so duplicate
      // redelivery commonly arrives with identical messageAt.
      setWhere: sql`${patientLatestMessage.lastMessageAt} < EXCLUDED.${sql.identifier("last_message_at")}`,
    })
    .returning({ patientId: patientLatestMessage.patientId });

  return result.length > 0;
}

/**
 * Supabase-flavored variant of `upsertPatientLatestMessage`. Same
 * semantics; PostgREST has no `ON CONFLICT DO UPDATE WHERE …` so the
 * out-of-order guard is split into two atomic statements:
 *
 *   1. UPDATE WHERE patient_id = $1 AND last_message_at < $newAt
 *      RETURNING patient_id
 *      — applies the refresh iff the new timestamp is strictly newer.
 *
 *   2. If the UPDATE returned 0 rows, INSERT. If the INSERT collides
 *      with the unique on patient_id (23505), it means a concurrent
 *      writer (or a fresher existing row) won the race — no-op.
 *
 * Net behavior matches the Drizzle path: each call leaves the row
 * with the strictly-freshest event ever seen, even under concurrent
 * out-of-order redelivery. The two statements are NOT wrapped in a
 * transaction; that's deliberate. If a writer succeeds with the
 * UPDATE, no INSERT is attempted. If a writer's UPDATE matches 0
 * rows and a parallel writer races them on INSERT, both will
 * collide on the unique and the loser silently no-ops — the
 * stronger-timestamp INSERT survives.
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
      // Concurrent writer (or a fresher existing row already wins on
      // the timestamp guard above). No-op.
      return false;
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

export async function tryUpsertPatientLatestMessage(
  db: NodePgDatabase<Record<string, unknown>>,
  input: UpsertPatientLatestMessageInput,
  logger?: ProjectionLogger,
): Promise<boolean> {
  try {
    return await upsertPatientLatestMessage(db, input);
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

/**
 * Best-effort Supabase-flavored wrapper. Use from message-write
 * callsites that have already migrated to supabase-js so the
 * projection refresh doesn't drag a Drizzle handle along.
 */
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
