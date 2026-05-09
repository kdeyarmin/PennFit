// In-app conversation helper — shared logic for customer ↔ CSR
// messaging on the `in_app` channel introduced in migration 0033.
//
// Two callers:
//   * Customer side — POST /shop/me/messages calls
//     `appendCustomerMessage()` which lazily creates the thread and
//     persists an inbound message with senderRole="customer".
//   * Admin side    — POST /conversations/:id/reply branches on
//     `conv.channel === "in_app"` and calls `appendAdminInAppReply()`
//     which persists an outbound message with senderRole="admin"
//     against an EXISTING thread (no auto-create — admins can only
//     reply to a thread the customer started).
//
// Why a single helper file instead of inline-in-route:
//   * Both paths need the same write semantics
//     (insert message + update conversations.lastMessageAt + flip
//     status). Centralizing keeps the SQL in one place and the
//     audit-log envelope consistent.
//   * The admin path also needs to fire a SendGrid notification
//     email; that's wired from the route, not here, so this helper
//     stays free of SendGrid imports.
//
// Single-thread-per-customer policy:
//   For v1 every customer has at most ONE in-app conversation row
//   (channel=in_app, customer_id=that user). The CSR can close a
//   thread; the next customer message reopens it OR creates a new
//   row if the previous one was hard-closed (status="closed"). For
//   v1 we simply flip status back to "awaiting_admin" on customer
//   messages and never auto-archive — keeps the inbox simple.

import {
  type Database,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";

type ConversationRow =
  Database["resupply"]["Tables"]["conversations"]["Row"];

/** Body length cap. Mirrors the existing SMS reply cap. */
export const IN_APP_MESSAGE_BODY_MAX = 4000;

export interface InAppMessageView {
  id: string;
  direction: "inbound" | "outbound";
  senderRole: "customer" | "admin" | "agent" | "system";
  body: string;
  createdAt: string;
  /**
   * `null` for in-app since there's no Twilio/SendGrid round-trip.
   * Populated for SMS/email channels — we leave the field on the
   * shape so the customer UI can render a unified message list if
   * we ever expose channel-mixed history.
   */
  deliveryStatus: string | null;
}

export interface InAppThreadView {
  id: string;
  status: ConversationRow["status"];
  lastMessageAt: string | null;
  createdAt: string;
}

export interface FetchInAppThreadResult {
  thread: InAppThreadView | null;
  messages: InAppMessageView[];
  /**
   * Count of outbound CSR messages that arrived AFTER the customer
   * last marked the thread read (or every outbound message when
   * the customer has never read). Drives the header badge + the
   * "X new replies" pill on the /account messages section.
   */
  unreadFromCsr: number;
}

/**
 * Read the customer's in-app thread plus its message history. Returns
 * `{ thread: null, messages: [] }` when the customer has never
 * messaged before — the UI can render an empty-state CTA in that case
 * without a separate "does this exist" round-trip.
 *
 * We deliberately filter on `customerId AND channel=in_app` so a
 * future "second in-app thread" (we'd add a separate
 * `customerEpisodeId`-style scope later) doesn't leak into v1
 * callers.
 */
export async function fetchInAppThread(input: {
  supabase: ResupplySupabaseClient;
  customerId: string;
}): Promise<FetchInAppThreadResult> {
  const { data: conv, error: convErr } = await input.supabase
    .schema("resupply")
    .from("conversations")
    .select("id, status, last_message_at, created_at, customer_last_read_at")
    .eq("customer_id", input.customerId)
    .eq("channel", "in_app")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!conv) {
    return { thread: null, messages: [], unreadFromCsr: 0 };
  }
  const { data: msgRows, error: msgErr } = await input.supabase
    .schema("resupply")
    .from("messages")
    .select("id, direction, sender_role, body, created_at, delivery_status")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true })
    .limit(500);
  if (msgErr) throw msgErr;

  // Compute unread-from-CSR. Walk the message list once; acceptable
  // because the fetch is capped at 500 rows above.
  const lastReadMs = conv.customer_last_read_at
    ? new Date(conv.customer_last_read_at).getTime()
    : 0;
  let unreadFromCsr = 0;
  for (const m of msgRows ?? []) {
    if (
      m.direction === "outbound" &&
      new Date(m.created_at).getTime() > lastReadMs
    ) {
      unreadFromCsr += 1;
    }
  }

  return {
    thread: {
      id: conv.id,
      status: conv.status,
      lastMessageAt: conv.last_message_at,
      createdAt: conv.created_at,
    },
    messages: (msgRows ?? []).map((m) => ({
      id: m.id,
      direction: m.direction as "inbound" | "outbound",
      // Type narrowing: senderRole on the schema is the full enum
      // (patient | customer | admin | agent | system). For in-app
      // threads the only roles that appear are customer / admin /
      // agent / system. We narrow to the in-app subset for the
      // public response. Patient-flow rows can't appear here because
      // we filtered conversations on channel=in_app + customer_id.
      senderRole: (m.sender_role === "patient"
        ? "customer"
        : m.sender_role) as "customer" | "admin" | "agent" | "system",
      body: m.body ?? "",
      createdAt: m.created_at,
      deliveryStatus: m.delivery_status,
    })),
    unreadFromCsr,
  };
}

/**
 * Count just the unread CSR messages without fetching the full
 * message list. Used by the cheap polling endpoint behind the
 * header badge — N customers × every-page-load shouldn't pay the
 * full thread read cost.
 *
 * Returns 0 when:
 *   - the customer has no in-app thread,
 *   - the thread exists but has no outbound messages,
 *   - or every outbound message arrived before customer_last_read_at.
 */
export async function fetchInAppUnreadCount(input: {
  supabase: ResupplySupabaseClient;
  customerId: string;
}): Promise<number> {
  const { data: conv, error: convErr } = await input.supabase
    .schema("resupply")
    .from("conversations")
    .select("id, customer_last_read_at")
    .eq("customer_id", input.customerId)
    .eq("channel", "in_app")
    .limit(1)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!conv) return 0;
  const lastReadAtIso = conv.customer_last_read_at ?? "1970-01-01T00:00:00Z";
  const { count, error } = await input.supabase
    .schema("resupply")
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conv.id)
    .eq("direction", "outbound")
    .gt("created_at", lastReadAtIso);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Mark the customer's in-app thread as fully read. Sets
 * `customer_last_read_at = now()` on the conversation. No-op when
 * the customer has no thread (returns false).
 */
export async function markInAppThreadRead(input: {
  supabase: ResupplySupabaseClient;
  customerId: string;
}): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data: updated, error } = await input.supabase
    .schema("resupply")
    .from("conversations")
    .update({ customer_last_read_at: nowIso, updated_at: nowIso })
    .eq("customer_id", input.customerId)
    .eq("channel", "in_app")
    .select("id");
  if (error) throw error;
  return (updated ?? []).length > 0;
}

export interface AppendCustomerMessageResult {
  threadId: string;
  messageId: string;
  /** True when the row was created on this call (lazy-init). */
  threadCreated: boolean;
}

/**
 * Customer wrote a new message. Lazy-creates the thread on first
 * use, inserts the inbound message, flips conversation status to
 * `awaiting_admin`, and bumps lastMessageAt.
 *
 * The caller is responsible for body validation (length + trim) —
 * this helper assumes the input has already been cleaned.
 */
export async function appendCustomerMessage(input: {
  supabase: ResupplySupabaseClient;
  customerId: string;
  body: string;
}): Promise<AppendCustomerMessageResult> {
  const nowIso = new Date().toISOString();

  // Find existing thread first. v1 has at most one row per customer
  // on channel=in_app; closed threads ARE reusable per the policy
  // comment at the top of this file (a fresh customer message flips
  // status back to awaiting_admin, see the trailing UPDATE below).
  const { data: existing, error: existingErr } = await input.supabase
    .schema("resupply")
    .from("conversations")
    .select("id")
    .eq("customer_id", input.customerId)
    .eq("channel", "in_app")
    .limit(1)
    .maybeSingle();
  if (existingErr) throw existingErr;

  let threadId: string;
  let threadCreated = false;
  if (existing) {
    threadId = existing.id;
  } else {
    // First message — create the thread.
    const { data: created, error: createErr } = await input.supabase
      .schema("resupply")
      .from("conversations")
      .insert({
        customer_id: input.customerId,
        // patient_id / episode_id stay null — the CHECK constraint
        // requires customer_id-set rows to have both null.
        patient_id: null,
        episode_id: null,
        channel: "in_app",
        status: "awaiting_admin",
        last_message_at: nowIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (createErr) throw createErr;
    if (!created) throw new Error("conversations insert returned no rows");
    threadId = created.id;
    threadCreated = true;
  }

  const { data: inserted, error: insertErr } = await input.supabase
    .schema("resupply")
    .from("messages")
    .insert({
      conversation_id: threadId,
      direction: "inbound",
      sender_role: "customer",
      body: input.body,
      // No vendor side for in-app; deliveryStatus stays null.
      sent_at: nowIso,
    })
    .select("id")
    .limit(1)
    .maybeSingle();
  if (insertErr) throw insertErr;
  if (!inserted) throw new Error("messages insert returned no rows");

  // Bump the conversation forward — flip to awaiting_admin in case a
  // closed/awaiting_patient thread is being reopened by this message.
  const { error: bumpErr } = await input.supabase
    .schema("resupply")
    .from("conversations")
    .update({
      last_message_at: nowIso,
      status: "awaiting_admin",
      updated_at: nowIso,
    })
    .eq("id", threadId);
  if (bumpErr) throw bumpErr;

  return { threadId, messageId: inserted.id, threadCreated };
}

export interface AppendAdminReplyResult {
  messageId: string;
}

export type AppendAdminInAppReplyOutcome =
  | { status: "ok"; result: AppendAdminReplyResult }
  | { status: "conversation_not_found" }
  | { status: "conversation_closed" }
  | { status: "wrong_channel" }
  | { status: "missing_customer_id" };

/**
 * Admin replied on an in-app thread. The conversation must already
 * exist (admins don't open in-app threads — the customer does).
 * Marks status as `awaiting_patient` and bumps lastMessageAt.
 *
 * Returns `wrong_channel` when called on a non-in_app conversation
 * — the caller should branch to `replyInConversation` for SMS/email.
 */
export async function appendAdminInAppReply(input: {
  supabase: ResupplySupabaseClient;
  conversationId: string;
  body: string;
  senderRole?: "admin" | "agent";
}): Promise<AppendAdminInAppReplyOutcome> {
  const { data: conv, error: convErr } = await input.supabase
    .schema("resupply")
    .from("conversations")
    .select("id, channel, status, customer_id")
    .eq("id", input.conversationId)
    .limit(1)
    .maybeSingle();
  if (convErr) throw convErr;
  if (!conv) return { status: "conversation_not_found" };
  if (conv.channel !== "in_app") return { status: "wrong_channel" };
  if (conv.status === "closed") return { status: "conversation_closed" };
  if (!conv.customer_id) {
    // CHECK constraint guarantees customer_id is set when channel=in_app,
    // but defensive null-check keeps downstream code (notification
    // email) safe to assume non-null.
    return { status: "missing_customer_id" };
  }

  const nowIso = new Date().toISOString();
  const { data: inserted, error: insertErr } = await input.supabase
    .schema("resupply")
    .from("messages")
    .insert({
      conversation_id: conv.id,
      direction: "outbound",
      sender_role: input.senderRole ?? "admin",
      body: input.body,
      sent_at: nowIso,
    })
    .select("id")
    .limit(1)
    .maybeSingle();
  if (insertErr) throw insertErr;
  if (!inserted) throw new Error("messages insert returned no rows");

  const { error: bumpErr } = await input.supabase
    .schema("resupply")
    .from("conversations")
    .update({
      last_message_at: nowIso,
      status: "awaiting_patient",
      updated_at: nowIso,
    })
    .eq("id", conv.id);
  if (bumpErr) throw bumpErr;

  return { status: "ok", result: { messageId: inserted.id } };
}

/**
 * Resolve the customer_id of an in-app conversation — used by the
 * admin-side reply route to figure out who to email. Returns null
 * when the conversation isn't in-app or doesn't exist.
 */
export async function getInAppConversationCustomerId(input: {
  supabase: ResupplySupabaseClient;
  conversationId: string;
}): Promise<string | null> {
  const { data, error } = await input.supabase
    .schema("resupply")
    .from("conversations")
    .select("customer_id")
    .eq("id", input.conversationId)
    .eq("channel", "in_app")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.customer_id ?? null;
}
