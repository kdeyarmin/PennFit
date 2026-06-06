// Automatic patient-packet send when a shop order is marked delivered.
//
// Gated by the admin-flippable feature flag
// `patient_packets.autosend_on_delivery` (default OFF — seeded false in
// migration 0222). When enabled, the first time an order is delivered
// to a customer who is linked to a patient record, we create and email
// the standard new-patient document packet so the patient can sign
// electronically (proof of delivery, assignment of benefits, privacy
// practices, etc.).
//
// Resolution chain: shop_orders.customer_id → shop_customers.auth_user_id
// → patients.portal_auth_user_id. A delivery for an unlinked storefront
// customer (no patient record) is a silent no-op.
//
// One-time by design: if the patient already has any non-voided packet
// we skip, so re-deliveries / multi-order patients are not re-emailed.
// Entirely best-effort — the caller invokes this fire-and-forget and a
// failure here never affects the delivery transition.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logAudit } from "@workspace/resupply-audit";

import { isFeatureEnabled } from "../feature-flags";
import { logger } from "../logger";
import { createAndSendPatientPacket } from "./send";

export async function autoSendPatientPacketOnDelivery(opts: {
  orderId: string;
}): Promise<void> {
  const { orderId } = opts;
  if (!(await isFeatureEnabled("patient_packets.autosend_on_delivery"))) {
    return;
  }

  const supabase = getSupabaseServiceRoleClient();

  const { data: order, error: orderErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("id, customer_id")
    .eq("id", orderId)
    .limit(1)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order?.customer_id) return;

  const { data: customer, error: custErr } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("auth_user_id")
    .eq("customer_id", order.customer_id)
    .limit(1)
    .maybeSingle();
  if (custErr) throw custErr;
  if (!customer?.auth_user_id) return;

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, email")
    .eq("portal_auth_user_id", customer.auth_user_id)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) return;

  // One-time: skip if the patient already has any non-voided packet.
  const { data: existing, error: existingErr } = await supabase
    .schema("resupply")
    .from("patient_packets")
    .select("id")
    .eq("patient_id", patient.id)
    .neq("status", "voided")
    .limit(1)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing) return;

  const result = await createAndSendPatientPacket({
    supabase,
    patientId: patient.id,
    createdByEmail: "system:order-delivered",
  });
  if (!result.ok) {
    logger.warn(
      {
        event: "patient_packet_autosend_failed",
        order_id: orderId,
        code: result.code,
      },
      "auto-send patient packet on delivery failed",
    );
    return;
  }

  await logAudit({
    action: "patient_packet.autosent",
    targetTable: "patient_packets",
    targetId: result.packetId,
    metadata: {
      patient_id: patient.id,
      order_id: orderId,
      email_sent: result.emailSent,
      trigger: "order_delivered",
    },
  }).catch((err) => {
    logger.warn({ err }, "patient_packet.autosent audit write failed");
  });

  logger.info(
    {
      event: "patient_packet_autosent",
      order_id: orderId,
      packet_id: result.packetId,
      email_sent: result.emailSent,
    },
    "auto-sent patient packet on delivery",
  );
}
