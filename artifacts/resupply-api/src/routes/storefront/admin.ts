/**
 * Admin API — auth-gated endpoints for Penn staff.
 *
 * NOT exposed in the public OpenAPI spec on purpose: the public spec
 * advertises a stateless, no-PHI-stored service to patients. The admin
 * surface is an internal extension that lives off the same Express tree.
 *
 * Auth: every route runs through `requireAdmin`, which:
 *   1. Checks session
 *   2. Validates `auth.users.role` is admin or agent
 *
 * Audit: every route that returns full PHI (currently only the order
 * detail view) writes a row to admin_audit_log. List views return a
 * REDACTED summary (no insurance member id, no DOB, no street address)
 * and don't write audit rows.
 */

import { Router } from "express";
import { z } from "zod";

import { permissionsForRole } from "@workspace/resupply-auth";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit.js";
import { requireCsrf } from "../../middlewares/csrf.js";
import { requireAdmin } from "../../middlewares/requireAdmin.js";
import { logger } from "../../lib/logger.js";
import {
  sendReminderDue,
  type ReminderItemForEmail,
} from "../../lib/storefront/reminderEmail.js";
import adminUsersRouter from "./admin-users.js";

const router = Router();

// Scope requireAdmin to /admin/* only. Without a path prefix, this
// middleware would intercept every request that flows through this
// router (including unrelated /api/usage-events requests on the same
// parent router) and reject them with 401 — even though those routes
// are intentionally public.
//
// adminReadRateLimiter runs first (a CodeQL-recognized express-rate-limit
// instance, keyed per admin actor with an IP fallback for the pre-auth
// window) so the whole /admin/* surface on this router is rate-limited
// ahead of the auth gate — an unauthenticated flood is throttled too.
router.use("/admin", adminReadRateLimiter, requireAdmin);

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
    res.status(400).json({
      error: "Invalid query",
      details: parsed.error.issues.map((i) => i.message),
    });
    return;
  }
  const { q, status, page, pageSize } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();
  const offset = (page - 1) * pageSize;

  // Build the rows query and the count query side-by-side. PostgREST
  // can return both rows and an exact count from a single response
  // header, but supabase-js's typings make a parallel two-query
  // pattern cleaner here.
  const buildQuery = <T>(
    base: { select: (s: string, opts?: object) => T },
    select: string,
    opts?: { count: "exact"; head: true },
  ) => base.select(select, opts);
  void buildQuery;

  let rowsQuery = supabase
    .schema("public")
    .from("orders")
    .select(
      "id, order_reference, patient_first_name, patient_last_name, patient_email, mask_name, mask_manufacturer, shipping_city, shipping_state, email_status, created_at",
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);
  let countQuery = supabase
    .schema("public")
    .from("orders")
    .select("*", { count: "exact", head: true });

  if (q) {
    // Escape LIKE metacharacters then run a 4-column ilike via .or().
    // PostgREST treats `*` as the LIKE wildcard so we substitute back
    // to `%` after escaping the user's literal `%`/`_`.
    const pattern = `*${q.replace(/[\\%_*]/g, (c) => `\\${c}`)}*`;
    const orFilter = [
      `patient_first_name.ilike.${pattern}`,
      `patient_last_name.ilike.${pattern}`,
      `patient_email.ilike.${pattern}`,
      `order_reference.ilike.${pattern}`,
    ].join(",");
    rowsQuery = rowsQuery.or(orFilter);
    countQuery = countQuery.or(orFilter);
  }
  if (status) {
    rowsQuery = rowsQuery.eq("email_status", status);
    countQuery = countQuery.eq("email_status", status);
  }
  const [rowsRes, countRes] = await Promise.all([rowsQuery, countQuery]);
  if (rowsRes.error) throw rowsRes.error;
  if (countRes.error) throw countRes.error;
  const rows = rowsRes.data ?? [];
  const total = countRes.count ?? 0;

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
    const { error: auditErr } = await supabase
      .schema("public")
      .from("admin_audit_log")
      .insert({
        admin_email: req.adminEmail,
        admin_user_id: req.adminUserId,
        action,
        ip: req.ip ?? null,
      });
    if (auditErr) {
      logger.error(
        { err: auditErr },
        "Failed to write audit log for list_orders",
      );
    }
  }

  // Map snake_case row shape back to the camelCase contract the SPA
  // expects (matches the prior alias-set output).
  res.json({
    orders: rows.map((r) => ({
      id: r.id,
      orderReference: r.order_reference,
      patientFirstName: r.patient_first_name,
      patientLastName: r.patient_last_name,
      patientEmail: r.patient_email,
      maskName: r.mask_name,
      maskManufacturer: r.mask_manufacturer,
      shippingCity: r.shipping_city,
      shippingState: r.shipping_state,
      emailStatus: r.email_status,
      createdAt: r.created_at,
    })),
    total,
    page,
    pageSize,
  });
});

// ---------- GET /admin/orders/:id ----------

router.get("/admin/orders/:id", async (req, res) => {
  const id = req.params.id;
  // Defensive uuid check (a malformed id would round-trip as a 400
  // from PostgREST anyway, but we surface a friendlier shape).
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      id,
    )
  ) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("public")
    .from("orders")
    .select("*")
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  // Audit BEFORE returning. If the audit insert fails we still serve the
  // request (the admin shouldn't be locked out due to logging trouble),
  // but we surface it via server logs.
  if (req.adminEmail && req.adminUserId) {
    const { error: auditErr } = await supabase
      .schema("public")
      .from("admin_audit_log")
      .insert({
        admin_email: req.adminEmail,
        admin_user_id: req.adminUserId,
        action: "view_order_detail",
        target_order_id: row.id,
        ip: req.ip ?? null,
      });
    if (auditErr) {
      logger.error(
        { err: auditErr, orderId: row.id },
        "Failed to write audit log for order view",
      );
    }
  }

  // Re-shape to the camelCase contract.
  res.json({
    order: {
      id: row.id,
      orderReference: row.order_reference,
      patientFirstName: row.patient_first_name,
      patientLastName: row.patient_last_name,
      patientEmail: row.patient_email,
      patientPhone: row.patient_phone,
      patientDateOfBirth: row.patient_date_of_birth,
      maskId: row.mask_id,
      maskName: row.mask_name,
      maskManufacturer: row.mask_manufacturer,
      maskModelNumber: row.mask_model_number,
      shippingCity: row.shipping_city,
      shippingState: row.shipping_state,
      shippingZip: row.shipping_zip,
      payload: row.payload,
      emailStatus: row.email_status,
      emailError: row.email_error,
      emailDeliveredAt: row.email_delivered_at,
      createdAt: row.created_at,
    },
  });
});

// ---------- GET /admin/analytics ----------

router.get("/admin/analytics", async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const sinceIso = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  // PostgREST has no GROUP BY. We fetch the aggregation inputs and
  // reduce JS-side. The dataset is admin-internal and bounded
  // (low-thousands of orders / events at our scale); when this grows
  // these become RPC functions exposing pre-aggregated views.
  const [totalRes, statusRes, masksRes, funnelRes, recentRes] =
    await Promise.all([
      supabase
        .schema("public")
        .from("orders")
        .select("*", { count: "exact", head: true }),
      supabase.schema("public").from("orders").select("email_status"),
      supabase
        .schema("public")
        .from("orders")
        .select("mask_name, mask_manufacturer"),
      supabase.schema("public").from("usage_events").select("step"),
      supabase
        .schema("public")
        .from("orders")
        .select("created_at")
        .gte("created_at", sinceIso),
    ]);
  if (totalRes.error) throw totalRes.error;
  if (statusRes.error) throw statusRes.error;
  if (masksRes.error) throw masksRes.error;
  if (funnelRes.error) throw funnelRes.error;
  if (recentRes.error) throw recentRes.error;

  // GROUP BY status COUNT(*).
  const statusBreakdown = countBy(
    statusRes.data ?? [],
    (r) => r.email_status,
  ).map(([status, count]) => ({ status, count }));

  // GROUP BY (mask_name, mask_manufacturer) COUNT(*) ORDER BY count DESC LIMIT 10.
  // Use a Map so we can preserve both grouping columns in the result
  // rather than encoding them as a delimiter-collidable string.
  const maskCounts = new Map<
    string,
    { maskName: string; maskManufacturer: string; count: number }
  >();
  for (const r of masksRes.data ?? []) {
    const k = JSON.stringify([r.mask_name, r.mask_manufacturer]);
    const existing = maskCounts.get(k);
    if (existing) {
      existing.count++;
    } else {
      maskCounts.set(k, {
        maskName: r.mask_name,
        maskManufacturer: r.mask_manufacturer,
        count: 1,
      });
    }
  }
  const topMasks = Array.from(maskCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // GROUP BY step COUNT(*).
  const funnel = countBy(funnelRes.data ?? [], (r) => r.step).map(
    ([step, count]) => ({ step, count }),
  );

  // date_trunc('day', created_at)::date GROUP BY day ORDER BY day.
  // Truncate to YYYY-MM-DD by slicing the ISO string.
  const ordersByDay = countBy(recentRes.data ?? [], (r) =>
    r.created_at.slice(0, 10),
  )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, count]) => ({ day, count }));

  res.json({
    totalOrders: totalRes.count ?? 0,
    statusBreakdown,
    topMasks,
    funnel,
    ordersByDay,
  });
});

function countBy<T, K extends string>(
  rows: ReadonlyArray<T>,
  key: (r: T) => K | null | undefined,
): Array<[K, number]> {
  const m = new Map<K, number>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Array.from(m.entries());
}

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
  const offset = (page - 1) * pageSize;

  const supabase = getSupabaseServiceRoleClient();
  const [rowsRes, countRes] = await Promise.all([
    supabase
      .schema("public")
      .from("admin_audit_log")
      .select(
        "id, admin_email, admin_user_id, action, target_order_id, ip, occurred_at",
      )
      .order("occurred_at", { ascending: false })
      .range(offset, offset + pageSize - 1),
    supabase
      .schema("public")
      .from("admin_audit_log")
      .select("*", { count: "exact", head: true }),
  ]);
  if (rowsRes.error) throw rowsRes.error;
  if (countRes.error) throw countRes.error;

  res.json({
    events: (rowsRes.data ?? []).map((r) => ({
      id: r.id,
      adminEmail: r.admin_email,
      adminUserId: r.admin_user_id,
      action: r.action,
      targetOrderId: r.target_order_id,
      ip: r.ip,
      occurredAt: r.occurred_at,
    })),
    total: countRes.count ?? 0,
    page,
    pageSize,
  });
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
    // Granular RBAC keys the role carries — drives nav-visibility in the
    // SPA (e.g. the super-admin-only System Configuration page). Kept in
    // sync with /resupply-api/me. Non-sensitive: the server still
    // enforces every gate; this just hides controls that would 403.
    permissions: permissionsForRole(
      req.adminGranularRole ?? req.adminRole ?? "admin",
    ),
  });
});

// ---------- GET /admin/reminders ----------
// List all reminder subscribers (active + unsubscribed). Includes per-item
// nextDueAt so the admin can see who's coming up. Not paginated yet — this
// is a small opt-in list, hundreds at most. Add pagination if it grows.
router.get("/admin/reminders", async (_req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("public")
    .from("reminder_subscriptions")
    .select(
      "id, email, manage_token, status, items, last_sent_at, created_at, updated_at",
    )
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw error;

  const today = new Date().toISOString().slice(0, 10);
  res.json({
    subscribers: (rows ?? []).map((r) => {
      const items = (r.items ?? []) as unknown as Array<{
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
        lastSentAt: r.last_sent_at,
        createdAt: r.created_at,
      };
    }),
    total: (rows ?? []).length,
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

router.post("/admin/reminders/send-due", requireCsrf, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const quietCutoff = new Date(
    Date.now() - QUIET_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );

  const supabase = getSupabaseServiceRoleClient();
  const { data: candidates, error } = await supabase
    .schema("public")
    .from("reminder_subscriptions")
    .select("id, email, manage_token, items, last_sent_at")
    .eq("status", "active");
  if (error) throw error;

  let sent = 0;
  let skippedQuiet = 0;
  let skippedNoneDue = 0;
  let skippedNotConfigured = 0;
  let failed = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const row of candidates ?? []) {
    const items = (row.items ?? []) as unknown as ReminderItemForEmail[];
    const dueItems = items.filter((i) => i.nextDueAt <= today);

    if (dueItems.length === 0) {
      skippedNoneDue++;
      continue;
    }

    if (row.last_sent_at && new Date(row.last_sent_at) > quietCutoff) {
      skippedQuiet++;
      continue;
    }

    const result = await sendReminderDue({
      toEmail: row.email,
      manageToken: row.manage_token,
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

    const nowIso = new Date().toISOString();
    const { error: stampErr } = await supabase
      .schema("public")
      .from("reminder_subscriptions")
      .update({ last_sent_at: nowIso, updated_at: nowIso })
      .eq("id", row.id);
    if (stampErr) {
      logger.warn(
        { err: stampErr, id: row.id },
        "Failed to stamp last_sent_at on reminder subscription",
      );
    }
    sent++;
  }

  // One audit row per batch (the admin_audit_log table is currently
  // order-focused — we deliberately don't write a row per email here.
  // The action label is enough to find these in the audit feed; specific
  // email recipients aren't logged because we don't log PHI/PII to audit.
  if (sent > 0 || failed > 0) {
    const { error: auditErr } = await supabase
      .schema("public")
      .from("admin_audit_log")
      .insert({
        admin_email: req.adminEmail ?? "system",
        admin_user_id: req.adminUserId ?? "system",
        action: `reminder.send_batch sent=${sent} failed=${failed}`,
        ip: req.ip ?? null,
      });
    if (auditErr) {
      logger.warn(
        { err: auditErr },
        "Failed to write reminder batch audit row",
      );
    }
  }

  res.json({
    sent,
    skippedQuiet,
    skippedNoneDue,
    skippedNotConfigured,
    failed,
    errors,
    candidateCount: (candidates ?? []).length,
    // Surface this so the admin UI can warn "configure SendGrid to actually
    // send" instead of silently reporting `sent: 0`.
    // Read the same env vars the shared SendGrid integration reads, so
    // this readiness flag matches what `createSendgridClient()` will
    // actually do. There is no longer a separate PENN_FROM_EMAIL — every
    // outbound mail uses SENDGRID_FROM_EMAIL (operations sets this to
    // info@pennpaps.com).
    sendgridConfigured: Boolean(
      process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL,
    ),
  });
});

export default router;
