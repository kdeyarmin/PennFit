// What accepting a referral starts, after the chart exists. Every
// step is fail-soft: a packet, eligibility call, fitter invite, or
// draft prior auth that cannot be written is a warning on the accept
// response, not a failed accept. The patient still does not place
// the order.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { verifyEligibility } from "../billing/eligibility-verifier";
import { logger } from "../logger";
import { createAndSendPatientPacket } from "../patient-packet/send";
import { redactDbErr } from "../redact-db-err";
import { issueFitterInviteForPatient } from "../../routes/admin/fitter-invites";
import { escapeIlikeExact } from "./email-match";
import { openPatientSetup } from "./open-setup";
import { e0601PriorAuthRequired } from "./prior-auth";

export async function kickoffAcceptedReferral(input: {
  orgId: string;
  patientId: string;
  sourceId: string;
  ownerUserId: string | null;
  actorEmail: string | null;
  warnings: string[];
}): Promise<void> {
  const actor = input.actorEmail?.trim() || "system:setup-kickoff";
  try {
    const opened = await openPatientSetup({
      orgId: input.orgId,
      patientId: input.patientId,
      source: "referral",
      sourceId: input.sourceId,
      ownerUserId: input.ownerUserId,
      ownerEmail: input.actorEmail,
    });
    if (!opened) input.warnings.push("setup_not_opened");

    const supabase = getOrgScopedClient(input.orgId);
    try {
      const packet = await createAndSendPatientPacket({
        supabase,
        patientId: input.patientId,
        title: "New patient packet",
        createdByEmail: actor,
      });
      if (!packet.ok || (!packet.emailSent && !packet.smsSent)) {
        input.warnings.push("packet_not_sent");
      }
    } catch (err) {
      logger.warn(
        { err: redactDbErr(err) },
        "setup kickoff: packet send failed",
      );
      input.warnings.push("packet_not_sent");
    }

    const { data: coverage, error: coverageErr } = await supabase
      .from("insurance_coverages")
      .select("id, payer_name, member_id")
      .eq("patient_id", input.patientId)
      .eq("rank", "primary")
      .limit(1)
      .maybeSingle();
    if (coverageErr) throw coverageErr;

    const memberId = coverage?.member_id?.trim() ?? "";
    if (coverage?.id && memberId) {
      try {
        const eligibility = await verifyEligibility({
          insuranceCoverageId: coverage.id,
          patientId: input.patientId,
          hcpcsCode: "E0601",
          requestedByEmail: actor,
          orgId: input.orgId,
        });
        if (!eligibility.uploadOk) input.warnings.push("eligibility_not_run");
      } catch (err) {
        logger.warn(
          { err: redactDbErr(err) },
          "setup kickoff: eligibility failed",
        );
        input.warnings.push("eligibility_not_run");
      }
    }

    const invite = await issueFitterInviteForPatient({
      orgId: input.orgId,
      patientId: input.patientId,
      invitedByUserId: input.ownerUserId,
      invitedByEmail: input.actorEmail,
    });
    if (!invite.ok || !invite.delivered) {
      input.warnings.push("fitter_invite_not_sent");
      const { error: followErr } = await supabase
        .from("patient_followups")
        .insert({
          patient_id: input.patientId,
          body: "New CPAP setup: the fitter link could not be sent. Offer it from Fitter invites.",
          due_at: new Date().toISOString(),
          created_by_email: actor,
          created_by_user_id: input.ownerUserId,
        });
      if (followErr) {
        logger.warn(
          { err: redactDbErr(followErr) },
          "setup kickoff: fitter follow-up failed",
        );
      }
    }

    const drafted = await ensureE0601PriorAuthDraft({
      orgId: input.orgId,
      patientId: input.patientId,
    });
    if (drafted === "failed") input.warnings.push("prior_auth_not_drafted");
  } catch (err) {
    logger.warn({ err: redactDbErr(err) }, "setup kickoff failed");
    if (!input.warnings.includes("setup_not_opened")) {
      input.warnings.push("setup_kickoff_failed");
    }
  }
}

export async function ensureE0601PriorAuthDraft(input: {
  orgId: string;
  patientId: string;
}): Promise<"not_required" | "ready" | "failed"> {
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data: coverage, error: coverageErr } = await supabase
      .from("insurance_coverages")
      .select("id, payer_name")
      .eq("patient_id", input.patientId)
      .eq("rank", "primary")
      .limit(1)
      .maybeSingle();
    if (coverageErr) throw coverageErr;
    if (!coverage?.id) return "not_required";

    const payerName = coverage.payer_name?.trim() ?? "";
    let payerRequires: boolean | null = null;
    if (payerName) {
      const { data: profiles, error: payerErr } = await supabase
        .from("payer_profiles")
        .select("display_name, requires_prior_auth_dme")
        .eq("is_active", true)
        .ilike("display_name", escapeIlikeExact(payerName))
        .limit(5);
      if (payerErr) throw payerErr;
      const exact = (
        (profiles ?? []) as Array<{
          display_name: string | null;
          requires_prior_auth_dme: boolean | null;
        }>
      ).find(
        (row) =>
          row.display_name?.trim().toLowerCase() === payerName.toLowerCase(),
      );
      payerRequires = exact ? exact.requires_prior_auth_dme === true : null;
    }

    const { data: check, error: checkErr } = await supabase
      .from("eligibility_checks")
      .select("requires_prior_auth")
      .eq("insurance_coverage_id", coverage.id)
      .eq("service_hcpcs", "E0601")
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (checkErr) throw checkErr;

    if (
      !e0601PriorAuthRequired({
        payerRequiresPriorAuthDme: payerRequires,
        eligibilityRequiresPriorAuth: check?.requires_prior_auth ?? null,
      })
    ) {
      return "not_required";
    }

    const { data: existing, error: readErr } = await supabase
      .from("prior_authorizations")
      .select("id")
      .eq("patient_id", input.patientId)
      .eq("hcpcs_code", "E0601")
      .in("status", ["draft", "submitted", "approved", "appealed"])
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (existing?.id) return "ready";

    const nowIso = new Date().toISOString();
    const { error } = await supabase.from("prior_authorizations").insert({
      patient_id: input.patientId,
      insurance_coverage_id: coverage.id,
      hcpcs_code: "E0601",
      payer_name: payerName || "Payer",
      status: "draft",
      notes:
        "Drafted for this new CPAP setup. A person sends this. It is not submitted to the payer.",
      created_at: nowIso,
      updated_at: nowIso,
    });
    if (error) throw error;
    return "ready";
  } catch (err) {
    logger.warn(
      { err: redactDbErr(err) },
      "setup kickoff: draft prior auth failed",
    );
    return "failed";
  }
}
