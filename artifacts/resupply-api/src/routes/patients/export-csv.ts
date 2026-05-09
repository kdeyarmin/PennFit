// GET /patients/export.csv — admin-only CSV export of the patient roster.
//
// Why a dedicated endpoint (not "fetch all pages of GET /patients"):
//   * Browser-side pagination loops issue N round-trips and the
//     admin watches a spinner. A single server-side query streams
//     a clean CSV in one round-trip.
//   * The export columns mirror the IMPORT columns exactly. That's
//     the load-bearing property here: an admin can export, edit in
//     Excel, and re-import via /patients/import-csv without column
//     re-mapping.
//
// PHI handling:
//   * The export DOES contain PHI (legal_first_name, legal_last_name,
//     date_of_birth, phone_e164, email). It must remain admin-gated
//     and audit-logged. Each call writes one `patient.export.csv`
//     audit row with the row count and active filters — never the
//     PHI itself.
//   * `Cache-Control: no-store` keeps PHI out of any intermediate
//     proxy / browser cache.
//
// Limits:
//   * 5000-row hard cap. Beyond that we stop including rows and set
//     `X-Truncated: true` so the dashboard can warn the admin to
//     narrow their filters. We don't do streaming yet — the buffer
//     for 5000 rows is small enough to materialize in one response.
//   * Same `status` and `search` filters as GET /patients so the
//     "export what I'm looking at" button on the dashboard returns
//     exactly the rows the admin currently sees.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const MAX_ROWS = 5000;

// Escape a value for use in PostgREST `.or()` filter expressions.
// PostgREST uses commas to separate clauses and parentheses for
// grouping, so we need to wrap values containing these characters
// in double-quotes and escape any embedded double-quotes.
function escapePostgRESTFilterValue(value: string): string {
  // If the value contains comma, parenthesis, or double-quote,
  // wrap it in double-quotes and escape embedded quotes
  if (/[,()"]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

const querySchema = z
  .object({
    status: z.enum(["active", "paused", "closed"]).optional(),
    search: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const COLUMNS = [
  "pacware_id",
  "legal_first_name",
  "legal_last_name",
  "date_of_birth",
  "phone_e164",
  "email",
  "status",
  "created_at",
  "updated_at",
] as const;

/**
 * RFC 4180 CSV cell escape. Wraps in double quotes when the value
 * contains a comma, quote, CR, or LF; doubles embedded quotes.
 * Prefixes formula-starting values with a single apostrophe to
 * prevent spreadsheet formula injection (Excel / LibreOffice treat
 * a leading apostrophe as "this is literal text, not a formula").
 */
function csvEscape(value: string | null | undefined): string {
  const s = value ?? "";
  if (s === "") return "";
  // Prefix formula-starting characters before further quoting so
  // =cmd|'/c calc'!A0, +1-2, -3, @SUM(A1) etc. are all neutralised.
  const safe = /^[=+\-@\t]/.test(s) ? `'${s}` : s;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

const router: IRouter = Router();

router.get("/patients/export.csv", requireAdmin, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
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

  const { status, search } = parsed.data;
  const supabase = getSupabaseServiceRoleClient();

  // Mirror GET /patients' behavior:
  //   * status: simple .eq
  //   * search: case-insensitive substring across pacware_id +
  //     legal_first_name + legal_last_name via PostgREST `.or()`
  //     with `.ilike` clauses. Zod-capped at 64 chars so the value
  //     can't smuggle metacharacters.
  let query = supabase
    .schema("resupply")
    .from("patients")
    .select(
      "pacware_id, legal_first_name, legal_last_name, date_of_birth, phone_e164, email, status, created_at, updated_at",
    )
    .order("created_at", { ascending: true })
    // Fetch one extra row so we know whether to flag truncation
    // without a separate COUNT(*) query.
    .limit(MAX_ROWS + 1);
  if (status) query = query.eq("status", status);
  if (search) {
    // PostgREST `.or()` uses `*` wildcards (not `%`) for ILIKE.
    // Escape commas/parentheses/quotes in the search value to
    // prevent breaking the filter expression.
    const escaped = escapePostgRESTFilterValue(search);
    const pattern = `*${escaped}*`;
    query = query.or(
      `pacware_id.ilike.${pattern},legal_first_name.ilike.${pattern},legal_last_name.ilike.${pattern}`,
    );
  }
  const { data: rows, error } = await query;
  if (error) throw error;

  const truncated = (rows?.length ?? 0) > MAX_ROWS;
  const exportRows = truncated ? rows!.slice(0, MAX_ROWS) : (rows ?? []);

  const lines: string[] = [COLUMNS.join(",")];
  for (const r of exportRows) {
    lines.push(
      [
        csvEscape(r.pacware_id),
        csvEscape(r.legal_first_name),
        csvEscape(r.legal_last_name),
        csvEscape(r.date_of_birth),
        csvEscape(r.phone_e164),
        csvEscape(r.email),
        csvEscape(r.status),
        csvEscape(r.created_at),
        csvEscape(r.updated_at),
      ].join(","),
    );
  }

  // Audit: row count + filters. NEVER the row contents.
  try {
    await logAudit({
      action: "patient.export.csv",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: {
        row_count: exportRows.length,
        truncated,
        status_filter: status ?? null,
        // We deliberately store whether a search was used (boolean)
        // rather than the search string itself — search terms can
        // be PHI ("Smith", a partial DOB, etc.).
        search_filter_present: Boolean(search),
      },
    });
  } catch (err) {
    logger.warn(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "patients/export-csv: audit write failed",
    );
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="patients-export.csv"',
  );
  if (truncated) res.setHeader("X-Truncated", "true");
  res.status(200).send(lines.join("\n") + "\n");
});

export default router;

// Stable export so tests can re-derive the column header.
export const EXPORT_COLUMNS: readonly string[] = COLUMNS;
