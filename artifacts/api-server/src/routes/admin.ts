/**
 * Admin API — Clerk-gated endpoints for Penn staff.
 *
 * NOT exposed in the public OpenAPI spec on purpose: the public spec
 * advertises a stateless, no-PHI-stored service to patients. The admin
 * surface is an internal extension that lives off the same Express tree.
 *
 * Auth: every route runs through `requireAdmin`, which:
 *   1. Checks Clerk session
 *   2. Validates the signed-in user's email against PENN_ADMIN_EMAILS
 *
 * Audit: every route that returns full PHI (currently only the order
 * detail view) writes a row to admin_audit_log. List views return a
 * REDACTED summary (no insurance member id, no DOB, no street address)
 * and don't write audit rows.
 */

import { Router } from "express";
import { z } from "zod";
import { db, ordersTable, adminAuditLogTable, usageEventsTable } from "@workspace/db";
import { desc, eq, ilike, or, and, sql, count } from "drizzle-orm";
import { requireAdmin } from "../middlewares/requireAdmin.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Scope requireAdmin to /admin/* only. Without a path prefix, this
// middleware would intercept every request that flows through this
// router (including unrelated /api/usage-events requests on the same
// parent router) and reject them with 401 — even though those routes
// are intentionally public.
router.use("/admin", requireAdmin);

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
  if (req.adminEmail && req.adminClerkId) {
    const filterParts: string[] = [];
    if (q) filterParts.push(`q=${q}`);
    if (status) filterParts.push(`status=${status}`);
    filterParts.push(`page=${page}`);
    const action = `list_orders${filterParts.length ? `:${filterParts.join("&")}` : ""}`;
    try {
      await db.insert(adminAuditLogTable).values({
        adminEmail: req.adminEmail,
        adminClerkId: req.adminClerkId,
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
  if (req.adminEmail && req.adminClerkId) {
    try {
      await db.insert(adminAuditLogTable).values({
        adminEmail: req.adminEmail,
        adminClerkId: req.adminClerkId,
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
  res.json({ email: req.adminEmail, clerkId: req.adminClerkId });
});

export default router;
