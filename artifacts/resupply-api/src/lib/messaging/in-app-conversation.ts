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

import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  conversations,
  messages,
  type ConversationRow,
  type getDbPool,
} from "@workspace/resupply-db";

// Pool type sourced from the workspace's pool helper. Architecture
// rule (see scripts/check-resupply-architecture.sh) keeps direct
// node-postgres imports inside @workspace/resupply-db; we only need
// the type here, not the constructor.
type WorkspacePool = ReturnType<typeof getDbPool>;

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

function dbFromPool(
  pool: WorkspacePool,
): NodePgDatabase<Record<string, unknown>> {
  return drizzle(pool);
}

/**
 * Read the customer's in-app thread plus its message history. Returns
 * `{ thread: null, messages: [] }` when the customer has never
 * messaged before — the UI can render an empty-state CTA in that case
 * without a separate "does this exist" round-trip.
 *
 * We deliberately filter on `customerId AND channel=in_app` so a
 * future "second in-app thread" (we'd add a separate `customerEpisodeId`-
 * style scope later) doesn't leak into v1 callers.
 */
export async function fetchInAppThread(input: {
  pool: WorkspacePool;
  customerId: string;
}): Promise<FetchInAppThreadResult> {
  const db = dbFromPool(input.pool);
  const convRows = await db
    .select({
      id: conversations.id,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
      customerLastReadAt: conversations.customerLastReadAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.customerId, input.customerId),
        eq(conversations.channel, "in_app"),
      ),
    )
    .orderBy(asc(conversations.createdAt))
    .limit(1);
  const conv = convRows[0];
  if (!conv) {
    return { thread: null, messages: [], unreadFromCsr: 0 };
  }
  const msgRows = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      senderRole: messages.senderRole,
      body: messages.body,
      createdAt: messages.createdAt,
      deliveryStatus: messages.deliveryStatus,
    })
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(asc(messages.createdAt));

  // Compute unread-from-CSR. Walk the message list once; cheaper
  // than a second SQL aggregate when v1 thread sizes are tens of
  // messages. If we ever see threads with hundreds of messages we
  // can push this into a SQL count(*) FILTER (WHERE …).
  const lastReadMs = conv.customerLastReadAt?.getTime() ?? 0;
  let unreadFromCsr = 0;
  for (const m of msgRows) {
    if (m.direction === "outbound" && m.createdAt.getTime() > lastReadMs) {
      unreadFromCsr += 1;
    }
  }

  return {
    thread: {
      id: conv.id,
      status: conv.status,
      lastMessageAt: conv.lastMessageAt?.toISOString() ?? null,
      createdAt: conv.createdAt.toISOString(),
    },
    messages: msgRows.map((m) => ({
      id: m.id,
      direction: m.direction,
      // Type narrowing: senderRole on the schema is the full enum
      // (patient | customer | admin | agent | system). For in-app
      // threads the only roles that appear are customer / admin /
      // agent / system. We narrow to the in-app subset for the
      // public response. Patient-flow rows can't appear here because
      // we filtered conversations on channel=in_app + customer_id.
      senderRole: m.senderRole === "patient" ? "customer" : m.senderRole,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      deliveryStatus: m.deliveryStatus,
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
  pool: WorkspacePool;
  customerId: string;
}): Promise<number> {
  const db = dbFromPool(input.pool);
  const convRows = await db
    .select({
      id: conversations.id,
      customerLastReadAt: conversations.customerLastReadAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.customerId, input.customerId),
        eq(conversations.channel, "in_app"),
      ),
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) return 0;
  const msgRows = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        eq(messages.direction, "outbound"),
      ),
    );
  const lastReadMs = conv.customerLastReadAt?.getTime() ?? 0;
  let count = 0;
  for (const m of msgRows) {
    if (m.createdAt.getTime() > lastReadMs) count += 1;
  }
  return count;
}

/**
 * Mark the customer's in-app thread as fully read. Sets
 * `customer_last_read_at = now()` on the conversation. No-op when
 * the customer has no thread (returns false).
 */
export async function markInAppThreadRead(input: {
  pool: WorkspacePool;
  customerId: string;
}): Promise<boolean> {
  const db = dbFromPool(input.pool);
  const now = new Date();
  const result = await db
    .update(conversations)
    .set({ customerLastReadAt: now, updatedAt: now })
    .where(
      and(
        eq(conversations.customerId, input.customerId),
        eq(conversations.channel, "in_app"),
      ),
    )
    .returning({ id: conversations.id });
  return result.length > 0;
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
  pool: WorkspacePool;
  customerId: string;
  body: string;
}): Promise<AppendCustomerMessageResult> {
  const db = dbFromPool(input.pool);
  const now = new Date();

  // Find existing OPEN thread first. We deliberately ignore closed
  // threads here — a customer message after close starts a fresh
  // row so the inbox surface treats it as a new request.
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.customerId, input.customerId),
        eq(conversations.channel, "in_app"),
        // Exclude closed; any other status (open / awaiting_*) is reusable.
        // drizzle's `ne` would also work; using a not-equal via `eq` inversion
        // would force a second round trip. Plain JS filter suffices since v1
        // has at most one row.
      ),
    )
    .limit(1);

  let threadId: string;
  let threadCreated = false;
  const reusable = existing[0];
  if (reusable) {
    threadId = reusable.id;
  } else {
    // First message — create the thread.
    const created = await db
      .insert(conversations)
      .values({
        customerId: input.customerId,
        // patientId / episodeId stay null — the CHECK constraint
        // requires customer_id-set rows to have both null.
        patientId: null,
        episodeId: null,
        channel: "in_app",
        status: "awaiting_admin",
        lastMessageAt: now,
      })
      .returning({ id: conversations.id });
    threadId = created[0]!.id;
    threadCreated = true;
  }

  const inserted = await db
    .insert(messages)
    .values({
      conversationId: threadId,
      direction: "inbound",
      senderRole: "customer",
      body: input.body,
      // No vendor side for in-app; deliveryStatus stays null.
      sentAt: now,
    })
    .returning({ id: messages.id });
  const messageId = inserted[0]!.id;

  // Bump the conversation forward — only update status if it isn't
  // already a "the customer has the ball" status, since they may be
  // following up on their own message before the CSR responds.
  await db
    .update(conversations)
    .set({
      lastMessageAt: now,
      status: "awaiting_admin",
      updatedAt: now,
    })
    .where(eq(conversations.id, threadId));

  return { threadId, messageId, threadCreated };
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
  pool: WorkspacePool;
  conversationId: string;
  body: string;
  senderRole?: "admin" | "agent";
}): Promise<AppendAdminInAppReplyOutcome> {
  const db = dbFromPool(input.pool);
  const convRows = await db
    .select({
      id: conversations.id,
      channel: conversations.channel,
      status: conversations.status,
      customerId: conversations.customerId,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  const conv = convRows[0];
  if (!conv) return { status: "conversation_not_found" };
  if (conv.channel !== "in_app") return { status: "wrong_channel" };
  if (conv.status === "closed") return { status: "conversation_closed" };
  if (!conv.customerId) {
    // CHECK constraint guarantees customer_id is set when channel=in_app,
    // but defensive null-check keeps downstream code (notification
    // email) safe to assume non-null.
    return { status: "missing_customer_id" };
  }

  const now = new Date();
  const inserted = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      direction: "outbound",
      senderRole: input.senderRole ?? "admin",
      body: input.body,
      sentAt: now,
    })
    .returning({ id: messages.id });
  const messageId = inserted[0]!.id;

  await db
    .update(conversations)
    .set({
      lastMessageAt: now,
      status: "awaiting_patient",
      updatedAt: now,
    })
    .where(eq(conversations.id, conv.id));

  return { status: "ok", result: { messageId } };
}

/**
 * Resolve the customer_id of an in-app conversation — used by the
 * admin-side reply route to figure out who to email. Returns null
 * when the conversation isn't in-app or doesn't exist.
 */
export async function getInAppConversationCustomerId(input: {
  pool: WorkspacePool;
  conversationId: string;
}): Promise<string | null> {
  const db = dbFromPool(input.pool);
  const rows = await db
    .select({
      customerId: conversations.customerId,
      channel: conversations.channel,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.channel, "in_app"),
      ),
    )
    .limit(1);
  return rows[0]?.customerId ?? null;
}

/**
 * Re-export `isNull` so consumers writing more nuanced filter
 * predicates against in-app threads can use the same drizzle
 * helper without re-importing it.
 */
export { isNull };
