// GET /audit — paginated audit-log viewer.
//
// Filters: action substring, exact targetTable, lower-bound on
// occurredAt. Sort key: occurredAt DESC (newest first — that's the
// shape an admin wants when investigating "what just
// happened?").
//
// Architecture note: per Rule 8 of check-resupply-architecture.sh
// the bare `import { auditLog }` Drizzle symbol is forbidden
// outside @workspace/resupply-audit (so the helper stays the only
// chokepoint for WRITES). Raw SQL SELECT against
// resupply.audit_log is explicitly allowed by the same rule, so
// this read-only viewer issues a parameterised raw query through
// the shared pool.
//
// `metadata` is the plaintext jsonb context written through
// @workspace/resupply-audit's sanitiser (PHI-key denylist + size +
// depth caps), so it is safe to surface as-is. The dashboard
// renderer additionally allowlists keys it knows how to display
// for defence-in-depth — a metadata renderer that ships a raw
// JSON dump to the page is exactly the silent PHI-leak vector this
// endpoint exists to prevent.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getDbPool } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const listQuery = z
  .object({
    action: z.string().min(1).max(128).optional(),
    targetTable: z.string().min(1).max(64).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

interface AuditRow {
  id: string;
  occurred_at: Date | string | null;
  operator_email: string | null;
  operator_clerk_id: string | null;
  action: string;
  target_table: string | null;
  target_id: string | null;
  metadata: unknown;
  ip: string | null;
  user_agent: string | null;
}

interface CountRow {
  count: number | string;
}

const router: IRouter = Router();

router.get("/audit", requireAdmin, async (req, res) => {
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

  // Build WHERE incrementally using parameterised placeholders.
  const where: string[] = [];
  const params: unknown[] = [];
  if (action) {
    params.push(`%${action}%`);
    where.push(`action ILIKE $${params.length}`);
  }
  if (targetTable) {
    params.push(targetTable);
    where.push(`target_table = $${params.length}`);
  }
  if (since) {
    params.push(new Date(since));
    where.push(`occurred_at >= $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const pool = getDbPool();

  const countSql =
    `SELECT count(*)::int AS count FROM resupply.audit_log ${whereSql}`.trim();
  // Pass a snapshot copy of params so vitest call captures don't
  // see later mutations from the rows query.
  const countResult = await pool.query<CountRow>(countSql, params.slice());
  const total = Number(countResult.rows[0]?.count ?? 0);

  // limit + offset are validated ints from zod so safe to inline,
  // but we still bind them as parameters for symmetry/safety.
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const rowsSql = (
    `SELECT id, occurred_at, operator_email, operator_clerk_id, ` +
    `action, target_table, target_id, metadata, ip, user_agent ` +
    `FROM resupply.audit_log ${whereSql} ` +
    `ORDER BY occurred_at DESC ` +
    `LIMIT $${limitIdx} OFFSET $${offsetIdx}`
  ).replace(/\s+/g, " ");

  const rowsResult = await pool.query<AuditRow>(rowsSql, params);

  const toIsoRequired = (v: unknown): string => {
    if (v == null) return new Date(0).toISOString();
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };

  res.status(200).json({
    items: rowsResult.rows.map((r) => ({
      id: r.id,
      occurredAt: toIsoRequired(r.occurred_at),
      adminEmail: r.operator_email,
      adminClerkId: r.operator_clerk_id,
      action: r.action,
      targetTable: r.target_table,
      targetId: r.target_id,
      metadata:
        r.metadata && typeof r.metadata === "object"
          ? (r.metadata as Record<string, unknown>)
          : {},
      ip: r.ip,
      userAgent: r.user_agent,
    })),
    total,
    limit,
    offset,
  });
});

export default router;
