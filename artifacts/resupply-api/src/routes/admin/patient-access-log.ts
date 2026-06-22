// GET /admin/patient-access-log — the admin "Audit Trail" report.
//
// Returns who (staff) accessed which patient's information, when, and
// how, filterable by time frame / employee / patient / action. Reads
// the plain `resupply.patient_access_log` table (migration 0456),
// written best-effort by the recordPatientAccess middleware.
//
// Access: `requireAdminOnly` — full admins only. Customer-service
// agents are the staff being audited, so they cannot run the report
// (decision recorded with the product owner).
//
// Output: JSON by default; `?format=csv` streams a download. Patient
// display names are resolved on read (best-effort) for the page of
// rows being returned — they are never persisted into the log.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_CSV_ROWS = 5000;

const SELECT_COLUMNS =
  "id, admin_user_id, admin_email, admin_role, action, method, path, " +
  "target_table, target_id, patient_id, status_code, ip, user_agent, " +
  "impersonator_user_id, occurred_at";

const querySchema = z.object({
  from: z.string().trim().min(1).max(40).optional(),
  to: z.string().trim().min(1).max(40).optional(),
  adminEmail: z.string().trim().max(254).optional(),
  adminUserId: z.string().trim().max(128).optional(),
  patientId: z.string().trim().max(128).optional(),
  targetTable: z.string().trim().max(64).optional(),
  action: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  format: z.enum(["json", "csv"]).optional(),
});

/** Parse an inclusive lower bound (start of the window). */
function parseFrom(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Parse an inclusive upper bound; a date-only value snaps to EOD UTC. */
function parseTo(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T23:59:59.999Z`);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

interface AccessLogRowRaw {
  id: string;
  admin_user_id: string;
  admin_email: string;
  admin_role: string | null;
  action: string;
  method: string | null;
  path: string | null;
  target_table: string | null;
  target_id: string | null;
  patient_id: string | null;
  status_code: number | null;
  ip: string | null;
  user_agent: string | null;
  impersonator_user_id: string | null;
  occurred_at: string;
}

/** Resolve best-effort display names for the patient/customer ids on
 *  this page. Never throws — a lookup failure just leaves names null. */
async function resolvePatientNames(
  orgId: string,
  rows: AccessLogRowRaw[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const patientIds = new Set<string>();
  const customerIds = new Set<string>();
  for (const r of rows) {
    if (!r.patient_id) continue;
    if (r.target_table === "patients") patientIds.add(r.patient_id);
    else if (r.target_table === "customers") customerIds.add(r.patient_id);
  }
  const client = getOrgScopedClient(orgId);
  try {
    if (patientIds.size > 0) {
      const { data } = await client
        .from("patients")
        .select("id, legal_first_name, legal_last_name")
        .in("id", Array.from(patientIds));
      for (const p of data ?? []) {
        const name = [p.legal_first_name, p.legal_last_name]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (name) names.set(p.id, name);
      }
    }
  } catch {
    // best-effort
  }
  try {
    if (customerIds.size > 0) {
      const { data } = await client
        .from("shop_customers")
        .select("customer_id, display_name, email_lower")
        .in("customer_id", Array.from(customerIds));
      for (const c of data ?? []) {
        const name = (c.display_name || c.email_lower || "").trim();
        if (name) names.set(c.customer_id, name);
      }
    }
  } catch {
    // best-effort
  }
  return names;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Formula-injection guard for spreadsheet apps.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_HEADERS = [
  "occurred_at",
  "admin_email",
  "admin_role",
  "action",
  "method",
  "path",
  "target_table",
  "target_id",
  "patient_id",
  "patient_name",
  "status_code",
  "ip",
  "user_agent",
  "impersonator_user_id",
] as const;

router.get("/admin/patient-access-log", requireAdminOnly, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: "invalid_query", issues: parsed.error.flatten() });
    return;
  }
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const q = parsed.data;
  const wantsCsv = q.format === "csv";
  const limit = wantsCsv ? MAX_CSV_ROWS : (q.limit ?? DEFAULT_LIMIT);
  const offset = wantsCsv ? 0 : (q.offset ?? 0);

  const from = parseFrom(q.from);
  const to = parseTo(q.to);

  const client = getOrgScopedClient(orgId);
  let query = client
    .from("patient_access_log")
    .select(SELECT_COLUMNS, wantsCsv ? undefined : { count: "exact" });

  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lte("occurred_at", to);
  if (q.adminUserId) query = query.eq("admin_user_id", q.adminUserId);
  if (q.adminEmail) query = query.ilike("admin_email", `%${q.adminEmail}%`);
  if (q.patientId) query = query.eq("patient_id", q.patientId);
  if (q.targetTable) query = query.eq("target_table", q.targetTable);
  if (q.action) query = query.ilike("action", `%${q.action}%`);

  query = query
    .order("occurred_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw error;
  const rows = (data ?? []) as AccessLogRowRaw[];

  const names = await resolvePatientNames(orgId, rows);
  const enriched = rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    adminEmail: r.admin_email,
    adminUserId: r.admin_user_id,
    adminRole: r.admin_role,
    action: r.action,
    method: r.method,
    path: r.path,
    targetTable: r.target_table,
    targetId: r.target_id,
    patientId: r.patient_id,
    patientName: r.patient_id ? (names.get(r.patient_id) ?? null) : null,
    statusCode: r.status_code,
    ip: r.ip,
    userAgent: r.user_agent,
    impersonatorUserId: r.impersonator_user_id,
  }));

  if (wantsCsv) {
    const lines = [CSV_HEADERS.join(",")];
    for (const r of enriched) {
      lines.push(
        [
          r.occurredAt,
          r.adminEmail,
          r.adminRole,
          r.action,
          r.method,
          r.path,
          r.targetTable,
          r.targetId,
          r.patientId,
          r.patientName,
          r.statusCode,
          r.ip,
          r.userAgent,
          r.impersonatorUserId,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-trail-${stamp}.csv"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(lines.join("\r\n"));
    return;
  }

  res.json({
    rows: enriched,
    total: count ?? null,
    limit,
    offset,
    filters: {
      from: from ?? null,
      to: to ?? null,
      adminEmail: q.adminEmail ?? null,
      adminUserId: q.adminUserId ?? null,
      patientId: q.patientId ?? null,
      targetTable: q.targetTable ?? null,
      action: q.action ?? null,
    },
  });
});

export default router;
