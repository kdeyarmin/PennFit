// GET /patients/export.csv — admin-only CSV export of the patient roster.
//
// Why a dedicated endpoint (not "fetch all pages of GET /patients"):
//   * Browser-side pagination loops issue N round-trips, decrypt
//     PHI N times, and the admin watches a spinner. A single
//     server-side query streams a clean CSV in one round-trip.
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
//   * `Cache-Control: no-store` keeps decrypted PHI out of any
//     intermediate proxy / browser cache.
//
// Limits:
//   * 5000-row hard cap. Beyond that we stop including rows and set
//     `X-Truncated: true` so the dashboard can warn the admin to
//     narrow their filters. We don't do streaming yet — the buffer
//     for 5000 rows is small enough to materialize in one response.
//   * Same `status` and `search` filters as GET /patients so the
//     "export what I'm looking at" button on the dashboard returns
//     exactly the rows the admin currently sees.

import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { decrypt, getDbPool, patients } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

// `decrypt(column)` builds a `pgp_sym_decrypt(column, current_setting('app.enc_key', true))`
// SQL fragment. We push decryption to the database — pulling 5000
// rows of bytea over the wire only to decrypt them in Node would
// double the payload and force pgcrypto state into the app process.

const MAX_ROWS = 5000;

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
 */
function csvEscape(value: string | null | undefined): string {
  const s = value ?? "";
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
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
  const db = drizzle(getDbPool());

  // Build the WHERE clause. We mirror GET /patients' behavior:
  //   * status: simple eq
  //   * search: case-insensitive substring across pacware_id AND the
  //     decrypted first/last name. The decrypted-name match is a
  //     full scan; the row cap and the admin gate make this OK.
  const conditions: SQL[] = [];
  if (status) conditions.push(eq(patients.status, status));
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      sql`(
        ${patients.pacwareId} ILIKE ${pattern}
        OR pgp_sym_decrypt(${patients.legalFirstName}, current_setting('app.enc_key', true)) ILIKE ${pattern}
        OR pgp_sym_decrypt(${patients.legalLastName}, current_setting('app.enc_key', true)) ILIKE ${pattern}
      )`,
    );
  }
  const whereClause: SQL | undefined =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

  // Fetch one extra row so we know whether to flag truncation
  // without a separate COUNT(*) query. Decryption happens
  // server-side via the `decrypt(...)` SQL helper so plaintext PHI
  // is materialized exactly once (in the response we're already
  // emitting), not redundantly buffered as bytea + plaintext in app
  // memory.
  const limit = MAX_ROWS + 1;
  const baseQuery = db
    .select({
      pacwareId: patients.pacwareId,
      firstName: decrypt(patients.legalFirstName),
      lastName: decrypt(patients.legalLastName),
      dateOfBirth: decrypt(patients.dateOfBirth),
      phoneE164: decrypt(patients.phoneE164),
      email: decrypt(patients.email),
      status: patients.status,
      createdAt: patients.createdAt,
      updatedAt: patients.updatedAt,
    })
    .from(patients);
  const rows = await (whereClause
    ? baseQuery.where(whereClause)
    : baseQuery
  )
    .orderBy(asc(patients.createdAt))
    .limit(limit);

  const truncated = rows.length > MAX_ROWS;
  const exportRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

  const lines: string[] = [COLUMNS.join(",")];
  for (const r of exportRows) {
    lines.push(
      [
        csvEscape(r.pacwareId),
        csvEscape(r.firstName),
        csvEscape(r.lastName),
        csvEscape(r.dateOfBirth),
        csvEscape(r.phoneE164),
        csvEscape(r.email),
        csvEscape(r.status),
        csvEscape(r.createdAt.toISOString()),
        csvEscape(r.updatedAt.toISOString()),
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
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
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

// `decrypt` is imported from the db helpers, where it returns a
// string from a `bytea` column round-tripped through pgcrypto.

export default router;

// Stable export so tests can re-derive the column header.
export const EXPORT_COLUMNS: readonly string[] = COLUMNS;
