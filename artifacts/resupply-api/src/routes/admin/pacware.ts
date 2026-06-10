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

import { Router, type IRouter, type Response } from "express";
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
// Rows per existing-patient lookup chunk. Bounded so the `.in(pacware_id,…)`
// query URL stays well under PostgREST/proxy limits.
const READ_CHUNK = 200;
const MAX_EXPORT_ROWS = 5000;
// Columns read to decide which fields are already populated (fill-only sync).
const EXISTING_SELECT =
  "id, pacware_id, legal_first_name, legal_last_name, date_of_birth, phone_e164, email, insurance_payer, address";
// Sample size returned by the sync verify endpoints.
const VERIFY_SAMPLE = 25;

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
//                     per-row errors, and unmapped headers (NO patient rows
//                     — see the PHI note below) so the operator can fix the
//                     source file first.
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
// The fields that make up a complete address. The import only touches the
// `address` column when one of THESE is present in the report — a report
// carrying only `address_line2` or `country` must not trigger an address
// write (assembleAddress would yield null and blank an existing address).
const CORE_ADDRESS_FIELDS = ["addressLine1", "city", "state", "postalCode"];

router.post(
  "/admin/pacware/import/patients",
  adminWriteRateLimiter,
  requireAdmin,
  withIdempotency("POST /admin/pacware/import/patients"),
  async (req, res) => {
    if (!ensurePacwareEnabled(res)) return;
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

    // no-store on every response from this route, as defence in depth.
    res.setHeader("Cache-Control", "no-store");

    if (mode === "preview") {
      // Deliberately NO parsed patient rows in the body. The preview is
      // counts + structural errors (row/field/message — never the bad
      // value) + which columns mapped. Returning sample rows would put PHI
      // in the response, and if a caller passed an Idempotency-Key the
      // idempotency middleware would persist that PHI. Counts/errors are
      // PHI-free and safe to cache/replay.
      res.status(200).json({
        mode: "preview",
        validCount: result.rows.length,
        errorCount: result.errors.length,
        totalDataRows: result.totalDataRows,
        unmappedHeaders: result.unmappedHeaders,
        presentFields: result.presentFields,
        errors: result.errors,
      });
      return;
    }

    // commit ---------------------------------------------------------------
    // "Never overwrite": a sync FILLS blank PennFit fields from the report
    // but never changes a field that already holds a value. New patients are
    // inserted in full; existing patients only get their currently-empty
    // optional fields filled. Required fields (name, DOB) are NOT NULL on
    // existing rows, so they are never touched.
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const present = new Set(result.presentFields);
    const includeAddress = CORE_ADDRESS_FIELDS.some((f) => present.has(f));

    // Dedupe within the file (last occurrence wins).
    const byId = new Map<string, PacwarePatientRow>();
    for (const row of result.rows) byId.set(row.pacwareId, row);
    const deduped = [...byId.values()];

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const batchErrors: string[] = [];

    for (let i = 0; i < deduped.length; i += READ_CHUNK) {
      const chunk = deduped.slice(i, i + READ_CHUNK);
      const ids = chunk.map((r) => r.pacwareId);

      // Read which of these already exist + their current values, so we can
      // fill only the blanks.
      const { data: existingRows, error: lookupErr } = await supabase
        .schema("resupply")
        .from("patients")
        .select(EXISTING_SELECT)
        .in("pacware_id", ids);
      if (lookupErr) {
        logger.warn(
          { err: lookupErr, chunk_start: i, chunk_size: chunk.length },
          "pacware/import: existing-lookup failed",
        );
        batchErrors.push(
          `Rows ${i + 1}-${i + chunk.length} could not be checked (database error).`,
        );
        continue;
      }
      const existingById = new Map<string, Record<string, unknown>>();
      for (const r of existingRows ?? []) {
        existingById.set(
          (r as { pacware_id: string }).pacware_id,
          r as Record<string, unknown>,
        );
      }

      const inserts: Record<string, unknown>[] = [];
      const fillUpdates: { id: string; patch: Record<string, unknown> }[] = [];
      for (const row of chunk) {
        const existing = existingById.get(row.pacwareId);
        if (!existing) {
          inserts.push(buildInsert(row, present, includeAddress, nowIso));
          continue;
        }
        const patch = buildFillPatch(row, existing, present, includeAddress);
        if (Object.keys(patch).length === 0) {
          unchanged += 1;
        } else {
          patch.updated_at = nowIso;
          fillUpdates.push({ id: existing.id as string, patch });
        }
      }

      // Insert all new patients in this chunk in one call.
      if (inserts.length > 0) {
        const { error: insErr } = await supabase
          .schema("resupply")
          .from("patients")
          .insert(inserts);
        if (insErr) {
          logger.warn(
            { err: insErr, chunk_start: i, insert_count: inserts.length },
            "pacware/import: insert failed",
          );
          batchErrors.push(
            `${inserts.length} new patient(s) near row ${i + 1} failed to write (database error).`,
          );
        } else {
          created += inserts.length;
        }
      }

      // Fill existing patients one at a time (only their blank fields — rare
      // once a roster has synced once). Independent writes so one failure
      // doesn't abort the rest.
      for (const u of fillUpdates) {
        const { error: updErr } = await supabase
          .schema("resupply")
          .from("patients")
          .update(u.patch)
          .eq("id", u.id);
        if (updErr) {
          logger.warn(
            { err: updErr, patient_id: u.id },
            "pacware/import: fill-update failed",
          );
          batchErrors.push("A patient fill-update failed (database error).");
        } else {
          updated += 1;
        }
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
        created,
        updated,
        unchanged,
        validation_errors: result.errors.length,
        batch_errors: batchErrors.length,
        unmapped_header_count: result.unmappedHeaders.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.pacware_sync audit write failed");
    });

    // If any write failed, return a non-2xx. The idempotency middleware only
    // persists 2xx, so a retry with the same key re-runs the sync instead of
    // replaying a partial result — and the sync is fill-only + keyed on
    // pacware_id, so re-running over rows that already landed is a no-op.
    const httpStatus = batchErrors.length > 0 ? 502 : 200;
    res.status(httpStatus).json({
      mode: "commit",
      created,
      updated,
      unchanged,
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
    if (!ensurePacwareEnabled(res)) return;
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

    const records: PacwarePatientExportRecord[] = slice.map(
      toPatientExportRecord,
    );

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
        pacware_id: string | null;
        legal_first_name: string;
        legal_last_name: string;
        insurance_payer: string | null;
      }
    | {
        pacware_id: string | null;
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
    if (!ensurePacwareEnabled(res)) return;
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

    const records = toResupplyRecords(slice);

    await logAudit({
      // Distinct from the patient-roster export's action: this is
      // episode-scoped, so a patient-scoped action name would make audit
      // filtering/alerting ambiguous.
      action: "resupply.pacware_export",
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

// ---------------------------------------------------------------------------
// Verify-before-sync previews. The "Sync to PacWare" buttons call these to
// show the admin exactly WHAT will be synced (a count + a sample of the
// actual rows) before they download the CSV. PHI sample → no-store, admin-
// gated. No idempotency wrapping (GET), so the PHI sample is never persisted.
// ---------------------------------------------------------------------------
router.get(
  "/admin/pacware/sync/patients/preview",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    if (!ensurePacwareEnabled(res)) return;
    const parsed = exportPatientsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let countQ = supabase
      .schema("resupply")
      .from("patients")
      .select("id", { count: "exact", head: true });
    if (parsed.data.status) countQ = countQ.eq("status", parsed.data.status);
    const { count, error: countErr } = await countQ;
    if (countErr) throw countErr;

    let sampleQ = supabase
      .schema("resupply")
      .from("patients")
      .select(
        "pacware_id, legal_first_name, legal_last_name, date_of_birth, phone_e164, email, address, insurance_payer",
      )
      .order("created_at", { ascending: true })
      .limit(VERIFY_SAMPLE);
    if (parsed.data.status) sampleQ = sampleQ.eq("status", parsed.data.status);
    const { data: rows, error } = await sampleQ;
    if (error) throw error;

    res.setHeader("Cache-Control", "no-store");
    res.json({
      target: "patient_roster",
      count: count ?? 0,
      sample: (rows ?? []).map(toPatientExportRecord),
    });
  },
);

router.get(
  "/admin/pacware/sync/resupply-due/preview",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    if (!ensurePacwareEnabled(res)) return;
    const parsed = exportResupplyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { status } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { count, error: countErr } = await supabase
      .schema("resupply")
      .from("episodes")
      .select("id, prescriptions!inner(id), patients!inner(id)", {
        count: "exact",
        head: true,
      })
      .eq("status", status);
    if (countErr) throw countErr;

    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("episodes")
      .select(
        "id, status, due_at, prescriptions!inner(item_sku), patients!inner(pacware_id, legal_first_name, legal_last_name, insurance_payer)",
      )
      .eq("status", status)
      .order("due_at", { ascending: true })
      .limit(VERIFY_SAMPLE);
    if (error) throw error;

    res.setHeader("Cache-Control", "no-store");
    res.json({
      target: "resupply_due",
      status,
      count: count ?? 0,
      sample: toResupplyRecords((rows ?? []) as unknown as EpisodeJoinRow[]),
    });
  },
);

// ---------------------------------------------------------------------------
// Sync mode settings + live pending counts.
//
//   GET  → { autoSync, pending: { resupplyDue, patients } }.
//   PUT  → set autoSync (auto = the page proactively shows a "ready to sync"
//          notice; manual = sync only when an admin clicks). The toggle is
//          stored in app_config under a non-catalog key, so it never leaks
//          into the env overlay.
//
// PacWare has no API and the server FS is ephemeral, so "auto" never pushes
// PHI anywhere on its own — it only surfaces the pending counts so an admin
// can verify + download. The counts are computed live here.
// ---------------------------------------------------------------------------
const settingsBodySchema = z.object({ autoSync: z.boolean() }).strict();

router.get(
  "/admin/pacware/settings",
  adminReadRateLimiter,
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    if (!ensurePacwareEnabled(res)) return;
    const supabase = getSupabaseServiceRoleClient();
    const [autoSync, pending] = await Promise.all([
      readPacwareAutoSync(supabase),
      getPendingCounts(supabase),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ autoSync, pending, generatedAt: new Date().toISOString() });
  },
);

router.put(
  "/admin/pacware/settings",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    if (!ensurePacwareEnabled(res)) return;
    const parsed = settingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("app_config")
      .upsert(
        {
          key: AUTO_SYNC_KEY,
          value: parsed.data.autoSync ? "true" : "false",
          updated_by_user_id: req.adminUserId ?? null,
          updated_by_email: req.adminEmail ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" },
      );
    if (error) throw error;

    await logAudit({
      action: "pacware.settings_update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "app_config",
      targetId: null,
      metadata: { auto_sync: parsed.data.autoSync },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "pacware.settings_update audit write failed");
    });

    res.json({ autoSync: parsed.data.autoSync });
  },
);

/**
 * Enforce the PACWARE_EXCHANGE_DISABLED kill switch on the data routes.
 * Returns true when the surface is enabled; otherwise writes a 503 and
 * returns false. `/status` is intentionally exempt so it can still report
 * the disabled state to the admin UI.
 */
function ensurePacwareEnabled(res: Response): boolean {
  if (pacwareAvailability().status === "disabled") {
    res.status(503).json({
      error: "pacware_disabled",
      message:
        "The PacWare exchange is disabled (PACWARE_EXCHANGE_DISABLED=1).",
    });
    return false;
  }
  return true;
}

interface AddressBlob {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

/**
 * Build the INSERT row for a brand-new patient: every present field (empty
 * optionals become null), plus updated_at. `status`/`created_at` fall to
 * DB defaults.
 */
function buildInsert(
  row: PacwarePatientRow,
  present: Set<string>,
  includeAddress: boolean,
  nowIso: string,
): Record<string, unknown> {
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
}

/**
 * Build a FILL-ONLY patch for an existing patient: include a column only
 * when the report carries a non-empty value AND the patient's current value
 * is blank. Never overwrites a populated field. Returns {} when there's
 * nothing to fill.
 */
function buildFillPatch(
  row: PacwarePatientRow,
  existing: Record<string, unknown>,
  present: Set<string>,
  includeAddress: boolean,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(SCALAR_COLUMN)) {
    if (field === "pacwareId") continue;
    if (!present.has(field)) continue;
    const incoming = (row as Record<string, unknown>)[field];
    if (isBlank(incoming)) continue; // nothing in the report to fill with
    if (!isBlank(existing[column])) continue; // already populated — leave it
    patch[column] = incoming;
  }
  // Address is a single JSON column: only fill it when it's currently blank
  // and the report carries a complete address.
  if (includeAddress && isBlank(existing.address)) {
    const addr = assembleAddress(row);
    if (addr !== null) patch.address = addr;
  }
  return patch;
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

/** Map a patients row to the export record. Shared by export + verify so
 *  the "what you'll sync" preview can never diverge from the downloaded file. */
function toPatientExportRecord(
  r: Record<string, unknown>,
): PacwarePatientExportRecord {
  const addr = (r.address ?? null) as AddressBlob | null;
  return {
    // Blank cell for patients with no PacWare account number yet —
    // the operator assigns one in PacWare; the roster importer only
    // matches on non-blank ids, so a re-import can't collide.
    pacwareId: (r.pacware_id as string | null) ?? "",
    legalFirstName: r.legal_first_name as string,
    legalLastName: r.legal_last_name as string,
    dateOfBirth: r.date_of_birth as string,
    phoneE164: (r.phone_e164 as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    addressLine1: addr?.line1 ?? null,
    addressLine2: addr?.line2 ?? null,
    city: addr?.city ?? null,
    state: addr?.state ?? null,
    postalCode: addr?.postalCode ?? null,
    country: addr?.country ?? null,
    insurancePayer: (r.insurance_payer as string | null) ?? null,
  };
}

/** Flatten episode⋈prescription⋈patient rows into resupply-due records.
 *  Shared by export + verify. */
function toResupplyRecords(list: EpisodeJoinRow[]): PacwareResupplyDueRecord[] {
  const out: PacwareResupplyDueRecord[] = [];
  for (const ep of list) {
    const rx = first(ep.prescriptions);
    const pt = first(ep.patients);
    if (!rx || !pt) continue;
    out.push({
      pacwareId: pt.pacware_id ?? "",
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
  return out;
}

// Non-catalog app_config key — stored as a plain row, ignored by the env
// overlay (loadOverridesFromDb filters to catalog keys).
const AUTO_SYNC_KEY = "pacware.auto_sync";

type SupabaseSr = ReturnType<typeof getSupabaseServiceRoleClient>;

/** Read the auto-sync toggle. Fail-soft to false (manual) on any error. */
async function readPacwareAutoSync(supabase: SupabaseSr): Promise<boolean> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("app_config")
    .select("value")
    .eq("key", AUTO_SYNC_KEY)
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn({ err: error }, "pacware: auto_sync read failed");
    return false;
  }
  return (data as { value?: string } | null)?.value === "true";
}

/** Live "ready to sync" counts for the in-app notice. */
async function getPendingCounts(
  supabase: SupabaseSr,
): Promise<{ resupplyDue: number; patients: number }> {
  const [resupply, patients] = await Promise.all([
    supabase
      .schema("resupply")
      .from("episodes")
      .select("id, prescriptions!inner(id), patients!inner(id)", {
        count: "exact",
        head: true,
      })
      .eq("status", "confirmed"),
    supabase
      .schema("resupply")
      .from("patients")
      .select("id", { count: "exact", head: true }),
  ]);
  return {
    resupplyDue: resupply.count ?? 0,
    patients: patients.count ?? 0,
  };
}

export default router;
