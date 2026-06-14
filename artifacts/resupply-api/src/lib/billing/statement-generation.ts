// Shared patient-responsibility statement generation.
//
// Both the admin route and the billing automation need to create the same
// durable artifact: a patient_billing_statements row with a line-item
// snapshot, a rendered PDF, and the patient's delivery preference stamped at
// generation time. Keeping the workflow here prevents automation from
// creating sendable placeholder rows that have no detail behind them.

import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { resolveBillingIdentity } from "./identity-resolver";
import { renderStatementPdf } from "./statement-pdf";
import { persistStatementPdfCopy } from "./statement-storage";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

const CLAIM_PAGE = 1000;
const MAX_CLAIM_PAGES = 10;

export type StatementGenerationErrorCode =
  | "patient_not_found"
  | "claim_set_too_large"
  | "no_open_balance"
  | "no_dme_organization";

export class StatementGenerationError extends Error {
  code: StatementGenerationErrorCode;
  status: number;

  constructor(
    code: StatementGenerationErrorCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "StatementGenerationError";
    this.code = code;
    this.status = status;
  }
}

export interface GeneratePatientBillingStatementInput {
  patientId: string;
  payByDate?: string | null;
  paymentUrl?: string | null;
  deliveryMethod?: "email" | "sms" | "mail" | "in_person";
  generatedByEmail: string;
  adminUserId?: string | null;
  supabase?: SupabaseClient;
}

export interface GeneratedPatientBillingStatement {
  statementId: string;
  pdf: Buffer;
  totalPatientResponsibilityCents: number;
  claimCount: number;
  deliveryMethod: "email" | "sms" | "mail" | "in_person";
  chartDocumentId: string | null;
}

export async function generatePatientBillingStatement(
  input: GeneratePatientBillingStatementInput,
): Promise<GeneratedPatientBillingStatement> {
  const supabase = input.supabase ?? getSupabaseServiceRoleClient();

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select(
      "legal_first_name, legal_last_name, address, email, statement_delivery_method",
    )
    .eq("id", input.patientId)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) {
    throw new StatementGenerationError(
      "patient_not_found",
      "patient not found",
      404,
    );
  }

  const claims: Array<{
    id: string;
    payer_name: string;
    date_of_service: string;
    total_billed_cents: number;
    total_paid_cents: number;
    patient_responsibility_cents: number;
    deductible_cents: number;
    coinsurance_cents: number;
    copay_cents: number;
  }> = [];
  let exhausted = false;
  for (let page = 0; page < MAX_CLAIM_PAGES; page++) {
    const { data: batch, error: claimsErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, payer_name, date_of_service, total_billed_cents, total_paid_cents, patient_responsibility_cents, deductible_cents, coinsurance_cents, copay_cents",
      )
      .eq("patient_id", input.patientId)
      .gt("patient_responsibility_cents", 0)
      .in("status", ["paid", "denied", "appealed", "closed"])
      .order("date_of_service", { ascending: false })
      .order("id", { ascending: true })
      .range(page * CLAIM_PAGE, page * CLAIM_PAGE + CLAIM_PAGE - 1);
    if (claimsErr) throw claimsErr;
    claims.push(...(batch ?? []));
    if (!batch || batch.length < CLAIM_PAGE) {
      exhausted = true;
      break;
    }
  }
  if (!exhausted) {
    throw new StatementGenerationError(
      "claim_set_too_large",
      `patient has more than ${CLAIM_PAGE * MAX_CLAIM_PAGES} open-responsibility claims; refusing to generate a potentially incomplete statement`,
      500,
    );
  }
  if (claims.length === 0) {
    throw new StatementGenerationError(
      "no_open_balance",
      "patient has no claims with patient_responsibility_cents > 0",
      409,
    );
  }

  const identity = await resolveBillingIdentity({ supabase });
  if (identity.source === "stub") {
    throw new StatementGenerationError(
      "no_dme_organization",
      "configure dme_organization first",
      409,
    );
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
      deductibleCents: c.deductible_cents,
      coinsuranceCents: c.coinsurance_cents,
      copayCents: c.copay_cents,
    })),
    payByDate: input.payByDate,
    paymentUrl: input.paymentUrl,
  });

  const deliveryMethod = (input.deliveryMethod ??
    patient.statement_delivery_method ??
    "mail") as "email" | "sms" | "mail" | "in_person";

  const insertRow: Database["resupply"]["Tables"]["patient_billing_statements"]["Insert"] =
    {
      patient_id: input.patientId,
      line_items_json: claims.map((c) => ({
        claim_id: c.id,
        payer_name: c.payer_name,
        date_of_service: c.date_of_service,
        billed_cents: c.total_billed_cents,
        paid_cents: c.total_paid_cents,
        patient_responsibility_cents: c.patient_responsibility_cents,
        deductible_cents: c.deductible_cents,
        coinsurance_cents: c.coinsurance_cents,
        copay_cents: c.copay_cents,
      })) as unknown as Json,
      total_patient_responsibility_cents:
        result.totalPatientResponsibilityCents,
      delivery_method: deliveryMethod,
      generated_by_email: input.generatedByEmail,
    };

  const { data: row, error: insertErr } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .insert(insertRow)
    .select("id")
    .single();
  if (insertErr) throw insertErr;

  const persisted = await persistStatementPdfCopy({
    patientId: input.patientId,
    statementId: row.id,
    pdf: result.pdf,
    adminUserId: input.adminUserId ?? null,
  });

  if (
    input.generatedByEmail === "system:auto_workflow" &&
    !persisted.objectKey
  ) {
    await supabase
      .schema("resupply")
      .from("patient_billing_statements")
      .delete()
      .eq("id", row.id);
    throw new Error(
      "auto-workflow statement PDF could not be persisted; refusing to arm statement cooldown",
    );
  }

  return {
    statementId: row.id,
    pdf: result.pdf,
    totalPatientResponsibilityCents: result.totalPatientResponsibilityCents,
    claimCount: claims.length,
    deliveryMethod,
    chartDocumentId: persisted.chartDocumentId,
  };
}
