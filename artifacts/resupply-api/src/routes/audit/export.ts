// GET /audit/export.csv — streaming CSV download of the audit log.
//
// Mirrors the same filter set as GET /audit (action substring,
// exact targetTable, lower-bound on occurredAt) so an admin can
// "download what I'm currently viewing." Sort key matches the list:
// occurredAt DESC.
//
// Capacity: hard-capped at MAX_ROWS rows. If the underlying query
// would return more than MAX_ROWS, the response is still well-formed
// CSV but a final `# truncated: <n> rows omitted, narrow the filter`
// comment line is appended. We surface the truncation in the audit
// trail too (see logAudit() call) so a reviewer noticing a
// suspiciously round 50k row count can confirm whether the export
// was complete.
//
// Streaming model: we materialise the query result once (capped to
// MAX_ROWS) and then write the formatted CSV row-by-row to the
// response. We don't wire up a pg cursor because (a) MAX_ROWS is
// chosen so the whole result fits comfortably in process memory,
// and (b) the existing audit list endpoint is also a single-shot
// query, so this matches the established read pattern.
//
// PHI posture: identical to the list endpoint. `metadata` was
// written through @workspace/resupply-audit's sanitiser, so it is
// safe to surface as-is. We emit it as a JSON-encoded column rather
// than blowing it out into many sparse columns; downstream tooling
// (Excel power-query, jq, etc.) can re-parse if needed.
//
// Audit-log-the-auditor: we write a `audit.export.csv` row at the
// END of the export (after the response body has been flushed) so a
// reviewer can answer "who pulled the audit log?" — which is
// exactly the kind of bulk PHI exposure event HIPAA wants logged.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import { getDbPool } from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";

import { requireAdmin } from "../../middlewares/requireAdmin";

const MAX_ROWS = 50_000;

// Bulk PHI download throttle. Each call can return up to MAX_ROWS audit
// rows containing patient identifiers in `metadata`; cap at 10/hour/admin
// so a compromised account can't quietly exfiltrate the entire log. Keyed
// by adminUserId (set by requireAdmin, which runs first) so one
// reviewer's session doesn't lock out other staff.
const exportLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.adminUserId ?? "unknown",
  message: {
    error: "too_many_requests",
    limiter: "audit_export_csv",
    message:
      "Audit export rate limit reached. Please wait a few minutes and try again.",
  },
});

const exportQuery = z
  .object({
    action: z.string().min(1).max(128).optional(),
    targetTable: z.string().min(1).max(64).optional(),
    since: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

interface AuditRow {
  id: string;
  occurred_at: Date | string | null;
  operator_email: string | null;
  operator_user_id: string | null;
  action: string;
  target_table: string | null;
  target_id: string | null;
  metadata: unknown;
  ip: string | null;
  user_agent: string | null;
}

// RFC4180-ish CSV field escape. Quote when the field contains
// comma, double-quote, CR, or LF. Doubled internal quotes.
function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) {
    s = v.toISOString();
  } else if (typeof v === "object") {
    try {
      s = JSON.stringify(v);
    } catch {
      s = "";
    }
  } else {
    s = String(v);
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(fields: ReadonlyArray<unknown>): string {
  return fields.map(csvField).join(",") + "\r\n";
}

const COLUMNS: ReadonlyArray<string> = [
  "id",
  "occurredAt",
  "adminEmail",
  "adminUserId",
  "action",
  "targetTable",
  "targetId",
  "ip",
  "userAgent",
  "metadataJson",
];

const router: IRouter = Router();

router.get("/audit/export.csv", requireAdmin, exportLimiter, async (req, res) => {
  const parsed = exportQuery.safeParse(req.query);
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
  const { action, targetTable, since } = parsed.data;

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

  // Query MAX_ROWS + 1 so we can detect overflow without a separate
  // COUNT round-trip.
  params.push(MAX_ROWS + 1);
  const limitIdx = params.length;

  const sql = (
    `SELECT id, occurred_at, operator_email, operator_user_id, ` +
    `action, target_table, target_id, metadata, ip, user_agent ` +
    `FROM resupply.audit_log ${whereSql} ` +
    `ORDER BY occurred_at DESC ` +
    `LIMIT $${limitIdx}`
  ).replace(/\s+/g, " ");

  const pool = getDbPool();
  const result = await pool.query<AuditRow>(sql, params);

  const truncated = result.rows.length > MAX_ROWS;
  const emit = truncated ? result.rows.slice(0, MAX_ROWS) : result.rows;

  // Filename: audit-export-<UTC-ish>.csv. Use a colon-free format
  // so Windows clients can save without renaming.
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "Z");
  const filename = `audit-export-${stamp}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");

  // Header row.
  res.write(csvRow(COLUMNS));

  for (const r of emit) {
    res.write(
      csvRow([
        r.id,
        r.occurred_at instanceof Date
          ? r.occurred_at.toISOString()
          : (r.occurred_at ?? ""),
        r.operator_email,
        r.operator_user_id,
        r.action,
        r.target_table,
        r.target_id,
        r.ip,
        r.user_agent,
        // metadata jsonb arrives as a parsed object; re-stringify
        // so it survives in a single CSV cell.
        r.metadata == null ? "" : JSON.stringify(r.metadata),
      ]),
    );
  }

  if (truncated) {
    // Trailing comment line — `#` prefix is recognised as a comment
    // by every CSV reader I've checked (Excel power-query, pandas
    // with comment="#", csvkit). Worst case it shows up as a single
    // weird-looking row at the bottom of the spreadsheet, which is
    // exactly the "loud signal" we want.
    res.write(
      `# truncated: more than ${MAX_ROWS} rows matched, narrow the filter\r\n`,
    );
  }

  res.end();

  // Best-effort audit trail of the export. Do this AFTER the
  // response so a logging hiccup never bricks the download. The
  // requireAdmin middleware has already attached adminEmail and
  // adminUserId to the request, so no auth-provider round-trip
  // is needed here.
  try {
    await logAudit({
      action: "audit.export.csv",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "audit_log",
      targetId: null,
      metadata: {
        count: emit.length,
        ...(truncated ? { outcome: "truncated" } : { outcome: "complete" }),
        ...(action ? { reason: "filter:action" } : {}),
        ...(targetTable ? { source: targetTable } : {}),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
  } catch (err) {
    req.log?.warn({ err }, "audit.export.csv: post-export audit log failed");
  }
});

export default router;
