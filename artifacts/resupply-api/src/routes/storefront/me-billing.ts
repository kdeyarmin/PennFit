// Patient-portal billing surface.
//
//   GET /api/me/billing-statements
//        Returns the patient's statement history (id, total,
//        delivery method, created_at) for /account/billing.
//
//   GET /api/me/billing-statements/:id/pdf
//        Re-renders the statement PDF from the persisted
//        `line_items_json` snapshot so the patient can download
//        the same statement the admin generated. We render on-
//        demand instead of persisting the PDF: PHI hygiene plus
//        the snapshot is small (≤ ~20 line items).
//
// Authentication: relies on the same storefront `attachSignedIn`
// middleware (mounted in routes/storefront/index.ts) as
// me-claims/me-payments. We never expose patient_id directly; the
// customer → patient resolution is internal.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";

import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { renderStatementPdf } from "../../lib/billing/statement-pdf";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

async function resolvePatientForCustomer(
  customerId: string,
): Promise<{ patientId: string } | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: customer, error: customerErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, email_lower")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (customerErr) throw customerErr;
  if (!customer?.email_lower) return null;
  // Fetch up to 2 rows so we can detect the ambiguous case. If more
  // than one patient record carries the customer's email (household
  // share, transcription mistake, admin catch-all), refuse to bind
  // — otherwise the wrong patient's billing statements / claim
  // balances would leak to the shopper. The right fix is a stable
  // shop_customers.patient_id FK set at registration; this guard
  // prevents the cross-patient PHI leak until that lands.
  //
  // .ilike (with escaped meta-chars) is case-INsensitive equality.
  // patient_create.ts now normalizes new emails to lowercase, but
  // legacy rows can still be stored mixed-case; the case-insensitive
  // match keeps them findable until a backfill migration normalizes
  // historical data.
  const escapedEmail = customer.email_lower.replace(
    /[\\%_]/g,
    (c: string) => `\\${c}`,
  );
  const { data: patients, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(2);
  if (patientErr) throw patientErr;
  if (!patients || patients.length !== 1) return null;
  return { patientId: patients[0]!.id };
}

router.get("/me/billing-statements", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  let link: { patientId: string } | null;
  try {
    link = await resolvePatientForCustomer(customerId);
  } catch {
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (!link) {
    res.json({ statements: [] });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .select(
      "id, total_patient_responsibility_cents, delivery_method, delivered_at, created_at, line_items_json",
    )
    .eq("patient_id", link.patientId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    logger.warn(
      { err: error.message, patientId: link.patientId },
      "me-billing.list_statements: query failed",
    );
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  res.json({
    statements: (data ?? []).map((s) => ({
      id: s.id,
      totalPatientResponsibilityCents: s.total_patient_responsibility_cents,
      // Patient doesn't care about internal counts beyond the total,
      // but the line-item count is useful context.
      lineItemCount: Array.isArray(s.line_items_json)
        ? s.line_items_json.length
        : 0,
      deliveryMethod: s.delivery_method,
      deliveredAt: s.delivered_at,
      createdAt: s.created_at,
    })),
  });
});

interface PersistedLineItem {
  claim_id: string;
  payer_name: string;
  date_of_service: string;
  billed_cents: number;
  paid_cents: number;
  patient_responsibility_cents: number;
  // Optional itemization (migration 0327); absent on statements
  // snapshotted before the breakdown shipped.
  deductible_cents?: number;
  coinsurance_cents?: number;
  copay_cents?: number;
}

router.get("/me/billing-statements/:id/pdf", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  let link: { patientId: string } | null;
  try {
    link = await resolvePatientForCustomer(customerId);
  } catch {
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (!link) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: statement, error: statementErr } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .select(
      "id, line_items_json, total_patient_responsibility_cents, created_at",
    )
    .eq("id", parsed.data.id)
    .eq("patient_id", link.patientId)
    .limit(1)
    .maybeSingle();
  if (statementErr) {
    logger.warn(
      { err: statementErr.message, statementId: parsed.data.id },
      "me-billing.statement_pdf: query failed",
    );
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (!statement) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Pull patient + dme org for the PDF header. We deliberately
  // re-resolve everything from the source-of-truth tables instead
  // of trusting any cached header on the statement row — if the
  // org changes its address, the patient downloading an old
  // statement should see the current org details rather than a
  // stale snapshot.
  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("legal_first_name, legal_last_name, address, email")
    .eq("id", link.patientId)
    .limit(1)
    .maybeSingle();
  if (patientErr) {
    logger.warn(
      { err: patientErr.message, patientId: link.patientId },
      "me-billing.statement_pdf: patient query failed",
    );
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (!patient) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const identity = await resolveBillingIdentity({ supabase });
  if (identity.source === "stub") {
    res.status(503).json({ error: "billing_identity_unconfigured" });
    return;
  }

  const lineItemsRaw = statement.line_items_json;
  const lineItems = (Array.isArray(lineItemsRaw) ? lineItemsRaw : []).map(
    (li) => {
      const item = li as unknown as PersistedLineItem;
      return {
        claimId: item.claim_id,
        payerName: item.payer_name,
        dateOfService: item.date_of_service,
        billedCents: item.billed_cents,
        paidCents: item.paid_cents,
        patientResponsibilityCents: item.patient_responsibility_cents,
        deductibleCents: item.deductible_cents,
        coinsuranceCents: item.coinsurance_cents,
        copayCents: item.copay_cents,
      };
    },
  );

  const address = patient.address as {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    zip?: string;
  } | null;
  let pdf: Buffer;
  try {
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
      lineItems,
    });
    pdf = result.pdf;
  } catch (err) {
    logger.warn({ err }, "billing_statement.pdf render failed");
    res.status(500).json({ error: "render_failed" });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="statement-${statement.id.slice(0, 8)}.pdf"`,
  );
  res.setHeader(
    "X-Statement-Total-Cents",
    String(statement.total_patient_responsibility_cents),
  );
  // Discourage shared-cache storage of a per-patient PDF.
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).end(pdf);
});

// ── Statement delivery preference (emailed vs mailed). ─────────────
//
// Lets a signed-in patient choose how they receive their bills. Mirrors
// the admin control (routes/admin/billing-statements.ts). When a patient
// opts into emailed statements and the patient record has no email on
// file, we backfill it from their account email so the bill has a
// destination.

const prefBody = z
  .object({ statementDeliveryMethod: z.enum(["email", "mail"]) })
  .strict();

router.get("/me/statement-preferences", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  let link: { patientId: string } | null;
  try {
    link = await resolvePatientForCustomer(customerId);
  } catch {
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (!link) {
    res.json({ statementDeliveryMethod: "mail", email: null, linked: false });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("email, statement_delivery_method")
    .eq("id", link.patientId)
    .limit(1)
    .maybeSingle();
  res.json({
    statementDeliveryMethod:
      (patient?.statement_delivery_method as string | null) || "mail",
    email: (patient?.email as string | null) ?? null,
    linked: true,
  });
});

router.put("/me/statement-preferences", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = prefBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  let link: { patientId: string } | null;
  try {
    link = await resolvePatientForCustomer(customerId);
  } catch {
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (!link) {
    res.status(409).json({ error: "not_linked" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const update: Database["resupply"]["Tables"]["patients"]["Update"] = {
    statement_delivery_method: parsed.data.statementDeliveryMethod,
    updated_at: new Date().toISOString(),
  };
  // Opting into email but no email on the patient record → backfill from
  // the account email so the emailed bill has somewhere to go.
  if (parsed.data.statementDeliveryMethod === "email") {
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("email")
      .eq("id", link.patientId)
      .limit(1)
      .maybeSingle();
    if (!patient?.email) {
      const { data: cust } = await supabase
        .schema("resupply")
        .from("shop_customers")
        .select("email_lower")
        .eq("customer_id", customerId)
        .limit(1)
        .maybeSingle();
      if (cust?.email_lower) update.email = cust.email_lower as string;
    }
  }
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("patients")
    .update(update)
    .eq("id", link.patientId)
    .select("email, statement_delivery_method")
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn(
      { err: error.message, patientId: link.patientId },
      "me-billing.set_statement_preference: update failed",
    );
    res.status(500).json({ error: "update_failed" });
    return;
  }
  res.json({
    statementDeliveryMethod:
      (row?.statement_delivery_method as string | null) || "mail",
    email: (row?.email as string | null) ?? null,
  });
});

export default router;
