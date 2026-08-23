// submitPriorAuth — the Da Vinci PAS submission core, extracted from the
// inline route handler (routes/admin/davinci-pas-submit.ts) so BOTH the manual
// admin button AND the automation worker can reuse the exact same path (the
// bundle-build + SSRF-pin + identifier-binding logic must never diverge).
//
// It returns a structured result instead of writing an HTTP response, so the
// route maps it to a status and the worker can call it directly. Every
// pre-submit validation that the route used to answer with a 4xx becomes an
// `ok: false` result carrying the same `code` + suggested `httpStatus`.

import {
  type Database,
  type Json,
  getOrgScopedClient,
} from "@workspace/resupply-db";
import {
  buildPasBundle,
  parseClaimResponse,
  submitPasBundle,
} from "@workspace/resupply-integrations-davinci-pas";

import { logAudit } from "@workspace/resupply-audit";

import {
  davinciPasTokenEnvKey,
  resolveDavinciPasToken,
} from "./davinci-pas-token";
import { resolveBillingIdentity } from "./identity-resolver";
import { redactDbErr } from "../redact-db-err";
import { logger } from "../logger";
import {
  assertSafeOutboundHost,
  assertSafeOutboundUrlSync,
  fetchWithPinnedIp,
  SsrfError,
} from "../safe-outbound";

export interface SubmitPriorAuthInput {
  orgId: string;
  patientId: string;
  paId: string;
  quantity?: number;
  // Audit attribution. The worker passes a synthetic actor; the route passes
  // the signed-in admin.
  actorEmail: string | null;
  adminUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type SubmitPriorAuthResult =
  | {
      ok: true;
      httpStatus: 201 | 502;
      submissionId: string;
      transportStatus: string;
      decision: "approved" | "denied" | "pended" | "cancelled";
      authNumber: string | null;
      denialReason: string | null;
      dispositionText: string | null;
      latencyMs: number | null;
    }
  | {
      ok: false;
      httpStatus: number;
      code: string;
      message?: string;
    };

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

export async function submitPriorAuth(
  input: SubmitPriorAuthInput,
): Promise<SubmitPriorAuthResult> {
  const { orgId, patientId, paId } = input;
  const supabase = getOrgScopedClient(orgId);

  // Load the PA row.
  const { data: pa } = await supabase
    .from("prior_authorizations")
    .select(
      "id, patient_id, insurance_coverage_id, hcpcs_code, payer_name, status",
    )
    .eq("id", paId)
    .eq("patient_id", patientId)
    .limit(1)
    .maybeSingle();
  if (!pa) {
    return { ok: false, httpStatus: 404, code: "prior_auth_not_found" };
  }
  if (!pa.insurance_coverage_id) {
    return {
      ok: false,
      httpStatus: 409,
      code: "missing_coverage",
      message:
        "PA must reference an insurance_coverage row before PAS submission",
    };
  }

  // Resolve the diagnosis ICD-10 from the patient's latest sleep study — the
  // same source the claim builder and preflight use. A PAS request with no
  // diagnosis is rejected by every payer, so block here rather than submit a
  // guaranteed-reject request.
  const { data: sleep } = await supabase
    .from("sleep_studies")
    .select("diagnosis_icd10")
    .eq("patient_id", pa.patient_id)
    .not("diagnosis_icd10", "is", null)
    .order("study_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const diagnosisIcd10 = sleep?.diagnosis_icd10 ?? null;
  if (!diagnosisIcd10) {
    return {
      ok: false,
      httpStatus: 409,
      code: "no_diagnosis_on_file",
      message:
        "no sleep study with a diagnosis_icd10 is on file for this patient — required for PAS submission",
    };
  }

  // Load coverage + patient + payer profile.
  const [{ data: coverage }, { data: patient }, { data: payerProfile }] =
    await Promise.all([
      supabase
        .from("insurance_coverages")
        .select("id, payer_name, member_id, group_number")
        .eq("id", pa.insurance_coverage_id)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("patients")
        .select("id, legal_first_name, legal_last_name, date_of_birth, address")
        .eq("id", pa.patient_id)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("payer_profiles")
        .select("id, payer_legal_name, davinci_pas_endpoint_url, slug")
        .ilike("display_name", pa.payer_name)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle(),
    ]);

  if (!coverage || !patient) {
    return { ok: false, httpStatus: 409, code: "missing_coverage_or_patient" };
  }
  if (!payerProfile?.davinci_pas_endpoint_url) {
    return {
      ok: false,
      httpStatus: 409,
      code: "payer_no_pas_endpoint",
      message:
        "The payer hasn't published a Da Vinci PAS endpoint in payer_profiles",
    };
  }

  // SSRF guard — mirror the route's https-only + reject-internal posture, then
  // pin the resolved IP so the POST can't be DNS-rebound to internal space
  // between this check and connect time (the access token is Bearer-forwarded).
  let pasUrl: URL;
  let pasPinnedIp: string;
  try {
    pasUrl = assertSafeOutboundUrlSync(payerProfile.davinci_pas_endpoint_url);
    pasPinnedIp = await assertSafeOutboundHost(pasUrl.hostname);
  } catch (err) {
    const reason = err instanceof SsrfError ? err.reason : "unsafe_url";
    logger.warn(
      { event: "davinci_pas.submit.unsafe_endpoint", reason, paId: pa.id },
      "davinci-pas submit refused: payer PAS endpoint failed SSRF validation",
    );
    return {
      ok: false,
      httpStatus: 409,
      code: "unsafe_pas_endpoint",
      message:
        "The payer's Da Vinci PAS endpoint must be a public HTTPS URL. Fix payer_profiles.davinci_pas_endpoint_url.",
    };
  }

  // Most-recent prescription gives us a referring provider NPI.
  const { data: rx } = await supabase
    .from("prescriptions")
    .select("provider_id")
    .eq("patient_id", patient.id)
    .order("valid_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!rx?.provider_id) {
    return {
      ok: false,
      httpStatus: 409,
      code: "missing_referring_provider",
      message: "no active prescription with a provider on file",
    };
  }
  // providers is a global (non-tenant-scoped) table.
  const { data: provider } = await supabase
    .raw()
    .schema("resupply")
    .from("providers")
    .select("npi, legal_name")
    .eq("id", rx.provider_id)
    .limit(1)
    .maybeSingle();
  if (!provider) {
    return {
      ok: false,
      httpStatus: 409,
      code: "missing_referring_provider_row",
    };
  }

  const identity = await resolveBillingIdentity({ orgId });
  if (identity.source === "stub") {
    return {
      ok: false,
      httpStatus: 409,
      code: "no_dme_organization",
      message: "configure dme_organization before PAS submission",
    };
  }

  const address = patient.address as {
    line1?: string;
    city?: string;
    state?: string;
    zip?: string;
  } | null;
  if (!address?.line1 || !address.city || !address.state || !address.zip) {
    return { ok: false, httpStatus: 409, code: "missing_patient_address" };
  }

  // Build + persist a queued submission row first so we have an id to
  // audit-log even if the upstream POST blows up.
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
      quantity: input.quantity ?? 1,
      dateOfService: new Date().toISOString().slice(0, 10),
      diagnosisIcd10,
    },
  });

  // Resolve the payer's PAS Bearer token: a stored, org-scoped
  // davinci_pas_credentials row wins, falling back to the legacy
  // DAVINCI_PAS_TOKEN_<SLUG> env var when no row exists (current deploy +
  // dev/preview). Neither present → the same no_pas_credentials 409 as before.
  // The token is a secret and is never logged.
  const accessToken = await resolveDavinciPasToken({
    orgId,
    payerSlug: payerProfile.slug,
  });
  if (!accessToken) {
    return {
      ok: false,
      httpStatus: 409,
      code: "no_pas_credentials",
      message: `Store the token in davinci_pas_credentials for this payer, or set ${davinciPasTokenEnvKey(
        payerProfile.slug,
      )}`,
    };
  }

  const insertRow: Database["resupply"]["Tables"]["davinci_pas_submissions"]["Insert"] =
    {
      prior_authorization_id: pa.id,
      payer_pas_endpoint: payerProfile.davinci_pas_endpoint_url,
      bundle_id: bundle.bundleId,
      claim_identifier: claimIdentifier,
      transport_status: "queued",
      request_bundle_json: bundle.bundle as unknown as Json,
      submitted_by_email: input.actorEmail ?? "unknown",
    };
  const { data: subRow, error: insertErr } = await supabase
    .from("davinci_pas_submissions")
    .insert(insertRow)
    .select("id")
    .single();
  if (insertErr) throw insertErr;

  const outcome = await submitPasBundle({
    bundle: bundle.bundle,
    endpointUrl: payerProfile.davinci_pas_endpoint_url,
    accessToken,
    fetchImpl: (i, init) =>
      fetchWithPinnedIp(
        fetch,
        typeof i === "string" ? i : i instanceof URL ? i.href : i.url,
        pasPinnedIp,
        pasUrl.hostname,
        init,
      ),
  });

  const parsedDecision =
    outcome.status === "responded"
      ? parseClaimResponse(outcome.responseJson)
      : {
          decision: "pended" as const,
          authNumber: null,
          denialReason: null,
          dispositionText: outcome.errorMessage,
          requestIdentifier: null,
        };

  // Identifier-binding check: the payer MUST echo back our claimIdentifier. A
  // missing/mismatched echo is treated as transport-failed rather than applied
  // (a misrouted / replayed / compromised payload could overwrite the wrong PA).
  let decision = parsedDecision;
  let identifierMismatched = false;
  if (
    outcome.status === "responded" &&
    parsedDecision.requestIdentifier !== claimIdentifier
  ) {
    identifierMismatched = true;
    decision = {
      decision: "pended" as const,
      authNumber: null,
      denialReason: null,
      dispositionText: `payer ClaimResponse identifier mismatch (expected "${claimIdentifier}", got "${parsedDecision.requestIdentifier ?? "<none>"}")`,
      requestIdentifier: parsedDecision.requestIdentifier,
    };
  }

  const transportStatus = identifierMismatched
    ? "transport_failed"
    : outcome.status === "responded"
      ? "responded"
      : outcome.status === "rejected"
        ? "rejected"
        : "transport_failed";
  const update: Database["resupply"]["Tables"]["davinci_pas_submissions"]["Update"] =
    {
      transport_status: transportStatus,
      decision: decision.decision,
      auth_number: decision.authNumber,
      decision_at:
        outcome.status === "responded" && !identifierMismatched
          ? new Date().toISOString()
          : null,
      denial_reason: decision.denialReason,
      latency_ms: outcome.latencyMs,
      error_message: identifierMismatched
        ? decision.dispositionText
        : outcome.errorMessage,
      responded_at:
        outcome.status === "responded" ? new Date().toISOString() : null,
    };
  const { error: subUpdateErr } = await supabase
    .from("davinci_pas_submissions")
    .update(update)
    .eq("id", subRow.id);
  if (subUpdateErr) throw subUpdateErr;

  // Apply an in-band, identifier-matched approval/denial to the parent PA row.
  if (outcome.status === "responded" && !identifierMismatched) {
    const paUpdate: Database["resupply"]["Tables"]["prior_authorizations"]["Update"] =
      {
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
    const { error: paUpdateErr } = await supabase
      .from("prior_authorizations")
      .update(paUpdate)
      .eq("id", pa.id);
    if (paUpdateErr) throw paUpdateErr;
  }

  await logAudit({
    action: "davinci_pas.submit",
    adminEmail: input.actorEmail ?? null,
    adminUserId: input.adminUserId ?? null,
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
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  }).catch((err) => {
    logger.warn(
      { err: redactDbErr(err) },
      "davinci_pas.submit audit write failed",
    );
  });

  return {
    ok: true,
    httpStatus: outcome.status === "responded" ? 201 : 502,
    submissionId: subRow.id,
    transportStatus,
    decision: decision.decision,
    authNumber: decision.authNumber,
    denialReason: decision.denialReason,
    dispositionText: decision.dispositionText,
    latencyMs: outcome.latencyMs,
  };
}
