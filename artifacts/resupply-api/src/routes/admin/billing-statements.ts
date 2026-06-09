// /admin/patients/:id/billing-statements
//
//   POST   — render + persist a statement covering every open balance.
//   GET    — list prior statements for the patient.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { renderStatementPdf } from "../../lib/billing/statement-pdf";
import { persistStatementPdfCopy } from "../../lib/billing/statement-storage";
import { logger } from "../../lib/logger";
import { publishEvent } from "../../lib/webhooks/publisher";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const body = z
  .object({
    payByDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    paymentUrl: z.string().url().max(500).nullable().optional(),
    deliveryMethod: z.enum(["email", "sms", "mail", "in_person"]).optional(),
  })
  .strict()
  .optional();

router.get(
  "/admin/patients/:id/billing-statements",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .select("*")
      .eq("patient_id", parsed.data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    res.json({ statements: data ?? [] });
  },
);

router.post(
  "/admin/patients/:id/billing-statements",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "patient_billing_statements.create",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = body.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "legal_first_name, legal_last_name, address, email, statement_delivery_method",
      )
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    // Pull every claim with non-zero patient responsibility.
    const { data: claims, error: claimsErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, payer_name, date_of_service, total_billed_cents, total_paid_cents, patient_responsibility_cents",
      )
      .eq("patient_id", idParsed.data.id)
      .gt("patient_responsibility_cents", 0)
      .in("status", ["paid", "denied", "appealed", "closed"])
      .order("date_of_service", { ascending: false });
    if (claimsErr) throw claimsErr;
    if (!claims || claims.length === 0) {
      res.status(409).json({
        error: "no_open_balance",
        message: "patient has no claims with patient_responsibility_cents > 0",
      });
      return;
    }
    const identity = await resolveBillingIdentity({ supabase });
    if (identity.source === "stub") {
      res.status(409).json({
        error: "no_dme_organization",
        message: "configure dme_organization first",
      });
      return;
    }
    const address = patient.address as {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      zip?: string;
    } | null;
    const result = await renderStatementPdf({
      patient: {
        name: `${patient.legal_first_name} ${patient.legal_last_name}`,
        address: address?.line1
          ? {
              line1: address.line1,
              line2: address.line2,
              city: address.city ?? "",
              state: address.state ?? "",
              zip: address.zip ?? "",
            }
          : undefined,
        email: patient.email,
      },
      dmeOrganization: {
        legalName:
          identity.organization?.legal_name ??
          identity.billingProvider.organizationName,
        addressLine1: identity.billingProvider.address.line1,
        city: identity.billingProvider.address.city,
        state: identity.billingProvider.address.state,
        zip: identity.billingProvider.address.zip,
        phoneE164: identity.organization?.phone_e164 ?? "+10000000000",
        billingEmail:
          identity.organization?.billing_email ?? "billing@example.com",
      },
      lineItems: claims.map((c) => ({
        claimId: c.id,
        payerName: c.payer_name,
        dateOfService: c.date_of_service,
        billedCents: c.total_billed_cents,
        paidCents: c.total_paid_cents,
        patientResponsibilityCents: c.patient_responsibility_cents,
      })),
      payByDate: bodyParsed.data?.payByDate,
      paymentUrl: bodyParsed.data?.paymentUrl,
    });

    const insertRow: Database["resupply"]["Tables"]["patient_billing_statements"]["Insert"] =
      {
        patient_id: idParsed.data.id,
        line_items_json: claims.map((c) => ({
          claim_id: c.id,
          payer_name: c.payer_name,
          date_of_service: c.date_of_service,
          billed_cents: c.total_billed_cents,
          paid_cents: c.total_paid_cents,
          patient_responsibility_cents: c.patient_responsibility_cents,
        })) as unknown as Json,
        total_patient_responsibility_cents:
          result.totalPatientResponsibilityCents,
        // Segregate at generation time: stamp the patient's emailed-vs-
        // mailed preference (migration 0257) unless the caller explicitly
        // overrode the method. The send path keys off this: 'email' →
        // emailed; 'mail' → routed to the print/mail worklist. (DB
        // constrains the patient column to 'email' | 'mail'.)
        delivery_method: (bodyParsed.data?.deliveryMethod ??
          patient.statement_delivery_method ??
          "mail") as "email" | "sms" | "mail" | "in_person",
        generated_by_email: req.adminEmail ?? "unknown",
      };
    const { data: row, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .insert(insertRow)
      .select("id")
      .single();
    if (insertErr) throw insertErr;

    // Persist the rendered PDF to object storage + file a copy in the
    // patient chart (patient_documents). Fail-soft: never blocks the
    // generate response — the snapshot + on-demand portal re-render
    // still work if storage hiccups.
    const persisted = await persistStatementPdfCopy({
      patientId: idParsed.data.id,
      statementId: row.id,
      pdf: result.pdf,
      adminUserId: req.adminUserId ?? null,
    });

    await logAudit({
      action: "billing_statement.generate",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_billing_statements",
      targetId: row.id,
      metadata: {
        patient_id: idParsed.data.id,
        claim_count: claims.length,
        total_cents: result.totalPatientResponsibilityCents,
        delivery_method: insertRow.delivery_method,
        filed_to_chart: persisted.chartDocumentId !== null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "billing_statement.generate audit write failed");
    });
    void publishEvent({
      eventType: "billing_statement.generated",
      payload: {
        statement_id: row.id,
        patient_id: idParsed.data.id,
        total_cents: result.totalPatientResponsibilityCents,
        claim_count: claims.length,
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="statement-${row.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("X-Statement-Id", row.id);
    res.setHeader(
      "X-Statement-Total-Cents",
      String(result.totalPatientResponsibilityCents),
    );
    res.setHeader(
      "X-Statement-Delivery-Method",
      String(insertRow.delivery_method ?? ""),
    );
    res.status(201).end(result.pdf);
  },
);

// ── Per-patient statement delivery preference (emailed vs mailed). ──
//
// CSRs collect the patient's email + how they want their bills delivered
// here; the portal exposes the same toggle (routes/storefront/me-billing).
const deliveryBody = z
  .object({
    statementDeliveryMethod: z.enum(["email", "mail"]).optional(),
    // Pass a string to set, null to clear. Collected alongside the
    // preference so an emailed statement has somewhere to go.
    email: z.union([z.string().trim().email().max(180), z.null()]).optional(),
  })
  .strict();

router.get(
  "/admin/patients/:id/statement-delivery",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: patient, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("email, statement_delivery_method")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    res.json({
      statementDeliveryMethod:
        (patient.statement_delivery_method as string | null) || "mail",
      email: (patient.email as string | null) ?? null,
    });
  },
);

router.patch(
  "/admin/patients/:id/statement-delivery",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "patient_statement_delivery.update",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = deliveryBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (
      bodyParsed.data.statementDeliveryMethod === undefined &&
      bodyParsed.data.email === undefined
    ) {
      res.status(400).json({ error: "no_fields" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const update: Database["resupply"]["Tables"]["patients"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (bodyParsed.data.statementDeliveryMethod !== undefined) {
      update.statement_delivery_method =
        bodyParsed.data.statementDeliveryMethod;
    }
    if (bodyParsed.data.email !== undefined) {
      update.email = bodyParsed.data.email
        ? bodyParsed.data.email.toLowerCase()
        : null;
    }
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patients")
      .update(update)
      .eq("id", idParsed.data.id)
      .select("email, statement_delivery_method")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    await logAudit({
      action: "patient.statement_delivery.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: idParsed.data.id,
      metadata: {
        patient_id: idParsed.data.id,
        statement_delivery_method: bodyParsed.data.statementDeliveryMethod,
        email_set: bodyParsed.data.email !== undefined,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.statement_delivery.update audit failed");
    });

    res.json({
      statementDeliveryMethod:
        (row.statement_delivery_method as string | null) || "mail",
      email: (row.email as string | null) ?? null,
    });
  },
);

export default router;
