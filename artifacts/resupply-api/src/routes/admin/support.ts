// Tenant-facing support tickets (requireAdmin, org-scoped).
//
//   POST /admin/support/tickets               — file a ticket; the intake
//                                                bot answers on the spot
//   GET  /admin/support/tickets               — this tenant's tickets
//   GET  /admin/support/tickets/:id           — one ticket + its thread
//   POST /admin/support/tickets/:id/messages  — add a follow-up message
//   POST /admin/support/tickets/:id/resolve   — mark a ticket resolved
//
// A tenant admin files a support request to the platform operator. On
// create, the intake bot (lib/support-bot) tries to answer from the
// admin-console knowledge base; a confident answer is posted immediately
// (status → awaiting_tenant, bot_answered) and anything else escalates to
// the platform support queue (status → awaiting_platform). Follow-up
// messages always go to a human.
//
// Every read/write is through the org-scoped Supabase facade, which
// appends `org_id` automatically — a tenant can only ever see or touch
// its own tickets. Gated by the `support.tickets` feature flag.
//
// PHI/logging: ticket bodies can contain whatever staff type — never log
// a body. Log lines carry ids/status/counts only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { answerSupportTicket } from "../../lib/support-bot/support-bot";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const TICKET_COLS =
  "id, subject, status, bot_answered, bot_confidence, created_by_email, created_at, updated_at, last_activity_at";
const MESSAGE_COLS = "id, author_role, author_email, body, created_at";

interface TicketRow {
  id: string;
  subject: string;
  status: string;
  bot_answered: boolean;
  bot_confidence: number | string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}
interface MessageRow {
  id: string;
  author_role: string;
  author_email: string | null;
  body: string;
  created_at: string;
}

function ticketView(t: TicketRow) {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    botAnswered: t.bot_answered,
    botConfidence: t.bot_confidence == null ? null : Number(t.bot_confidence),
    createdByEmail: t.created_by_email,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    lastActivityAt: t.last_activity_at,
  };
}
function messageView(m: MessageRow) {
  return {
    id: m.id,
    authorRole: m.author_role,
    authorEmail: m.author_email,
    body: m.body,
    createdAt: m.created_at,
  };
}

const createBody = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(6000),
});
const followupBody = z.object({
  body: z.string().trim().min(1).max(6000),
});
const ticketIdParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  status: z
    .enum([
      "open",
      "awaiting_tenant",
      "awaiting_platform",
      "resolved",
      "closed",
    ])
    .optional(),
});

/** Shared feature-flag gate. Returns true when the route may proceed. */
async function ensureEnabled(
  orgId: string | undefined,
  res: import("express").Response,
): Promise<boolean> {
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return false;
  }
  if (!(await isFeatureEnabled("support.tickets", orgId))) {
    res.status(403).json({ error: "feature_disabled" });
    return false;
  }
  return true;
}

router.post(
  "/admin/support/tickets",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!(await ensureEnabled(req.orgId, res))) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_ticket" });
      return;
    }
    const { subject, body } = parsed.data;
    const orgId = req.orgId as string;
    const db = getOrgScopedClient(orgId);

    // Ask the intake bot first so the ticket lands with its final status
    // (no extra UPDATE round-trip). Never throws.
    const bot = await answerSupportTicket({
      subject,
      body,
      adminEmail: req.adminEmail ?? null,
      adminRole: req.adminRole ?? null,
    });
    const answered = bot.kind === "answer";
    const status = answered ? "awaiting_tenant" : "awaiting_platform";

    const { data: ticket, error: tErr } = await db
      .from("support_tickets")
      .insert({
        subject,
        status,
        created_by_email: req.adminEmail ?? null,
        created_by_user_id: req.adminUserId ?? null,
        bot_answered: answered,
        bot_confidence: answered ? bot.confidence : null,
      })
      .select(TICKET_COLS)
      .single();
    if (tErr || !ticket) {
      logger.error(
        { event: "support_ticket_create_failed", err: tErr },
        "support: ticket insert failed",
      );
      res.status(500).json({ error: "ticket_create_failed" });
      return;
    }
    const ticketId = (ticket as TicketRow).id;

    // The tenant's opening message, then the bot's answer (if any). The
    // bot message is best-effort — a failed insert leaves the ticket +
    // tenant message intact rather than failing the create.
    const inserts: Array<Record<string, unknown>> = [
      {
        ticket_id: ticketId,
        author_role: "tenant",
        author_email: req.adminEmail ?? null,
        body,
      },
    ];
    if (answered) {
      inserts.push({
        ticket_id: ticketId,
        author_role: "bot",
        author_email: null,
        body: bot.reply,
      });
    }
    const { data: messages, error: mErr } = await db
      .from("support_ticket_messages")
      .insert(inserts)
      .select(MESSAGE_COLS);
    if (mErr) {
      logger.error(
        { event: "support_ticket_messages_failed", err: mErr, ticketId },
        "support: ticket message insert failed",
      );
    }

    logger.info(
      {
        event: "support_ticket_created",
        ticketId,
        botAnswered: answered,
        botOffline: bot.kind === "offline",
      },
      "support: ticket created",
    );
    res.status(201).json({
      ticket: ticketView(ticket as TicketRow),
      messages: ((messages ?? []) as MessageRow[])
        .slice()
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(messageView),
      botOffline: bot.kind === "offline",
    });
  },
);

router.get(
  "/admin/support/tickets",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!(await ensureEnabled(req.orgId, res))) return;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const db = getOrgScopedClient(req.orgId as string);
    let q = db
      .from("support_tickets")
      .select(TICKET_COLS)
      .order("last_activity_at", { ascending: false })
      .limit(200);
    if (parsed.data.status) q = q.eq("status", parsed.data.status);
    const { data, error } = await q;
    if (error) {
      logger.error(
        { event: "support_ticket_list_failed", err: error },
        "support: ticket list failed",
      );
      res.status(500).json({ error: "ticket_list_failed" });
      return;
    }
    res.json({ tickets: ((data ?? []) as TicketRow[]).map(ticketView) });
  },
);

router.get(
  "/admin/support/tickets/:id",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!(await ensureEnabled(req.orgId, res))) return;
    const parsed = ticketIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_ticket_id" });
      return;
    }
    const db = getOrgScopedClient(req.orgId as string);
    const { data: ticket, error: tErr } = await db
      .from("support_tickets")
      .select(TICKET_COLS)
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (tErr) {
      res.status(500).json({ error: "ticket_read_failed" });
      return;
    }
    if (!ticket) {
      res.status(404).json({ error: "ticket_not_found" });
      return;
    }
    const { data: messages } = await db
      .from("support_ticket_messages")
      .select(MESSAGE_COLS)
      .eq("ticket_id", parsed.data.id)
      .order("created_at", { ascending: true })
      .limit(500);
    res.json({
      ticket: ticketView(ticket as TicketRow),
      messages: ((messages ?? []) as MessageRow[]).map(messageView),
    });
  },
);

router.post(
  "/admin/support/tickets/:id/messages",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!(await ensureEnabled(req.orgId, res))) return;
    const params = ticketIdParam.safeParse(req.params);
    const parsed = followupBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "invalid_message" });
      return;
    }
    const db = getOrgScopedClient(req.orgId as string);
    const ticketId = params.data.id;

    const { data: existing, error: exErr } = await db
      .from("support_tickets")
      .select("id, status")
      .eq("id", ticketId)
      .limit(1)
      .maybeSingle();
    if (exErr) {
      res.status(500).json({ error: "ticket_read_failed" });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "ticket_not_found" });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: mErr } = await db.from("support_ticket_messages").insert({
      ticket_id: ticketId,
      author_role: "tenant",
      author_email: req.adminEmail ?? null,
      body: parsed.data.body,
    });
    if (mErr) {
      res.status(500).json({ error: "message_create_failed" });
      return;
    }
    // A tenant follow-up always goes to a human (we don't loop the bot on
    // follow-ups) unless the ticket was already resolved/closed.
    const nextStatus =
      existing.status === "resolved" || existing.status === "closed"
        ? existing.status
        : "awaiting_platform";
    const { data: updated, error: uErr } = await db
      .from("support_tickets")
      .update({
        status: nextStatus,
        updated_at: nowIso,
        last_activity_at: nowIso,
      })
      .eq("id", ticketId)
      .select(TICKET_COLS)
      .single();
    if (uErr || !updated) {
      res.status(500).json({ error: "ticket_update_failed" });
      return;
    }
    const { data: messages } = await db
      .from("support_ticket_messages")
      .select(MESSAGE_COLS)
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true })
      .limit(500);
    res.json({
      ticket: ticketView(updated as TicketRow),
      messages: ((messages ?? []) as MessageRow[]).map(messageView),
    });
  },
);

router.post(
  "/admin/support/tickets/:id/resolve",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res): Promise<void> => {
    if (!(await ensureEnabled(req.orgId, res))) return;
    const parsed = ticketIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_ticket_id" });
      return;
    }
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await getOrgScopedClient(
      req.orgId as string,
    )
      .from("support_tickets")
      .update({
        status: "resolved",
        updated_at: nowIso,
        last_activity_at: nowIso,
      })
      .eq("id", parsed.data.id)
      .select(TICKET_COLS)
      .limit(1)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "ticket_update_failed" });
      return;
    }
    if (!updated) {
      res.status(404).json({ error: "ticket_not_found" });
      return;
    }
    res.json({ ticket: ticketView(updated as TicketRow) });
  },
);

export default router;
