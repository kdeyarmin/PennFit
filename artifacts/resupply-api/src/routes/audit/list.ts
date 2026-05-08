// GET /audit — paginated audit-log viewer.
//
// Filters: action substring, exact targetTable, lower-bound on
// occurredAt. Sort key: occurredAt DESC (newest first — that's the
// shape an admin wants when investigating "what just
// happened?").
//
// Architecture note: per Rule 8 of check-resupply-architecture.sh
// the bare `import { auditLog }` Drizzle symbol is forbidden outside
// @workspace/resupply-audit (so the helper stays the only chokepoint
// for WRITES). Reads against resupply.audit_log are explicitly
// allowed by the same rule, and now go through the shared Supabase
// service-role client (Drizzle → Supabase migration).
//
// `metadata` is the plaintext jsonb context written through
// @workspace/resupply-audit's sanitiser (PHI-key denylist + size +
// depth caps), so it is safe to surface as-is. The dashboard
// renderer additionally allowlists keys it knows how to display
// for defence-in-depth — a metadata renderer that ships a raw
// JSON dump to the page is exactly the silent PHI-leak vector this
// endpoint exists to prevent.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

// Rate limit the audit viewer per admin (fall back to IP for the
// pre-auth burst). The query joins audit_log against indexed columns
// and is expected to be cheap, but a tight loop scrolling through
// pages would still pile DB work without this cap.
const auditReadLimiter = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.adminUserId ?? ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

const listQuery = z
  .object({
    action: z.string().min(1).max(128).optional(),
    targetTable: z.string().min(1).max(64).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const router: IRouter = Router();

router.get("/audit", requireAdmin, auditReadLimiter, async (req, res) => {
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
  const { action, targetTable, since, limit, offset } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("audit_log")
    .select(
      "id, occurred_at, operator_email, operator_user_id, action, target_table, target_id, metadata, ip, user_agent",
      { count: "exact" },
    )
    .order("occurred_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (action) query = query.ilike("action", `%${action}%`);
  if (targetTable) query = query.eq("target_table", targetTable);
  if (since) query = query.gte("occurred_at", new Date(since).toISOString());

  const { data, count, error } = await query;
  if (error) {
    res.status(500).json({ error: "query_failed", message: error.message });
    return;
  }

  res.status(200).json({
    items: (data ?? []).map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at ?? new Date(0).toISOString(),
      adminEmail: r.operator_email,
      adminUserId: r.operator_user_id,
      action: r.action,
      targetTable: r.target_table,
      targetId: r.target_id,
      metadata:
        r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata)
          ? (r.metadata as Record<string, unknown>)
          : {},
      ip: r.ip,
      userAgent: r.user_agent,
    })),
    total: count ?? 0,
    limit,
    offset,
  });
});

export default router;
