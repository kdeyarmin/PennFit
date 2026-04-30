/**
 * Admin API — auth-gated endpoints for Penn staff.
 *
 * NOT exposed in the public OpenAPI spec on purpose: the public spec
 * advertises a stateless, no-PHI-stored service to patients. The admin
 * surface is an internal extension that lives off the same Express tree.
 *
 * Auth: every route runs through `requireAdmin`, which:
 *   1. Checks session
 *   2. Validates the signed-in user's email against PENN_ADMIN_EMAILS
 *
 * Audit: every route that returns full PHI (currently only the order
 * detail view) writes a row to admin_audit_log. List views return a
 * REDACTED summary (no insurance member id, no DOB, no street address)
 * and don't write audit rows.
 */

import { Router } from "express";
import { z } from "zod";
import {
  db,
  ordersTable,
  adminAuditLogTable,
  usageEventsTable,
  reminderSubscriptionsTable,
} from "@workspace/db";
import { desc, eq, ilike, or, and, sql, count, lte } from "drizzle-orm";
import { requireAdmin } from "../middlewares/requireAdmin.js";
import { logger } from "../lib/logger.js";
import { sendReminderDue, type ReminderItemForEmail } from "../lib/reminderEmail.js";
import adminUsersRouter from "./admin-users.js";

const router = Router();

// Scope requireAdmin to /admin/* only. Without a path prefix, this
// middleware would intercept every request that flows through this
// router (including unrelated /api/usage-events requests on the same
// parent router) and reject them with 401 — even though those routes
// are intentionally public.
router.use("/admin", requireAdmin);

// Team-management routes live in their own file (admin-users.ts) but
// share this router so they inherit the requireAdmin gate above. The
// individual mutating routes additionally apply requireAdminOnly
// internally so agents can read the roster but not modify it.
router.use(adminUsersRouter);

// ---------- GET /admin/orders ----------

const listOrdersQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["pending", "sent", "failed", "skipped"]).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

router.get("/admin/orders", async (req, res) => {
  const parsed = listOrdersQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.issues.map((i) => i.message) });
    return;
  }
  const { q, status, page, pageSize } = parsed.data;

  const conditions = [];
  if (q) {
    const like = `%${q}%`;
    conditions.push(
      or(
        ilike(ordersTable.patientFirstName, like),
        ilike(ordersTable.patientLastName, like),
        ilike(ordersTable.patientEmail, like),
        ilike(ordersTable.orderReference, like),
      )!,
    );
  }
  if (status) conditions.push(eq(ordersTable.emailStatus, status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: ordersTable.id,
        orderReference: ordersTable.orderReference,
        patientFirstName: ordersTable.patientFirstName,
        patientLastName: ordersTable.patientLastName,
        patientEmail: ordersTable.patientEmail,
        maskName: ordersTable.maskName,
        maskManufacturer: ordersTable.maskManufacturer,
        shippingCity: ordersTable.shippingCity,
        shippingState: ordersTable.shippingState,
        emailStatus: ordersTable.emailStatus,
        createdAt: ordersTable.createdAt,
      })
      .from(ordersTable)
      .where(where)
      .orderBy(desc(ordersTable.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(ordersTable).where(where),
  ]);

  // Every list-orders access is audited, not just searches. Even the
  // "redacted" summary view exposes patient first/last name and email,
  // which are PHI under HIPAA. The action string captures whichever
  // filter was applied so an investigator can reconstruct the exact
  // query without us also storing the full result set.
  if (req.adminEmail && req.adminUserId) {
    const filterParts: string[] = [];
    if (q) filterParts.push(`q=${q}`);
    if (status) filterParts.push(`status=${status}`);
    filterParts.push(`page=${page}`);
    const action = `list_orders${filterParts.length ? `:${filterParts.join("&")}` : ""}`;
    try {
      await db.insert(adminAuditLogTable).values({
        adminEmail: req.adminEmail,
        adminUserId: req.adminUserId,
        action,
        ip: req.ip ?? null,
      });
    } catch (err) {
      logger.error({ err }, "Failed to write audit log for list_orders");
    }
  }

  res.json({
    orders: rows,
    total: totalRow[0]?.value ?? 0,
    page,
    pageSize,
  });
});

// ---------- GET /admin/orders/:id ----------

router.get("/admin/orders/:id", async (req, res) => {
  const id = req.params.id;
  // Defensive uuid check (Drizzle would throw on a malformed id, surfacing
  // a less friendly 500 to the admin).
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }
  const [row] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  // Audit BEFORE returning. If the audit insert fails we still serve the
  // request (the admin shouldn't be locked out due to logging trouble),
  // but we surface it via server logs.
  if (req.adminEmail && req.adminUserId) {
    try {
      await db.insert(adminAuditLogTable).values({
        adminEmail: req.adminEmail,
        adminUserId: req.adminUserId,
        action: "view_order_detail",
        targetOrderId: row.id,
        ip: req.ip ?? null,
      });
    } catch (err) {
      logger.error({ err, orderId: row.id }, "Failed to write audit log for order view");
    }
  }

  res.json({ order: row });
});

// ---------- GET /admin/analytics ----------

router.get("/admin/analytics", async (_req, res) => {
  const [
    totalOrdersRow,
    statusBreakdown,
    maskBreakdown,
    funnelBreakdown,
  ] = await Promise.all([
    db.select({ value: count() }).from(ordersTable),
    db
      .select({ status: ordersTable.emailStatus, count: count() })
      .from(ordersTable)
      .groupBy(ordersTable.emailStatus),
    db
      .select({
        maskName: ordersTable.maskName,
        maskManufacturer: ordersTable.maskManufacturer,
        count: count(),
      })
      .from(ordersTable)
      .groupBy(ordersTable.maskName, ordersTable.maskManufacturer)
      .orderBy(desc(count()))
      .limit(10),
    db
      .select({ step: usageEventsTable.step, count: count() })
      .from(usageEventsTable)
      .groupBy(usageEventsTable.step),
  ]);

  // Recent orders (last 30 days, by day) for a sparkline
  const recentByDay = await db.execute(sql`
    SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
    FROM orders
    WHERE created_at > now() - interval '30 days'
    GROUP BY 1
    ORDER BY 1
  `);

  res.json({
    totalOrders: totalOrdersRow[0]?.value ?? 0,
    statusBreakdown,
    topMasks: maskBreakdown,
    funnel: funnelBreakdown,
    ordersByDay: recentByDay.rows,
  });
});

// ---------- GET /admin/audit-log ----------

const listAuditQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

router.get("/admin/audit-log", async (req, res) => {
  const parsed = listAuditQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const { page, pageSize } = parsed.data;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(adminAuditLogTable)
      .orderBy(desc(adminAuditLogTable.occurredAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(adminAuditLogTable),
  ]);

  res.json({ events: rows, total: totalRow[0]?.value ?? 0, page, pageSize });
});

// ---------- GET /admin/me ----------
// Tiny helper for the frontend to confirm "yes, you are authorized as admin"
// and display the admin email in the layout.
router.get("/admin/me", (req, res) => {
  // `role` drives whether the admin UI hides destructive UI
  // affordances (Delete buttons etc) for customer-service agents.
  // Default to "admin" if requireAdmin somehow didn't set it — a
  // belt-and-suspenders fallback so a refactor regression doesn't
  // silently downgrade real admins to agents.
  res.json({
    email: req.adminEmail,
    userId: req.adminUserId,
    role: req.adminRole ?? "admin",
  });
});

// ---------- GET /admin/reminders ----------
// List all reminder subscribers (active + unsubscribed). Includes per-item
// nextDueAt so the admin can see who's coming up. Not paginated yet — this
// is a small opt-in list, hundreds at most. Add pagination if it grows.
router.get("/admin/reminders", async (_req, res) => {
  const rows = await db
    .select()
    .from(reminderSubscriptionsTable)
    .orderBy(desc(reminderSubscriptionsTable.createdAt));
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    subscribers: rows.map((r) => {
      const items = (r.items ?? []) as Array<{
        sku: string;
        lastReplacedAt: string;
        intervalDays: number;
        nextDueAt: string;
      }>;
      const dueItems = items.filter((i) => i.nextDueAt <= today);
      return {
        id: r.id,
        email: r.email,
        status: r.status,
        items,
        itemCount: items.length,
        dueCount: dueItems.length,
        lastSentAt: r.lastSentAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    total: rows.length,
  });
});

// ---------- POST /admin/reminders/send-due ----------
// Dispatcher. Finds active subscriptions with at least one item whose
// nextDueAt <= today, and sends a reminder email listing the due items.
//
// Quiet period: 7 days. If we already emailed this subscriber within the
// last 7 days, skip them — even if a new item became due. This keeps the
// reminders firmly opt-in and non-spammy. Admin can re-trigger by manually
// clearing lastSentAt in the DB if a real-world urgent re-send is needed.
//
// We do NOT auto-advance lastReplacedAt on send — sending a reminder is
// not evidence the customer actually replaced the item. The customer
// updates their dates from the manage page after they actually swap.
const QUIET_PERIOD_DAYS = 7;

router.post("/admin/reminders/send-due", async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const quietCutoff = new Date(Date.now() - QUIET_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select()
    .from(reminderSubscriptionsTable)
    .where(eq(reminderSubscriptionsTable.status, "active"));

  let sent = 0;
  let skippedQuiet = 0;
  let skippedNoneDue = 0;
  let skippedNotConfigured = 0;
  let failed = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const row of candidates) {
    const items = (row.items ?? []) as ReminderItemForEmail[];
    const dueItems = items.filter((i) => i.nextDueAt <= today);

    if (dueItems.length === 0) {
      skippedNoneDue++;
      continue;
    }

    if (row.lastSentAt && row.lastSentAt > quietCutoff) {
      skippedQuiet++;
      continue;
    }

    const result = await sendReminderDue({
      toEmail: row.email,
      manageToken: row.manageToken,
      dueItems,
    });

    if (!result.configured) {
      skippedNotConfigured++;
      continue;
    }
    if (!result.delivered) {
      failed++;
      errors.push({ id: row.id, error: result.error ?? "unknown send error" });
      continue;
    }

    await db
      .update(reminderSubscriptionsTable)
      .set({ lastSentAt: new Date(), updatedAt: new Date() })
      .where(eq(reminderSubscriptionsTable.id, row.id));
    sent++;
  }

  // One audit row per batch (the admin_audit_log table is currently
  // order-focused — we deliberately don't write a row per email here.
  // The action label is enough to find these in the audit feed; specific
  // email recipients aren't logged because we don't log PHI/PII to audit.
  if (sent > 0 || failed > 0) {
    try {
      await db.insert(adminAuditLogTable).values({
        adminEmail: req.adminEmail ?? "system",
        adminUserId: req.adminUserId ?? "system",
        action: `reminder.send_batch sent=${sent} failed=${failed}`,
        ip: req.ip ?? null,
      });
    } catch (err) {
      logger.warn({ err }, "Failed to write reminder batch audit row");
    }
  }

  res.json({
    sent,
    skippedQuiet,
    skippedNoneDue,
    skippedNotConfigured,
    failed,
    errors,
    candidateCount: candidates.length,
    // Surface this so the admin UI can warn "configure SendGrid to actually
    // send" instead of silently reporting `sent: 0`.
    // Read the same env vars the shared SendGrid integration reads, so
    // this readiness flag matches what `createSendgridClient()` will
    // actually do. There is no longer a separate PENN_FROM_EMAIL — every
    // outbound mail uses SENDGRID_FROM_EMAIL (operations sets this to
    // info@pennpaps.com).
    sendgridConfigured: Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL),
  });
  // lte unused-import guard — referenced for future range queries
  void lte;
});

export default router;
