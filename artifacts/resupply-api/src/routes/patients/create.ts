// POST /patients — admin-initiated patient creation.
//
// Lets a PennPaps admin enter a brand-new patient into the
// system from the dashboard, without waiting for a Pacware CSV
// import. The body carries every field the admin console
// reasonably knows at intake — Pacware id, name, DOB, contact
// methods, address, lifecycle status, and the optional outreach-
// plan overrides (insurance payer, cadence, channel).
//
// PHI handling:
//   - First name, last name, DOB, phone, email, and address are
//     pgcrypto-encrypted at the SQL site via encrypt() / encryptJson()
//     helpers. They never land in plaintext in any column.
//   - The audit row records WHICH fields were provided (so the
//     auditor can reconstruct intake completeness) but NEVER the
//     values themselves — those exist in the patient row, sanitised
//     metadata is precisely the place not to duplicate them.
//
// Conflict semantics:
//   - pacware_id is unique. A duplicate returns 409 with a body
//     the dashboard can render as "this Pacware id already exists".
//
// Why we don't accept dateOfBirth as a Date object:
//   The patients table stores DOB as a YYYY-MM-DD encrypted string.
//   Coercing through a Date introduces timezone bugs (a birthday
//   set at midnight UTC can render as the prior day in eastern
//   browsers). The string-only contract makes the storage
//   representation explicit at the API boundary.

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
import { withIdempotency } from "../../middlewares/idempotency";
import { requireAdmin } from "../../middlewares/requireAdmin";

// E.164: leading "+" then 8-15 digits. Loose enough to accept any
// real phone number; strict enough that "555-1212" is rejected at
// the boundary instead of going downstream into Twilio.
const E164 = /^\+[1-9]\d{7,14}$/;

// YYYY-MM-DD. We deliberately do NOT use z.date() — see file header.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(120),
    line2: z.string().trim().max(120).optional(),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().min(1).max(40),
    postalCode: z.string().trim().min(1).max(20),
    country: z.string().trim().min(1).max(40),
  })
  .strict();

const bodySchema = z
  .object({
    pacwareId: z.string().trim().min(1).max(64),
    legalFirstName: z.string().trim().min(1).max(80),
    legalLastName: z.string().trim().min(1).max(80),
    dateOfBirth: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    phoneE164: z
      .string()
      .trim()
      .regex(E164, "must be E.164 format like +14155551212")
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    address: addressSchema.nullable().optional(),
    status: z.enum(["active", "paused", "closed"]).optional(),
    insurancePayer: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    cadenceOverrideDays: z.number().int().min(1).max(365).nullable().optional(),
    channelPreference: z.enum(["sms", "email", "voice"]).nullable().optional(),
  })
  .strict();

const router: IRouter = Router();

router.post(
  "/patients",
  requireAdmin,
  withIdempotency("POST /patients"),
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
  const body = parsed.data;

  const db = drizzle(getDbPool());

  // Build the insert payload. Encrypted columns are SQL fragments
  // (encrypt() / encryptJson() return SQL); plaintext columns pass
  // through as-is. `status` defaults to active when the body omits it
  // — same default as the schema's `.default("active")`.
  const now = new Date();
  try {
    const inserted = await db
      .insert(patients)
      .values({
        pacwareId: body.pacwareId,
        legalFirstName: encrypt(body.legalFirstName),
        legalLastName: encrypt(body.legalLastName),
        dateOfBirth: encrypt(body.dateOfBirth),
        phoneE164: encrypt(body.phoneE164 ?? null),
        email: encrypt(body.email ?? null),
        address: body.address
          ? encryptJson(body.address)
          : encryptJson(null),
        status: body.status ?? "active",
        insurancePayer: body.insurancePayer ?? null,
        cadenceOverrideDays: body.cadenceOverrideDays ?? null,
        channelPreference: body.channelPreference ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: patients.id });

    const id = inserted[0]?.id;
    if (!id) {
      // Should be impossible — RETURNING on a single insert always
      // yields one row. Fail loudly rather than respond with a
      // half-shaped success.
      throw new Error("INSERT returned no rows");
    }

    // Backfill phone_lookup so the admin can search by phone
    // immediately after intake (before any outbound SMS goes out
    // and lazily populates the index). Failure here is loud-but-
    // non-fatal: the patient row exists; phone search will just
    // be unavailable until the first SMS lazily upserts it.
    if (body.phoneE164) {
      const normalized = normalizeE164(body.phoneE164);
      if (normalized) {
        try {
          const hash = hmacPhone(normalized);
          await db
            .insert(phoneLookup)
            .values({ patientId: id, hmacPhone: hash })
            .onConflictDoUpdate({
              target: phoneLookup.patientId,
              set: { hmacPhone: hash, updatedAt: new Date() },
            });
        } catch (err) {
          // Two real-world causes:
          //   1. RESUPPLY_PHONE_HMAC_KEY isn't set (dev environment).
          //   2. Another patient already owns this hmac (data quality
          //      issue surfaced by the unique index — admin will need
          //      to triage). Either way, we don't want to fail the
          //      whole create.
          logger.warn(
            { err, patient_id: id },
            "patients.create: phone_lookup backfill failed",
          );
        }
      }
    }

    // Audit: list of fields the admin actually populated. NO PHI
    // values; the column names alone are safe — they're enums of
    // schema fields, not patient data.
    const populated: string[] = ["pacwareId", "legalFirstName", "legalLastName", "dateOfBirth"];
    if (body.phoneE164) populated.push("phoneE164");
    if (body.email) populated.push("email");
    if (body.address) populated.push("address");
    if (body.insurancePayer) populated.push("insurancePayer");
    if (body.cadenceOverrideDays != null) populated.push("cadenceOverrideDays");
    if (body.channelPreference) populated.push("channelPreference");

    try {
      await logAudit({
        action: "patient.create",
        adminEmail: req.adminEmail ?? null,
        adminClerkId: req.adminClerkId ?? null,
        targetTable: "patients",
        targetId: id,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: {
          fields: populated,
          status: body.status ?? "active",
        },
      });
    } catch (err) {
      // Audit-log failures are loud-but-non-fatal: the patient row is
      // already in the DB, so failing the response would tell the
      // admin "create failed" when in fact it succeeded. Surface the
      // failure in logs so we can chase it up out-of-band.
      logger.error(
        { err: err instanceof Error ? { name: err.name, message: err.message } : err },
        "patients.create: audit write failed",
      );
    }

    res.status(201).json({ id });
  } catch (err) {
    // Postgres unique-violation on patients_pacware_id_unique → 409.
    // We check BOTH the SQLSTATE code (23505) AND the constraint name
    // so a future unique index on (say) email doesn't silently get
    // misclassified as a "duplicate Pacware id" — that would be a
    // confusing error in the UI and a debugging dead end. Any other
    // DB error bubbles up to the express error handler, which logs
    // and returns 500.
    const dbErr = err as
      | { code?: string; constraint?: string }
      | null
      | undefined;
    if (
      dbErr?.code === "23505" &&
      dbErr.constraint === "patients_pacware_id_unique"
    ) {
      res.status(409).json({
        error: "duplicate_pacware_id",
        message: `Pacware id "${body.pacwareId}" is already in use.`,
      });
      return;
    }
    throw err;
  }
});

export default router;
