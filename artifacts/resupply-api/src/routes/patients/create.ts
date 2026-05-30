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
//     stored as plaintext text/jsonb columns. The application is
//     no longer HIPAA-grade — see ADR notes in repo root for the
//     decision to strip the pgcrypto layer.
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
//   The patients table stores DOB as a YYYY-MM-DD string. Coercing
//   through a Date introduces timezone bugs (a birthday set at
//   midnight UTC can render as the prior day in eastern browsers).
//   The string-only contract makes the storage representation
//   explicit at the API boundary.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Json,
  getSupabaseServiceRoleClient,
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
      // Normalize to lowercase so cross-table joins against
      // shop_customers.email_lower match. Storefront /me/* resolvers
      // do `.eq("email", customer.email_lower)` to bind a shop
      // customer to a patient record; without this normalization a
      // patient created with "Alice@Example.com" was invisible to
      // their own claims / billing pages.
      .transform((v) => (v === "" || v == null ? null : v.toLowerCase())),
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

    const supabase = getSupabaseServiceRoleClient();

    // Build the insert payload. PHI columns are plaintext text/jsonb
    // post-migration 0025, so values pass through directly. `status`
    // defaults to active when the body omits it — same default as
    // the schema's `.default("active")`.
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insErr } = await supabase
      .schema("resupply")
      .from("patients")
      .insert({
        pacware_id: body.pacwareId,
        legal_first_name: body.legalFirstName,
        legal_last_name: body.legalLastName,
        date_of_birth: body.dateOfBirth,
        phone_e164: body.phoneE164 ?? null,
        email: body.email ?? null,
        address: (body.address ?? null) as unknown as Json,
        status: body.status ?? "active",
        insurance_payer: body.insurancePayer ?? null,
        cadence_override_days: body.cadenceOverrideDays ?? null,
        channel_preference: body.channelPreference ?? null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .single();
    if (insErr) {
      // Postgres unique-violation on patients_pacware_id_unique → 409.
      // We check BOTH the SQLSTATE code (23505) AND the constraint
      // name so a future unique index on (say) email doesn't silently
      // get misclassified as a "duplicate Pacware id" — that would be
      // a confusing error in the UI and a debugging dead end. Any
      // other DB error bubbles up to the express error handler.
      if (
        insErr.code === "23505" &&
        // PostgREST surfaces the constraint name in `details` as
        // "Key (pacware_id)=(...) already exists.", so we match
        // either the constraint name (when available) or the column
        // mention in details.
        (/patients_pacware_id_unique/.test(insErr.message ?? "") ||
          /pacware_id/.test(insErr.details ?? ""))
      ) {
        res.status(409).json({
          error: "duplicate_pacware_id",
          message: `Pacware id "${body.pacwareId}" is already in use.`,
        });
        return;
      }
      throw insErr;
    }
    const id = inserted.id;

    // Phone search now hits the indexed `patients.phone_e164`
    // column directly (see ./list.ts), so there's no separate
    // lookup table to backfill on intake.

    // Audit: list of fields the admin actually populated. NO PHI
    // values; the column names alone are safe — they're enums of
    // schema fields, not patient data.
    const populated: string[] = [
      "pacwareId",
      "legalFirstName",
      "legalLastName",
      "dateOfBirth",
    ];
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
        adminUserId: req.adminUserId ?? null,
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
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "patients.create: audit write failed",
      );
    }

    res.status(201).json({ id });
  },
);

export default router;
