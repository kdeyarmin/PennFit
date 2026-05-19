// /admin/patients/:id/prior-authorizations/:paId/submit-davinci-pas
//
// FHIR-based prior auth submission per the Da Vinci PAS IG v2.2.
// Reads the prior_authorizations row + linked patient/coverage/
// referring-provider/payer rows, builds the FHIR Bundle, POSTs to
// the payer's PAS endpoint, parses the ClaimResponse, and:
//
//   1. Inserts a davinci_pas_submissions row with the bundle id +
//      claim identifier + transport status + decision.
//   2. When the payer returns an approved/denied decision in-band,
//      updates the prior_authorizations row's status + auth_number.
//
// Auth token: pulled from env (DAVINCI_PAS_TOKEN_<PAYER_SLUG>) for
// now. Once the credentials surface lands in clearinghouse_credentials
// we'll move it there. Keeps the live-data path minimal.

import { randomUUID } from "node:crypto";

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  buildPasBundle,
  parseClaimResponse,
  submitPasBundle,
} from "@workspace/resupply-integrations-davinci-pas";

import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  paId: z.string().uuid(),
});

router.post(
  "/admin/patients/:id/prior-authorizations/:paId/submit-davinci-pas",
  requireAdmin,
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    // Load the PA row.
    const { data: pa } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select(
        "id, patient_id, insurance_coverage_id, hcpcs_code, payer_name, status",
      )
      .eq("id", idParsed.data.paId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!pa) {
      res.status(404).json({ error: "prior_auth_not_found" });
      return;
    }
    if (!pa.insurance_coverage_id) {
      res.status(409).json({
        error: "missing_coverage",
        message:
          "PA must reference an insurance_coverage row before PAS submission",
      });
      return;
    }

    // Load coverage + patient + payer profile + referring provider.
    const [
      { data: coverage },
      { data: patient },
      { data: payerProfile },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("insurance_coverages")
        .select("id, payer_name, member_id, group_number")
        .eq("id", pa.insurance_coverage_id)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("patients")
        .select("id, legal_first_name, legal_last_name, date_of_birth, address")
        .eq("id", pa.patient_id)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("payer_profiles")
        .select("id, payer_legal_name, davinci_pas_endpoint_url, slug")
        .ilike("display_name", pa.payer_name)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle(),
    ]);

    if (!coverage || !patient) {
      res.status(409).json({ error: "missing_coverage_or_patient" });
      return;
    }
    if (!payerProfile?.davinci_pas_endpoint_url) {
      res.status(409).json({
        error: "payer_no_pas_endpoint",
        message:
          "The payer hasn't published a Da Vinci PAS endpoint in payer_profiles",
      });
      return;
    }

    // Most-recent prescription gives us a referring provider NPI.
    const { data: rx } = await supabase
      .schema("resupply")
      .from("prescriptions")
      .select("provider_id")
      .eq("patient_id", patient.id)
      .order("valid_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!rx?.provider_id) {
      res.status(409).json({
        error: "missing_referring_provider",
        message: "no active prescription with a provider on file",
      });
      return;
    }
    const { data: provider } = await supabase
      .schema("resupply")
      .from("providers")
      .select("npi, legal_name")
      .eq("id", rx.provider_id)
      .limit(1)
      .maybeSingle();
    if (!provider) {
      res.status(409).json({ error: "missing_referring_provider_row" });
      return;
    }

    const identity = await resolveBillingIdentity({ supabase });
    if (identity.source === "stub") {
      res.status(409).json({
        error: "no_dme_organization",
        message: "configure dme_organization before PAS submission",
      });
      return;
    }

    const address = patient.address as
      | { line1?: string; city?: string; state?: string; zip?: string }
      | null;
    if (
      !address?.line1 ||
      !address.city ||
      !address.state ||
      !address.zip
    ) {
      res.status(409).json({
        error: "missing_patient_address",
      });
      return;
    }

    // Build + persist a queued submission row first so we have an id
    // to audit-log even if the upstream POST blows up.
    const claimIdentifier = `${pa.id.slice(0, 8)}-${Date.now().toString(36)}`;
    const bundle = buildPasBundle({
      claimIdentifier,
      preparedAt: new Date(),
      providerOrganization: {
        npi: identity.billingProvider.npi,
        name: identity.billingProvider.organizationName,
        address: identity.billingProvider.address,
      },
      requesterPractitioner: {
        npi: provider.npi,
        firstName: splitFirstName(provider.legal_name),
        lastName: splitLastName(provider.legal_name),
      },
      patient: {
        id: patient.id,
        firstName: patient.legal_first_name,
        lastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
        gender: "unknown",
        address: {
          line1: address.line1,
          city: address.city,
          state: address.state,
          zip: address.zip,
        },
      },
      coverage: {
        id: coverage.id,
        payerName: payerProfile.payer_legal_name,
        payerPasIdentifier: payerProfile.slug,
        memberId: coverage.member_id,
        groupNumber: coverage.group_number ?? null,
      },
      serviceRequest: {
        hcpcsCode: pa.hcpcs_code,
        quantity: 1,
        dateOfService: new Date().toISOString().slice(0, 10),
        diagnosisIcd10: null,
      },
    });

    const tokenEnvKey = `DAVINCI_PAS_TOKEN_${payerProfile.slug.toUpperCase()}`;
    const accessToken = process.env[tokenEnvKey] ?? "";
    if (!accessToken) {
      res.status(409).json({
        error: "no_pas_credentials",
        message: `Set ${tokenEnvKey} or store the token in clearinghouse_credentials`,
      });
      return;
    }

    const insertRow: Database["resupply"]["Tables"]["davinci_pas_submissions"]["Insert"] = {
      prior_authorization_id: pa.id,
      payer_pas_endpoint: payerProfile.davinci_pas_endpoint_url,
      bundle_id: bundle.bundleId,
      claim_identifier: claimIdentifier,
      transport_status: "queued",
      request_bundle_json: bundle.bundle as unknown as Json,
      submitted_by_email: req.adminEmail ?? "unknown",
    };
    const { data: subRow, error: insertErr } = await supabase
      .schema("resupply")
      .from("davinci_pas_submissions")
      .insert(insertRow)
      .select("id")
      .single();
    if (insertErr) throw insertErr;

    const outcome = await submitPasBundle({
      bundle: bundle.bundle,
      endpointUrl: payerProfile.davinci_pas_endpoint_url,
      accessToken,
    });

    const decision =
      outcome.status === "responded"
        ? parseClaimResponse(outcome.responseJson)
        : {
            decision: "pended" as const,
            authNumber: null,
            denialReason: null,
            dispositionText: outcome.errorMessage,
          };

    // Map decision → table column values.
    const transportStatus =
      outcome.status === "responded"
        ? "responded"
        : outcome.status === "rejected"
          ? "rejected"
          : "transport_failed";
    const update: Database["resupply"]["Tables"]["davinci_pas_submissions"]["Update"] = {
      transport_status: transportStatus,
      decision: decision.decision,
      auth_number: decision.authNumber,
      decision_at:
        outcome.status === "responded" ? new Date().toISOString() : null,
      denial_reason: decision.denialReason,
      latency_ms: outcome.latencyMs,
      error_message: outcome.errorMessage,
      responded_at:
        outcome.status === "responded" ? new Date().toISOString() : null,
    };
    await supabase
      .schema("resupply")
      .from("davinci_pas_submissions")
      .update(update)
      .eq("id", subRow.id);

    // When the PAS response carries an in-band approval/denial,
    // update the parent prior_authorizations row.
    if (outcome.status === "responded") {
      const paUpdate: Database["resupply"]["Tables"]["prior_authorizations"]["Update"] = {
        decision_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (decision.decision === "approved") {
        paUpdate.status = "approved";
        paUpdate.auth_number = decision.authNumber;
      } else if (decision.decision === "denied") {
        paUpdate.status = "denied";
        paUpdate.denial_reason = decision.denialReason;
      } else if (pa.status === "draft") {
        paUpdate.status = "submitted";
        paUpdate.submitted_at = new Date().toISOString();
      }
      await supabase
        .schema("resupply")
        .from("prior_authorizations")
        .update(paUpdate)
        .eq("id", pa.id);
    }

    await logAudit({
      action: "davinci_pas.submit",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "davinci_pas_submissions",
      targetId: subRow.id,
      metadata: {
        prior_authorization_id: pa.id,
        transport: outcome.status,
        http_status: outcome.httpStatus,
        decision: decision.decision,
        latency_ms: outcome.latencyMs,
        payer_slug: payerProfile.slug,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "davinci_pas.submit audit write failed");
    });

    const responseStatus =
      outcome.status === "responded" ? 201 : 502;
    res.status(responseStatus).json({
      submissionId: subRow.id,
      transportStatus,
      decision: decision.decision,
      authNumber: decision.authNumber,
      denialReason: decision.denialReason,
      dispositionText: decision.dispositionText,
      latencyMs: outcome.latencyMs,
    });
  },
);

function splitFirstName(legalName: string): string {
  const trimmed = legalName.trim();
  if (trimmed.includes(",")) {
    const [, rest = ""] = trimmed.split(",", 2);
    return rest.trim().split(/\s+/)[0] ?? "";
  }
  const parts = trimmed.split(/\s+/);
  return parts[0] ?? "";
}
function splitLastName(legalName: string): string {
  const trimmed = legalName.trim();
  if (trimmed.includes(",")) return trimmed.split(",", 2)[0]!.trim();
  const parts = trimmed.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1]! : trimmed;
}

// Suppress no-unused-vars on randomUUID import (kept for future
// idempotency-key generation).
void randomUUID;

export default router;
