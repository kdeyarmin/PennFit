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
import { logger } from "../../lib/logger";
import { publishEvent } from "../../lib/webhooks/publisher";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const body = z
  .object({
    payByDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    paymentUrl: z.string().url().max(500).nullable().optional(),
    deliveryMethod: z.enum(["email", "sms", "mail", "in_person"]).optional(),
  })
  .strict()
  .optional();

router.get(
  "/admin/patients/:id/billing-statements",
  requireAdmin,
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
  requireAdmin,
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
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("legal_first_name, legal_last_name, address, email")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    // Pull every claim with non-zero patient responsibility.
    const { data: claims } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, payer_name, date_of_service, total_billed_cents, total_paid_cents, patient_responsibility_cents",
      )
      .eq("patient_id", idParsed.data.id)
      .gt("patient_responsibility_cents", 0)
      .in("status", ["paid", "denied", "appealed", "closed"])
      .order("date_of_service", { ascending: false });
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
    const address = patient.address as
      | { line1?: string; line2?: string; city?: string; state?: string; zip?: string }
      | null;
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

    const insertRow: Database["resupply"]["Tables"]["patient_billing_statements"]["Insert"] = {
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
      delivery_method: bodyParsed.data?.deliveryMethod ?? null,
      generated_by_email: req.adminEmail ?? "unknown",
    };
    const { data: row, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .insert(insertRow)
      .select("id")
      .single();
    if (insertErr) throw insertErr;

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
    res.status(201).end(result.pdf);
  },
);

export default router;
