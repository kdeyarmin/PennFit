// After a fresh shipment claim, offer the setup visit and enroll the
// 90-day check-ins. Only an open new-CPAP setup is touched, so a
// routine resupply shipment does not start another onboarding journey.
// Fail-soft: the shipment claim has already succeeded.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { redactDbErr } from "../redact-db-err";

export async function offerSetupAfterShipment(input: {
  orgId: string;
  patientId: string;
  shippedAt: Date;
}): Promise<void> {
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data: setup, error } = await supabase
      .from("patient_setups")
      .select("id, setup_visit_offered_at")
      .eq("patient_id", input.patientId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!setup?.id || setup.setup_visit_offered_at) return;

    const nowIso = new Date().toISOString();
    const { error: followErr } = await supabase
      .from("patient_followups")
      .insert({
        patient_id: input.patientId,
        body: "Machine shipped. Book the setup video visit and walk the first-night checklist.",
        due_at: nowIso,
        created_by_email: "system:setup-shipment",
      });
    if (followErr) throw followErr;

    const { data: journey, error: journeyErr } = await supabase
      .from("patient_onboarding_journeys")
      .select("id")
      .eq("patient_id", input.patientId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (journeyErr) throw journeyErr;
    if (!journey?.id) {
      const { error: enrollErr } = await supabase
        .from("patient_onboarding_journeys")
        .insert({
          patient_id: input.patientId,
          started_at: input.shippedAt.toISOString(),
          enrolled_by_email: "system:setup-shipment",
        });
      if (enrollErr && (enrollErr as { code?: string }).code !== "23505") {
        logger.warn(
          { err: redactDbErr(enrollErr) },
          "setup shipment: onboarding enroll failed",
        );
      }
    }

    const { error: stampErr } = await supabase
      .from("patient_setups")
      .update({
        setup_visit_offered_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", setup.id)
      .is("setup_visit_offered_at", null);
    if (stampErr) throw stampErr;
  } catch (err) {
    logger.warn({ err: redactDbErr(err) }, "setup shipment: offer failed");
  }
}
