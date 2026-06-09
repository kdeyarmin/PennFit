// GET /admin/email-inbox — the email inbox, split into two mailboxes.
//
// A focused view over `channel='email'` conversations for the admin
// console's Email Inbox page. Two mailboxes, selected by `?mailbox=`:
//
//   - `needs_response` (default) → conversations the chatbot handed off
//     (or never auto-answered): `status='awaiting_admin'`. These are the
//     emails a human still owes a reply to.
//   - `responded`                → emails already answered, whether by
//     the chatbot auto-reply or a human: `status IN ('awaiting_patient',
//     'closed')`.
//
// Each item is enriched with the email subject + a short preview of the
// most recent message and whether that reply was the bot's auto-reply,
// so the list reads like a mail client without opening each thread. The
// full thread + reply box reuse the existing `/conversations/:id`
// (detail) and `/conversations/:id/reply` endpoints — this route only
// supplies the mailbox listing + unread-style counts.
//
// PHI posture: mirrors the patient list's last-message preview
// (`patient_latest_message.last_message_preview`) — a short body snippet
// crosses the wire in the list, but the per-message audit row is written
// by the detail view when the thread is opened, not on a page flip.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const MAILBOX_STATUSES = {
  needs_response: ["awaiting_admin"],
  responded: ["awaiting_patient", "closed"],
} as const;

const PREVIEW_MAX_CHARS = 140;
// Bound the bulk message fetch used for per-conversation enrichment.
// A page is at most 100 conversations; email threads are short, so this
// comfortably covers the latest message + latest subject per thread.
const MESSAGE_SCAN_LIMIT = 1_000;

const listQuery = z
  .object({
    mailbox: z
      .enum(["needs_response", "responded"])
      .optional()
      .default("needs_response"),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const router: IRouter = Router();

router.get(
  "/admin/email-inbox",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { mailbox, limit, offset } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();

    // Page of email conversations for the selected mailbox. Newest
    // activity first; brand-new threads (no messages yet) fall back to
    // createdAt order.
    const {
      data: rows,
      count,
      error,
    } = await supabase
      .schema("resupply")
      .from("conversations")
      .select(
        "id, patient_id, episode_id, status, last_message_at, created_at",
        { count: "exact" },
      )
      .eq("channel", "email")
      .in("status", [...MAILBOX_STATUSES[mailbox]])
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    const conversationRows = rows ?? [];
    const conversationIds = conversationRows.map((r) => r.id);
    const patientIds = Array.from(
      new Set(
        conversationRows
          .map((r) => r.patient_id)
          .filter((v): v is string => v !== null),
      ),
    );

    // Bulk-fetch identity + the messages for this page's threads, plus
    // the two mailbox counts (for the nav/tab badges). PostgREST has no
    // JOIN, so identity and message enrichment are separate round-trips.
    const [patientsRes, messagesRes, needsCountRes, respondedCountRes] =
      await Promise.all([
        patientIds.length > 0
          ? supabase
              .schema("resupply")
              .from("patients")
              .select("id, legal_first_name, legal_last_name, email")
              .in("id", patientIds)
          : Promise.resolve({ data: [], error: null } as const),
        conversationIds.length > 0
          ? supabase
              .schema("resupply")
              .from("messages")
              .select(
                "conversation_id, direction, sender_role, body, vendor_metadata, created_at",
              )
              .in("conversation_id", conversationIds)
              .order("created_at", { ascending: false })
              .limit(MESSAGE_SCAN_LIMIT)
          : Promise.resolve({ data: [], error: null } as const),
        countEmailConversations(supabase, MAILBOX_STATUSES.needs_response),
        countEmailConversations(supabase, MAILBOX_STATUSES.responded),
      ]);
    if (patientsRes.error) throw patientsRes.error;
    if (messagesRes.error) throw messagesRes.error;

    const patientsById = new Map(
      (patientsRes.data ?? []).map((p) => [p.id, p] as const),
    );

    // Reduce the messages (already newest-first) into per-conversation
    // enrichment: the latest message (preview + who sent it + whether it
    // was the bot's auto-reply) and the most recent email subject.
    const enrichmentByConversation = buildEnrichment(
      (messagesRes.data ?? []) as MessageRow[],
    );

    res.status(200).json({
      mailbox,
      items: conversationRows.map((r) => {
        const pt = r.patient_id ? patientsById.get(r.patient_id) : undefined;
        const enrich = enrichmentByConversation.get(r.id);
        return {
          id: r.id,
          patientId: r.patient_id,
          patientFirstName: pt?.legal_first_name ?? "",
          patientLastName: pt?.legal_last_name ?? "",
          patientEmail: pt?.email ?? null,
          episodeId: r.episode_id,
          status: r.status,
          subject: enrich?.subject ?? null,
          lastMessageAt: r.last_message_at,
          createdAt: r.created_at,
          lastMessagePreview: enrich?.preview ?? null,
          lastMessageDirection: enrich?.direction ?? null,
          lastMessageSenderRole: enrich?.senderRole ?? null,
          lastMessageAutoReply: enrich?.autoReply ?? false,
        };
      }),
      total: count ?? 0,
      limit,
      offset,
      counts: {
        needsResponse: needsCountRes,
        responded: respondedCountRes,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

/** Head-only count of email conversations in the given status set. */
async function countEmailConversations(
  supabase: SupabaseClient,
  statuses: readonly string[],
): Promise<number> {
  const { count, error } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("channel", "email")
    .in("status", [...statuses]);
  if (error) throw error;
  return count ?? 0;
}

interface MessageRow {
  conversation_id: string;
  direction: string;
  sender_role: string;
  body: string | null;
  vendor_metadata: unknown;
  created_at: string;
}

interface ConversationEnrichment {
  subject: string | null;
  preview: string | null;
  direction: string | null;
  senderRole: string | null;
  autoReply: boolean;
}

/**
 * Collapse a newest-first message stream into per-conversation
 * enrichment. The FIRST row seen for a conversation is its latest
 * message (preview + sender + auto-reply flag); the first row that
 * carries a non-empty `vendor_metadata.subject` is its email subject.
 */
function buildEnrichment(
  rows: MessageRow[],
): Map<string, ConversationEnrichment> {
  const out = new Map<string, ConversationEnrichment>();
  for (const m of rows) {
    let e = out.get(m.conversation_id);
    if (!e) {
      e = {
        subject: null,
        preview: null,
        direction: null,
        senderRole: null,
        autoReply: false,
      };
      out.set(m.conversation_id, e);
    }
    // Latest message wins (rows are newest-first, so the first one we
    // see per conversation is the latest).
    if (e.preview === null && e.direction === null) {
      e.preview = preview(m.body);
      e.direction = m.direction;
      e.senderRole = m.sender_role;
      e.autoReply = readAutoReplyFlag(m.vendor_metadata);
    }
    if (e.subject === null) {
      const subj = readSubject(m.vendor_metadata);
      if (subj) e.subject = subj;
    }
  }
  return out;
}

function preview(body: string | null): string | null {
  if (!body) return null;
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > PREVIEW_MAX_CHARS
    ? trimmed.slice(0, PREVIEW_MAX_CHARS) + "…"
    : trimmed;
}

function readSubject(vendorMetadata: unknown): string | null {
  if (vendorMetadata && typeof vendorMetadata === "object") {
    const subj = (vendorMetadata as { subject?: unknown }).subject;
    if (typeof subj === "string" && subj.trim() !== "") return subj.trim();
  }
  return null;
}

function readAutoReplyFlag(vendorMetadata: unknown): boolean {
  if (vendorMetadata && typeof vendorMetadata === "object") {
    return (vendorMetadata as { auto_reply?: unknown }).auto_reply === true;
  }
  return false;
}

export default router;
