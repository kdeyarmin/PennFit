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
import { openPatientSetup } from "./open-setup";

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
      if (!packet.ok) input.warnings.push("packet_not_sent");
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
        await verifyEligibility({
          insuranceCoverageId: coverage.id,
          patientId: input.patientId,
          hcpcsCode: "E0601",
          requestedByEmail: actor,
          orgId: input.orgId,
        });
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

    if (/medicare/i.test(coverage?.payer_name ?? "")) {
      const drafted = await draftE0601PriorAuth({
        orgId: input.orgId,
        patientId: input.patientId,
        payerName: coverage?.payer_name?.trim() || "Medicare",
        coverageId: coverage?.id ?? null,
      });
      if (!drafted) input.warnings.push("prior_auth_not_drafted");
    }
  } catch (err) {
    logger.warn({ err: redactDbErr(err) }, "setup kickoff failed");
    if (!input.warnings.includes("setup_not_opened")) {
      input.warnings.push("setup_kickoff_failed");
    }
  }
}

async function draftE0601PriorAuth(input: {
  orgId: string;
  patientId: string;
  payerName: string;
  coverageId: string | null;
}): Promise<boolean> {
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data: existing, error: readErr } = await supabase
      .from("prior_authorizations")
      .select("id")
      .eq("patient_id", input.patientId)
      .eq("hcpcs_code", "E0601")
      .in("status", ["draft", "submitted", "approved", "appealed"])
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (existing?.id) return true;
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from("prior_authorizations").insert({
      patient_id: input.patientId,
      insurance_coverage_id: input.coverageId,
      hcpcs_code: "E0601",
      payer_name: input.payerName,
      status: "draft",
      notes:
        "Drafted when the referral was accepted. A person sends this. It is not submitted to the payer.",
      created_at: nowIso,
      updated_at: nowIso,
    });
    if (error) throw error;
    return true;
  } catch (err) {
    logger.warn(
      { err: redactDbErr(err) },
      "setup kickoff: draft prior auth failed",
    );
    return false;
  }
}
