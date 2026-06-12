// /admin/outbound-messages — outbound SMS / email send log.
//
// One paginated, filterable feed of every outbound message row with its
// delivery result, so admins can answer "did that text/email actually
// go out, and what happened to it?" without opening each conversation.
//
// Source: `resupply.messages` where `direction = 'outbound'`, joined to
// the parent conversation for the channel (sms / email) and patient.
// `delivery_status` is stamped asynchronously by the Twilio status
// callback (/sms/status-callback) and the SendGrid event webhook
// (/email/sendgrid-events); rows the vendor hasn't reported on yet have
// a NULL status and surface here as "pending".
//
// Each raw status is collapsed into one of four result buckets:
//   delivered — vendor confirmed receipt ('delivered')
//   sent      — vendor accepted, no receipt confirmation yet ('sent')
//   failed    — terminal failure ('failed', 'undelivered', 'bounced',
//               'dropped', 'rejected', 'spam_report')
//   pending   — everything else (NULL, 'deferred', 'sending', …)
//
// Recall-notification texts are not in `messages` (they're stamped on
// `recall_notifications`); their failures surface on
// /admin/delivery-failures and the recall roster.
//
// Gate: `admin.tools.manage` — admin / super-admin only, per the ask
// that this log be a supervisory surface rather than a CSR one.
//
// PHI: message bodies are NOT surfaced — like /admin/delivery-failures,
// this view needs the outcome, not the content. Patient name + ID are
// surfaced (already permitted across the admin console).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const FAILED_STATUSES = [
  "failed",
  "undelivered",
  "bounced",
  "dropped",
  "rejected",
  "spam_report",
] as const;
const DELIVERED_STATUSES = ["delivered"] as const;
const SENT_STATUSES = ["sent"] as const;
// Statuses that resolve to a non-"pending" bucket. Anything outside
// this list (NULL, 'deferred', 'sending', future vendor strings) is
// in-flight as far as this log is concerned.
const RESOLVED_STATUSES = [
  ...DELIVERED_STATUSES,
  ...SENT_STATUSES,
  ...FAILED_STATUSES,
];

export type ResultBucket = "delivered" | "sent" | "failed" | "pending";

function bucketFor(status: string | null): ResultBucket {
  if (status === "delivered") return "delivered";
  if (status === "sent") return "sent";
  if ((FAILED_STATUSES as readonly string[]).includes(status ?? ""))
    return "failed";
  return "pending";
}

const DEFAULT_DAYS_BACK = 14;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const listQuery = z
  .object({
    channel: z.enum(["sms", "email"]).optional(),
    result: z.enum(["delivered", "sent", "failed", "pending"]).optional(),
    sinceDays: z.coerce.number().int().min(1).max(90).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  })
  .strict();

router.get(
  "/admin/outbound-messages",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const { channel, result } = parsed.data;
    const sinceDays = parsed.data.sinceDays ?? DEFAULT_DAYS_BACK;
    const limit = parsed.data.limit ?? DEFAULT_LIMIT;
    const offset = parsed.data.offset ?? 0;
    const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

    const supabase = getSupabaseServiceRoleClient();

    // PostgREST's string-literal type parser can't follow the nested
    // embed, so the row shape is supplied explicitly.
    interface OutboundRow {
      id: string;
      conversation_id: string;
      sender_role: string;
      delivery_status: string | null;
      delivery_error: string | null;
      sent_at: string | null;
      delivered_at: string | null;
      created_at: string;
      conversations: {
        channel: string;
        patient_id: string | null;
        patients: {
          legal_first_name: string | null;
          legal_last_name: string | null;
        } | null;
      } | null;
    }

    // The channel lives on the conversation, so every query joins
    // through `conversations!inner` — that also drops voice/chat
    // threads, keeping this an SMS + email log.
    let query = supabase
      .schema("resupply")
      .from("messages")
      .select<string, OutboundRow>(
        "id, conversation_id, sender_role, delivery_status, delivery_error, sent_at, delivered_at, created_at, " +
          "conversations!inner(channel, patient_id, patients(legal_first_name, legal_last_name))",
        { count: "exact" },
      )
      .eq("direction", "outbound")
      .gte("created_at", since);
    query = channel
      ? query.eq("conversations.channel", channel)
      : query.in("conversations.channel", ["sms", "email"]);
    if (result === "delivered") {
      query = query.in("delivery_status", [...DELIVERED_STATUSES]);
    } else if (result === "sent") {
      query = query.in("delivery_status", [...SENT_STATUSES]);
    } else if (result === "failed") {
      query = query.in("delivery_status", [...FAILED_STATUSES]);
    } else if (result === "pending") {
      // NULL never matches `not.in`, so the pending bucket needs the
      // explicit is-null arm (same pattern as /sms/status-callback).
      query = query.or(
        `delivery_status.is.null,delivery_status.not.in.(${RESOLVED_STATUSES.join(",")})`,
      );
    }
    const {
      data: rows,
      count: total,
      error,
    } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    // Window-wide result counts (ignoring the result filter, honoring
    // channel + window) for the summary strip. Sequential head-only
    // counts — bounded, four cheap round-trips.
    const buildCountQuery = () => {
      const base = supabase
        .schema("resupply")
        .from("messages")
        .select<string, never>("id, conversations!inner(channel)", {
          count: "exact",
          head: true,
        })
        .eq("direction", "outbound")
        .gte("created_at", since);
      return channel
        ? base.eq("conversations.channel", channel)
        : base.in("conversations.channel", ["sms", "email"]);
    };
    type CountQuery = ReturnType<typeof buildCountQuery>;
    const countWhere = async (
      apply: (q: CountQuery) => CountQuery,
    ): Promise<number> => {
      const { count, error: countErr } = await apply(buildCountQuery());
      if (countErr) throw countErr;
      return count ?? 0;
    };
    const counts = {
      delivered: await countWhere((q) =>
        q.in("delivery_status", [...DELIVERED_STATUSES]),
      ),
      sent: await countWhere((q) =>
        q.in("delivery_status", [...SENT_STATUSES]),
      ),
      failed: await countWhere((q) =>
        q.in("delivery_status", [...FAILED_STATUSES]),
      ),
      pending: await countWhere((q) =>
        q.or(
          `delivery_status.is.null,delivery_status.not.in.(${RESOLVED_STATUSES.join(",")})`,
        ),
      ),
    };

    const items = (rows ?? []).map((r) => {
      const conv = r.conversations;
      const fullName = conv?.patients
        ? [conv.patients.legal_first_name, conv.patients.legal_last_name]
            .filter(Boolean)
            .join(" ")
            .trim()
        : "";
      return {
        id: r.id,
        occurredAt: r.sent_at ?? r.created_at,
        channel: conv?.channel ?? null,
        senderRole: r.sender_role,
        deliveryStatus: r.delivery_status,
        deliveryError: r.delivery_error,
        deliveredAt: r.delivered_at,
        result: bucketFor(r.delivery_status),
        conversationId: r.conversation_id,
        patientId: conv?.patient_id ?? null,
        patientName: fullName || null,
      };
    });

    return res.json({
      sinceDays,
      channel: channel ?? "all",
      result: result ?? "all",
      limit,
      offset,
      total: total ?? 0,
      counts,
      items,
    });
  },
);

export default router;
