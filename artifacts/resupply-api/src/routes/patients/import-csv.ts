// POST /patients/import-csv — admin bulk-creates patients from a
// parsed Pacware-style export.
//
// Why JSON, not multipart:
//   The dashboard parses the CSV file in the browser (with
//   papaparse) and POSTs validated JSON. Keeping the server JSON-
//   only means we don't have to worry about file-upload limits,
//   character-encoding sniffing, or partial-stream parsing on the
//   API side, and the audit row gets a clean structural metadata
//   ("X created, Y duplicates, Z errors") instead of a binary blob.
//
// Why a 500-row hard cap:
//   Each row triggers a plaintext INSERT, and we want the request
//   to finish well under the express default body-parser timeout.
//   The dashboard chunks larger imports into multiple POSTs; the
//   audit log makes it trivial to stitch them back together by
//   request id.
//
// Audit philosophy:
//   ONE audit row per call, with structural counts only. The
//   per-row outcomes flow back to the caller in the response body
//   so the admin can download an error CSV — they do NOT land in
//   the audit metadata, because errors frequently contain field
//   names like "phoneE164" alongside the bad value, and that bad
//   value may itself be PHI.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";
import { timezoneForUsState } from "@workspace/resupply-domain";

import { logger } from "../../lib/logger";
import { redactDbErr } from "../../lib/redact-db-err";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { withIdempotency } from "../../middlewares/idempotency";
import { requireAdmin } from "../../middlewares/requireAdmin";

const E164 = /^\+[1-9]\d{7,14}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const rowSchema = z
  .object({
    pacwareId: z.string().trim().min(1).max(64),
    legalFirstName: z.string().trim().min(1).max(80),
    legalLastName: z.string().trim().min(1).max(80),
    dateOfBirth: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    phoneE164: z
      .string()
      .trim()
      .regex(E164, "must be E.164 format like +14155551212")
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
    addressLine1: z.string().trim().max(160).optional(),
    addressLine2: z.string().trim().max(160).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(40).optional(),
    postalCode: z.string().trim().max(20).optional(),
    country: z.string().trim().max(40).optional(),
    insurancePayer: z.string().trim().max(120).optional(),
  })
  .strict();

const bodySchema = z
  .object({
    rows: z.array(z.unknown()).min(1).max(500),
  })
  .strict();

interface RowError {
  rowIndex: number;
  field?: string;
  message: string;
}

const router: IRouter = Router();

router.post(
  "/patients/import-csv",
  adminWriteRateLimiter,
  requireAdmin,
  withIdempotency("POST /patients/import-csv"),
  async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
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

    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();

    let created = 0;
    let skippedDuplicates = 0;
    const errors: RowError[] = [];
    const createdIds: string[] = [];

    for (let i = 0; i < parsed.data.rows.length; i++) {
      const raw = parsed.data.rows[i];
      const rowParsed = rowSchema.safeParse(raw);
      if (!rowParsed.success) {
        const first = rowParsed.error.issues[0];
        errors.push({
          rowIndex: i,
          field: first ? first.path.join(".") : undefined,
          message: first ? first.message : "invalid row",
        });
        continue;
      }
      const row = rowParsed.data;

      // Build optional address blob from the flat CSV columns. We
      // require the four core address fields together — a partial
      // address (street but no city) is more confusing than no
      // address at all.
      const hasAnyAddress =
        row.addressLine1 || row.city || row.state || row.postalCode;
      const hasFullAddress =
        row.addressLine1 && row.city && row.state && row.postalCode;
      if (hasAnyAddress && !hasFullAddress) {
        errors.push({
          rowIndex: i,
          field: "address",
          message:
            "Partial address. Provide all of addressLine1, city, state, postalCode (or none).",
        });
        continue;
      }
      const address = hasFullAddress
        ? {
            line1: row.addressLine1!,
            line2: row.addressLine2 || undefined,
            city: row.city!,
            state: row.state!,
            postalCode: row.postalCode!,
            country: row.country || "US",
          }
        : null;

      // Quiet-hours timezone from the address state; omitted when
      // underivable so the DB default (Eastern) applies.
      const derivedTimezone = timezoneForUsState(address?.state);

      const { data: inserted, error: insertErr } = await supabase
        .schema("resupply")
        .from("patients")
        .insert({
          pacware_id: row.pacwareId,
          legal_first_name: row.legalFirstName,
          legal_last_name: row.legalLastName,
          date_of_birth: row.dateOfBirth,
          phone_e164: row.phoneE164 ?? null,
          email: row.email ?? null,
          // The structured address JSON has no index signature so
          // PostgREST's `Json` type rejects it without a cast.
          address: address as unknown as Json,
          ...(derivedTimezone ? { timezone: derivedTimezone } : {}),
          status: "active",
          insurance_payer: row.insurancePayer ?? null,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select("id")
        .limit(1)
        .maybeSingle();
      if (insertErr) {
        // Mirror the create.ts duplicate-detection: 23505 + the
        // pacware_id unique constraint name = duplicate. Anything
        // else is logged and surfaced as a generic row error.
        // PostgREST surfaces the constraint name inconsistently —
        // check `constraint`, then `message`/`details`.
        const e = insertErr as {
          code?: string;
          constraint?: string;
          message?: string;
          details?: string;
        };
        const isPacwareDuplicate =
          e.code === "23505" &&
          (e.constraint === "patients_pacware_id_unique" ||
            e.message?.includes("patients_pacware_id_unique") ||
            e.details?.includes("patients_pacware_id_unique"));
        if (isPacwareDuplicate) {
          skippedDuplicates += 1;
          continue;
        }
        logger.warn(
          {
            err: redactDbErr(insertErr),
            row_index: i,
            pacware_id: row.pacwareId,
          },
          "patients/import-csv: row insert failed",
        );
        errors.push({
          rowIndex: i,
          message: "database write failed for this row",
        });
        continue;
      }
      const newId = inserted?.id;
      if (newId) {
        created += 1;
        createdIds.push(newId);
      }
    }

    await logAudit({
      action: "patient.bulk_create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: null,
      metadata: {
        row_count: parsed.data.rows.length,
        created,
        skipped_duplicates: skippedDuplicates,
        error_count: errors.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.bulk_create audit write failed");
    });

    res.status(200).json({
      created,
      skippedDuplicates,
      errors,
      createdIds,
    });
  },
);

export default router;
