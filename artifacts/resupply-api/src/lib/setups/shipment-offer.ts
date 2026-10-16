// After shipment evidence, offer the setup visit and enroll the
// 90-day check-ins. Only the open setup's E0601 machine fulfillment
// counts, so a mask or filter shipment does not start the journey.
//
// Follow-up and enrollment are stamped separately. A failed enroll
// leaves setup_visit_offered_at empty so a later replay can finish
// the step without writing a second follow-up.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { redactDbErr } from "../redact-db-err";
import { isMachineFulfillment } from "./machine-order";
import { linkOpenSetupToE0601Order } from "./open-setup";

const FOLLOW_UP =
  "Machine shipped. Book the setup video visit and walk the first-night checklist.";

export async function offerSetupAfterShipment(input: {
  orgId: string;
  patientId: string;
  shippedAt: Date;
  fulfillmentId: string;
  csrOrderRequestId: string | null;
  itemSku: string | null;
}): Promise<void> {
  if (!input.csrOrderRequestId) return;
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data: order, error: orderErr } = await supabase
      .from("csr_order_requests")
      .select("id, items, patient_id")
      .eq("id", input.csrOrderRequestId)
      .limit(1)
      .maybeSingle();
    if (orderErr) throw orderErr;
    if (!order?.id || !isMachineFulfillment(input.itemSku, order.items)) return;

    if (order.patient_id) {
      await linkOpenSetupToE0601Order({
        orgId: input.orgId,
        patientId: order.patient_id,
        orderId: order.id,
        items: order.items,
      });
    }

    const { data: setup, error } = await supabase
      .from("patient_setups")
      .select(
        "id, csr_order_request_id, followup_created_at, onboarding_enrolled_at, setup_visit_offered_at",
      )
      .eq("patient_id", input.patientId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!setup?.id || setup.csr_order_request_id !== order.id) return;
    if (setup.setup_visit_offered_at) return;

    const nowIso = new Date().toISOString();
    const followupReady = await ensureFollowUp(supabase, {
      patientId: input.patientId,
      setupId: setup.id,
      alreadyStamped: Boolean(setup.followup_created_at),
      nowIso,
    });
    const enrolled = await ensureOnboarding(supabase, {
      patientId: input.patientId,
      setupId: setup.id,
      shippedAt: input.shippedAt,
      alreadyStamped: Boolean(setup.onboarding_enrolled_at),
      nowIso,
    });
    if (!followupReady || !enrolled) return;

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

async function ensureFollowUp(
  supabase: ReturnType<typeof getOrgScopedClient>,
  input: {
    patientId: string;
    setupId: string;
    alreadyStamped: boolean;
    nowIso: string;
  },
): Promise<boolean> {
  if (input.alreadyStamped) return true;
  const { data: existing, error: readErr } = await supabase
    .from("patient_followups")
    .select("id")
    .eq("patient_id", input.patientId)
    .eq("body", FOLLOW_UP)
    .is("completed_at", null)
    .limit(1)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing?.id) {
    const { error } = await supabase.from("patient_followups").insert({
      patient_id: input.patientId,
      body: FOLLOW_UP,
      due_at: input.nowIso,
      created_by_email: "system:setup-shipment",
    });
    if (error) throw error;
  }
  const { error: stampErr } = await supabase
    .from("patient_setups")
    .update({
      followup_created_at: input.nowIso,
      updated_at: input.nowIso,
    })
    .eq("id", input.setupId)
    .is("followup_created_at", null);
  if (stampErr) throw stampErr;
  return true;
}

async function ensureOnboarding(
  supabase: ReturnType<typeof getOrgScopedClient>,
  input: {
    patientId: string;
    setupId: string;
    shippedAt: Date;
    alreadyStamped: boolean;
    nowIso: string;
  },
): Promise<boolean> {
  if (input.alreadyStamped) return true;
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
      return false;
    }
  }
  const { error: stampErr } = await supabase
    .from("patient_setups")
    .update({
      onboarding_enrolled_at: input.nowIso,
      updated_at: input.nowIso,
    })
    .eq("id", input.setupId)
    .is("onboarding_enrolled_at", null);
  if (stampErr) throw stampErr;
  return true;
}
