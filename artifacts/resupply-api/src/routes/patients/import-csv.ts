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
//   Each row triggers an INSERT + 1-2 encrypt() pgcrypto round-trips,
//   and we want the request to finish well under the express
//   default body-parser timeout. The dashboard chunks larger imports
//   into multiple POSTs; the audit log makes it trivial to stitch
//   them back together by request id.
//
// Audit philosophy:
//   ONE audit row per call, with structural counts only. The
//   per-row outcomes flow back to the caller in the response body
//   so the admin can download an error CSV — they do NOT land in
//   the audit metadata, because errors frequently contain field
//   names like "phoneE164" alongside the bad value, and that bad
//   value may itself be PHI.

import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  encrypt,
  encryptJson,
  getDbPool,
  hmacPhone,
  normalizeE164,
  patients,
  phoneLookup,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
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

router.post("/patients/import-csv", requireAdmin, async (req, res) => {
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

  const db = drizzle(getDbPool());
  const now = new Date();

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

    try {
      const inserted = await db
        .insert(patients)
        .values({
          pacwareId: row.pacwareId,
          legalFirstName: encrypt(row.legalFirstName),
          legalLastName: encrypt(row.legalLastName),
          dateOfBirth: encrypt(row.dateOfBirth),
          phoneE164: encrypt(row.phoneE164 ?? null),
          email: encrypt(row.email ?? null),
          address: address ? encryptJson(address) : encryptJson(null),
          status: "active",
          insurancePayer: row.insurancePayer ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: patients.id });
      const newId = inserted[0]?.id;
      if (newId) {
        created += 1;
        createdIds.push(newId);

        // Backfill phone_lookup so admins can search by phone right
        // after import (without waiting for the first SMS to lazily
        // populate it). Failure is non-fatal — we log a warn and
        // move on; phone search will be unavailable for this row
        // until the next outbound SMS.
        if (row.phoneE164) {
          const normalized = normalizeE164(row.phoneE164);
          if (normalized) {
            try {
              const hash = hmacPhone(normalized);
              await db
                .insert(phoneLookup)
                .values({ patientId: newId, hmacPhone: hash })
                .onConflictDoUpdate({
                  target: phoneLookup.patientId,
                  set: { hmacPhone: hash, updatedAt: new Date() },
                });
            } catch (lookupErr) {
              logger.warn(
                { err: lookupErr, row_index: i, patient_id: newId },
                "patients/import-csv: phone_lookup backfill failed",
              );
            }
          }
        }
      }
    } catch (err) {
      // Mirror the create.ts duplicate-detection: 23505 + the
      // pacware_id unique constraint name = duplicate. Anything
      // else is logged and surfaced as a generic row error.
      const e = err as { code?: unknown; constraint?: unknown };
      if (
        e &&
        e.code === "23505" &&
        e.constraint === "patients_pacware_id_unique"
      ) {
        skippedDuplicates += 1;
        continue;
      }
      logger.warn(
        { err, row_index: i, pacware_id: row.pacwareId },
        "patients/import-csv: row insert failed",
      );
      errors.push({
        rowIndex: i,
        message: "database write failed for this row",
      });
    }
  }

  await logAudit({
    action: "patient.bulk_create",
    adminEmail: req.adminEmail ?? null,
    adminClerkId: req.adminClerkId ?? null,
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
});

export default router;
