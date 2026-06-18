// Platform support queue (requirePlatformAdmin, cross-tenant).
//
//   GET  /platform/support/tickets             — every tenant's tickets
//   GET  /platform/support/tickets/:id         — one ticket + thread
//   POST /platform/support/tickets/:id/reply   — operator replies
//   POST /platform/support/tickets/:id/status  — change a ticket's status
//
// The human side of the support system: where the platform operator works
// the tickets the intake bot escalated (`awaiting_platform`). Reads/writes
// the GLOBAL ticket tables via the `.raw()` escape hatch (same pattern as
// the rest of /platform), since a platform admin operates across tenants.
//
// PHI/logging: never log a ticket/message body. Audit rows carry the
// ticket id + status only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

const TICKET_COLS =
  "id, org_id, subject, status, bot_answered, bot_confidence, created_by_email, created_at, updated_at, last_activity_at";
const MESSAGE_COLS = "id, author_role, author_email, body, created_at";

type RawClient = ReturnType<ReturnType<typeof getOrgScopedClient>["raw"]>;

interface TicketRow {
  id: string;
  org_id: string;
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
interface OrgNameRow {
  id: string;
  slug: string;
  name: string | null;
}

function ticketView(t: TicketRow, org?: OrgNameRow) {
  return {
    id: t.id,
    orgId: t.org_id,
    subject: t.subject,
    status: t.status,
    botAnswered: t.bot_answered,
    botConfidence: t.bot_confidence == null ? null : Number(t.bot_confidence),
    createdByEmail: t.created_by_email,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    lastActivityAt: t.last_activity_at,
    tenant: org ? { slug: org.slug, name: org.name } : null,
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

const ticketIdParam = z.object({ id: z.string().uuid() });
const STATUSES = [
  "open",
  "awaiting_tenant",
  "awaiting_platform",
  "resolved",
  "closed",
] as const;
const listQuery = z.object({ status: z.enum(STATUSES).optional() });
const replyBody = z.object({ body: z.string().trim().min(1).max(6000) });
const statusBody = z.object({ status: z.enum(STATUSES) });

async function rawClient(): Promise<RawClient | null> {
  const seedOrgId = await resolveSeedOrgId();
  return seedOrgId ? getOrgScopedClient(seedOrgId).raw() : null;
}

/** Resolve org slug/name for a set of org ids (one query). */
async function orgsByIds(
  raw: RawClient,
  orgIds: string[],
): Promise<Map<string, OrgNameRow>> {
  const map = new Map<string, OrgNameRow>();
  if (orgIds.length === 0) return map;
  const { data } = await raw
    .schema("resupply")
    .from("organizations")
    .select("id, slug, name")
    .in("id", orgIds);
  for (const o of (data ?? []) as OrgNameRow[]) map.set(o.id, o);
  return map;
}

router.get(
  "/platform/support/tickets",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    let q = raw
      .schema("resupply")
      .from("support_tickets")
      .select(TICKET_COLS)
      .order("last_activity_at", { ascending: false })
      .limit(300);
    if (parsed.data.status) q = q.eq("status", parsed.data.status);
    const { data, error } = await q;
    if (error) {
      logger.error(
        { event: "platform_support_list_failed", err: error },
        "platform support: ticket list failed",
      );
      res.status(500).json({ error: "ticket_list_failed" });
      return;
    }
    const rows = (data ?? []) as TicketRow[];
    const orgs = await orgsByIds(raw, [...new Set(rows.map((r) => r.org_id))]);

    // Status tallies for the queue badges (computed from the capped page).
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;

    res.json({
      tickets: rows.map((t) => ticketView(t, orgs.get(t.org_id))),
      counts,
    });
  },
);

router.get(
  "/platform/support/tickets/:id",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = ticketIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_ticket_id" });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data: ticket, error } = await raw
      .schema("resupply")
      .from("support_tickets")
      .select(TICKET_COLS)
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "ticket_read_failed" });
      return;
    }
    if (!ticket) {
      res.status(404).json({ error: "ticket_not_found" });
      return;
    }
    const t = ticket as TicketRow;
    const [{ data: messages }, orgs] = await Promise.all([
      raw
        .schema("resupply")
        .from("support_ticket_messages")
        .select(MESSAGE_COLS)
        .eq("ticket_id", t.id)
        .order("created_at", { ascending: true })
        .limit(500),
      orgsByIds(raw, [t.org_id]),
    ]);
    res.json({
      ticket: ticketView(t, orgs.get(t.org_id)),
      messages: ((messages ?? []) as MessageRow[]).map(messageView),
    });
  },
);

/** Load a ticket's id/org_id/status, 404-ing a missing id. */
async function loadTicket(
  raw: RawClient,
  id: string,
): Promise<{ id: string; org_id: string; status: string } | null> {
  const { data } = await raw
    .schema("resupply")
    .from("support_tickets")
    .select("id, org_id, status")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  return (
    (data as { id: string; org_id: string; status: string } | null) ?? null
  );
}

router.post(
  "/platform/support/tickets/:id/reply",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const params = ticketIdParam.safeParse(req.params);
    const parsed = replyBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "invalid_reply" });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const ticket = await loadTicket(raw, params.data.id);
    if (!ticket) {
      res.status(404).json({ error: "ticket_not_found" });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: mErr } = await raw
      .schema("resupply")
      .from("support_ticket_messages")
      .insert({
        ticket_id: ticket.id,
        org_id: ticket.org_id,
        author_role: "platform",
        author_email: req.platformAdminEmail ?? null,
        body: parsed.data.body,
      });
    if (mErr) {
      res.status(500).json({ error: "reply_failed" });
      return;
    }
    const { data: updated, error: uErr } = await raw
      .schema("resupply")
      .from("support_tickets")
      .update({
        status: "awaiting_tenant",
        updated_at: nowIso,
        last_activity_at: nowIso,
      })
      .eq("id", ticket.id)
      .select(TICKET_COLS)
      .single();
    if (uErr || !updated) {
      res.status(500).json({ error: "ticket_update_failed" });
      return;
    }
    await logAudit({
      action: "platform.support.replied",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "support_tickets",
      targetId: ticket.id,
      metadata: { status: "awaiting_tenant" },
      ip: null,
      userAgent: null,
    }).catch(() => {});

    const { data: messages } = await raw
      .schema("resupply")
      .from("support_ticket_messages")
      .select(MESSAGE_COLS)
      .eq("ticket_id", ticket.id)
      .order("created_at", { ascending: true })
      .limit(500);
    res.json({
      ticket: ticketView(updated as TicketRow),
      messages: ((messages ?? []) as MessageRow[]).map(messageView),
    });
  },
);

router.post(
  "/platform/support/tickets/:id/status",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const params = ticketIdParam.safeParse(req.params);
    const parsed = statusBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await raw
      .schema("resupply")
      .from("support_tickets")
      .update({
        status: parsed.data.status,
        updated_at: nowIso,
        last_activity_at: nowIso,
      })
      .eq("id", params.data.id)
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
    await logAudit({
      action: "platform.support.status_changed",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "support_tickets",
      targetId: params.data.id,
      metadata: { status: parsed.data.status },
      ip: null,
      userAgent: null,
    }).catch(() => {});
    res.json({ ticket: ticketView(updated as TicketRow) });
  },
);

export default router;
