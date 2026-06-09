// PacWare file-exchange admin routes.
//
// PacWare is a legacy Windows client-server HME/DME billing package
// (Billing, Inventory, Reporting, Cash Application) acquired by Brightree.
// It has NO network API, so the durable integration is a CSV file
// exchange (see docs/integrations/pacware.md):
//
//   * Import:  operator runs the Patient List report in PacWare, uploads
//              the CSV here -> patients are synced (insert/update) on the
//              PacWare account number (patients.pacware_id).
//   * Export:  PennFit emits CSV files shaped for PacWare's import
//              screens — the patient roster (round-trips with import) and
//              the resupply-due worklist (PacWare order entry / billing).
//
// All parsing, validation, and column layout live in the pure
// @workspace/resupply-integrations-pacware package so the layouts can
// never drift from the operator manual or the status endpoint.
//
// PHI posture: uploaded rows + exported rows ARE patient data. This file
// NEVER logs row contents (CLAUDE.md hard rule — treat every log line as
// world-readable). Audit rows carry structural counts only. Exports are
// admin-gated and `Cache-Control: no-store`.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";
import {
  buildPacwarePatientCsv,
  buildPacwareResupplyDueCsv,
  listPacwareReportSpecs,
  pacwareAvailability,
  parsePacwarePatientCsv,
  type PacwarePatientExportRecord,
  type PacwarePatientRow,
  type PacwareResupplyDueRecord,
} from "@workspace/resupply-integrations-pacware";

import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { withIdempotency } from "../../middlewares/idempotency";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Hard caps. The import body limit is raised for this path in app.ts; the
// row cap keeps a single sync request bounded well under the request
// timeout. Larger rosters are split by the operator (the manual says so).
const MAX_IMPORT_ROWS = 5000;
const UPSERT_BATCH = 500;
const MAX_EXPORT_ROWS = 5000;
const PREVIEW_SAMPLE = 10;

// ---------------------------------------------------------------------------
// GET /admin/pacware/status — availability + the report catalog.
//
// Drives the admin Integrations → PacWare page and keeps the operator
// manual honest: the column lists shown there come straight from the
// package's single-source-of-truth catalog.
// ---------------------------------------------------------------------------
router.get(
  "/admin/pacware/status",
  adminReadRateLimiter,
  requirePermission("admin.tools.manage"),
  (_req, res) => {
    res.json({
      availability: pacwareAvailability(),
      reports: listPacwareReportSpecs().map((spec) => ({
        kind: spec.kind,
        direction: spec.direction,
        label: spec.label,
        description: spec.description,
        columns: spec.columns.map((c) => ({
          field: c.field,
          header: c.header,
          required: c.required,
          description: c.description,
          aliases: c.aliases,
        })),
      })),
      generatedAt: new Date().toISOString(),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /admin/pacware/import/patients — upload a PacWare patient report.
//
// Sync semantics: rows are matched to PennFit patients on pacware_id and
// upserted. Only the columns PRESENT in the uploaded report are written,
// so a report that omits a column never blanks that field — but a column
// that IS present with an empty cell is treated as "cleared" (PacWare is
// the demographics system of record).
//
//   mode: "preview" — parse + validate only; no DB writes. Returns counts,
//                     per-row errors, unmapped headers, and a small sample
//                     so the operator can fix the source file first.
//   mode: "commit"  — preview + upsert the valid rows.
// ---------------------------------------------------------------------------
const importBodySchema = z
  .object({
    csv: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024),
    mode: z.enum(["preview", "commit"]).default("preview"),
  })
  .strict();

// field -> patients column for the scalar columns we sync.
const SCALAR_COLUMN: Record<string, string> = {
  pacwareId: "pacware_id",
  legalFirstName: "legal_first_name",
  legalLastName: "legal_last_name",
  dateOfBirth: "date_of_birth",
  phoneE164: "phone_e164",
  email: "email",
  insurancePayer: "insurance_payer",
};
const ADDRESS_FIELDS = [
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
];

router.post(
  "/admin/pacware/import/patients",
  adminWriteRateLimiter,
  requireAdmin,
  withIdempotency("POST /admin/pacware/import/patients"),
  async (req, res) => {
    const parsed = importBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { csv, mode } = parsed.data;

    const result = parsePacwarePatientCsv(csv);
    if (result.totalDataRows > MAX_IMPORT_ROWS) {
      res.status(413).json({
        error: "too_many_rows",
        message: `This file has ${result.totalDataRows} rows; the limit per upload is ${MAX_IMPORT_ROWS}. Split the report and upload in parts.`,
      });
      return;
    }

    // Always honour no-store: the response carries PHI (sample rows /
    // re-derived data) on the preview path.
    res.setHeader("Cache-Control", "no-store");

    if (mode === "preview") {
      res.status(200).json({
        mode: "preview",
        validCount: result.rows.length,
        errorCount: result.errors.length,
        totalDataRows: result.totalDataRows,
        unmappedHeaders: result.unmappedHeaders,
        presentFields: result.presentFields,
        errors: result.errors,
        sample: result.rows.slice(0, PREVIEW_SAMPLE),
      });
      return;
    }

    // commit ---------------------------------------------------------------
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const present = new Set(result.presentFields);
    const includeAddress = ADDRESS_FIELDS.some((f) => present.has(f));

    // Dedupe within the file (last occurrence wins) so a repeated
    // pacware_id can't trip "ON CONFLICT cannot affect row twice".
    const byId = new Map<string, PacwarePatientRow>();
    for (const row of result.rows) byId.set(row.pacwareId, row);
    const deduped = [...byId.values()];

    const payload = deduped.map((row) => {
      const obj: Record<string, unknown> = {
        pacware_id: row.pacwareId,
        updated_at: nowIso,
      };
      for (const [field, column] of Object.entries(SCALAR_COLUMN)) {
        if (field === "pacwareId") continue;
        if (present.has(field)) {
          obj[column] = (row as Record<string, unknown>)[field] ?? null;
        }
      }
      if (includeAddress) obj.address = assembleAddress(row);
      return obj;
    });

    let synced = 0;
    const batchErrors: string[] = [];
    for (let i = 0; i < payload.length; i += UPSERT_BATCH) {
      const batch = payload.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .schema("resupply")
        .from("patients")
        .upsert(batch, { onConflict: "pacware_id" });
      if (error) {
        logger.warn(
          { err: error, batch_start: i, batch_size: batch.length },
          "pacware/import: batch upsert failed",
        );
        batchErrors.push(
          `Rows ${i + 1}-${i + batch.length} failed to write (database error).`,
        );
      } else {
        synced += batch.length;
      }
    }

    await logAudit({
      action: "patient.pacware_sync",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: null,
      metadata: {
        total_data_rows: result.totalDataRows,
        valid_rows: result.rows.length,
        deduped_rows: deduped.length,
        synced,
        validation_errors: result.errors.length,
        batch_errors: batchErrors.length,
        unmapped_header_count: result.unmappedHeaders.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.pacware_sync audit write failed");
    });

    res.status(200).json({
      mode: "commit",
      synced,
      validCount: result.rows.length,
      errorCount: result.errors.length,
      totalDataRows: result.totalDataRows,
      unmappedHeaders: result.unmappedHeaders,
      errors: result.errors,
      batchErrors,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /admin/pacware/export/patients.csv — roster export for PacWare.
//
// Same layout as the importer (round-trips), with the address + insurance
// columns the plain /patients/export.csv omits. Mirrors that route's
// status/search filters so "export what I'm looking at" works.
// ---------------------------------------------------------------------------
const exportPatientsQuerySchema = z
  .object({
    status: z.enum(["active", "paused", "closed"]).optional(),
  })
  .strict();

router.get(
  "/admin/pacware/export/patients.csv",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = exportPatientsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("patients")
      .select(
        "pacware_id, legal_first_name, legal_last_name, date_of_birth, phone_e164, email, address, insurance_payer",
      )
      .order("created_at", { ascending: true })
      .limit(MAX_EXPORT_ROWS + 1);
    if (parsed.data.status) query = query.eq("status", parsed.data.status);
    const { data: rows, error } = await query;
    if (error) throw error;

    const truncated = (rows?.length ?? 0) > MAX_EXPORT_ROWS;
    const slice = truncated ? rows!.slice(0, MAX_EXPORT_ROWS) : (rows ?? []);

    const records: PacwarePatientExportRecord[] = slice.map((r) => {
      const addr = (r.address ?? null) as AddressBlob | null;
      return {
        pacwareId: r.pacware_id,
        legalFirstName: r.legal_first_name,
        legalLastName: r.legal_last_name,
        dateOfBirth: r.date_of_birth,
        phoneE164: r.phone_e164,
        email: r.email,
        addressLine1: addr?.line1 ?? null,
        addressLine2: addr?.line2 ?? null,
        city: addr?.city ?? null,
        state: addr?.state ?? null,
        postalCode: addr?.postalCode ?? null,
        country: addr?.country ?? null,
        insurancePayer: r.insurance_payer,
      };
    });

    await logAudit({
      action: "patient.pacware_export",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: null,
      metadata: {
        row_count: records.length,
        truncated,
        status_filter: parsed.data.status ?? null,
        report: "patient_roster",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.pacware_export audit write failed");
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="pacware-patient-roster.csv"',
    );
    if (truncated) res.setHeader("X-Truncated", "true");
    res.status(200).send(buildPacwarePatientCsv(records));
  },
);

// ---------------------------------------------------------------------------
// GET /admin/pacware/export/resupply-due.csv — resupply worklist for
// PacWare order entry & billing. One line per due item.
// ---------------------------------------------------------------------------
const RESUPPLY_STATUSES = [
  "confirmed",
  "approved",
  "pending",
  "outreach_pending",
] as const;
const exportResupplyQuerySchema = z
  .object({
    status: z.enum(RESUPPLY_STATUSES).default("confirmed"),
  })
  .strict();

interface EpisodeJoinRow {
  id: string;
  status: string;
  due_at: string;
  prescriptions: { item_sku: string } | { item_sku: string }[] | null;
  patients:
    | {
        pacware_id: string;
        legal_first_name: string;
        legal_last_name: string;
        insurance_payer: string | null;
      }
    | {
        pacware_id: string;
        legal_first_name: string;
        legal_last_name: string;
        insurance_payer: string | null;
      }[]
    | null;
}

router.get(
  "/admin/pacware/export/resupply-due.csv",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = exportResupplyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { status } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("episodes")
      .select(
        "id, status, due_at, prescriptions!inner(item_sku), patients!inner(pacware_id, legal_first_name, legal_last_name, insurance_payer)",
      )
      .eq("status", status)
      .order("due_at", { ascending: true })
      .limit(MAX_EXPORT_ROWS + 1);
    if (error) throw error;

    const list = (rows ?? []) as unknown as EpisodeJoinRow[];
    const truncated = list.length > MAX_EXPORT_ROWS;
    const slice = truncated ? list.slice(0, MAX_EXPORT_ROWS) : list;

    const records: PacwareResupplyDueRecord[] = [];
    for (const ep of slice) {
      const rx = first(ep.prescriptions);
      const pt = first(ep.patients);
      if (!rx || !pt) continue;
      records.push({
        pacwareId: pt.pacware_id,
        legalLastName: pt.legal_last_name,
        legalFirstName: pt.legal_first_name,
        itemSku: rx.item_sku,
        quantity: 1,
        dueDate: ep.due_at.slice(0, 10),
        episodeStatus: ep.status,
        insurancePayer: pt.insurance_payer,
        episodeId: ep.id,
      });
    }

    await logAudit({
      action: "patient.pacware_export",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "episodes",
      targetId: null,
      metadata: {
        row_count: records.length,
        truncated,
        status_filter: status,
        report: "resupply_due",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.pacware_export (resupply) audit write failed",
      );
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="pacware-resupply-due.csv"',
    );
    if (truncated) res.setHeader("X-Truncated", "true");
    res.status(200).send(buildPacwareResupplyDueCsv(records));
  },
);

interface AddressBlob {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

function assembleAddress(row: PacwarePatientRow): Json | null {
  if (row.addressLine1 && row.city && row.state && row.postalCode) {
    return {
      line1: row.addressLine1,
      line2: row.addressLine2 || undefined,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country || "US",
    } as unknown as Json;
  }
  return null;
}

/** PostgREST to-one embeds may type as object or single-element array. */
function first<T>(v: T | T[] | null): T | null {
  if (v === null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export default router;
