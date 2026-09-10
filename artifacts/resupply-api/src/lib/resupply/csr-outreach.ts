import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  loadCsrScheduleContext,
  loadLastSupplyDates,
  resolveCsrSchedule,
  supplyDateKey,
} from "./csr-schedule";

/** Rechecked before enqueue AND by the worker just before dispatch. */
export async function checkCsrOutreach(
  orgId: string,
  episodeId: string,
  channel: "sms" | "email" | "voice",
  now = new Date(),
) {
  const db = getOrgScopedClient(orgId);
  const ep = await db
    .from("episodes")
    .select("id, patient_id, prescription_id, status, due_at, expires_at")
    .eq("id", episodeId)
    .maybeSingle();
  if (ep.error) throw ep.error;
  if (!ep.data) return { reason: "Episode not found." };
  const e = ep.data;
  if (!["outreach_pending", "awaiting_response"].includes(e.status))
    return { reason: "This resupply cycle is no longer awaiting outreach." };
  if (e.expires_at && Date.parse(e.expires_at) <= now.getTime())
    return { reason: "This resupply cycle has expired." };
  const [patient, rx, recent] = await Promise.all([
    db
      .from("patients")
      .select(
        "id, status, phone_e164, email, timezone, created_at, insurance_payer, cadence_override_days, channel_preference",
      )
      .eq("id", e.patient_id)
      .maybeSingle(),
    db
      .from("prescriptions")
      .select(
        "id, patient_id, status, valid_from, valid_until, item_sku, cadence_days, created_at",
      )
      .eq("id", e.prescription_id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("id")
      .eq("patient_id", e.patient_id)
      .gte(
        "last_message_at",
        new Date(now.getTime() - 48 * 3600000).toISOString(),
      )
      .limit(1),
  ]);
  for (const result of [patient, rx, recent])
    if (result.error) throw result.error;
  if (!patient.data || patient.data.status !== "active")
    return { reason: "Patient is not active." };
  if (
    !rx.data ||
    rx.data.patient_id !== e.patient_id ||
    rx.data.status !== "active" ||
    (rx.data.valid_from &&
      rx.data.valid_from.slice(0, 10) > now.toISOString().slice(0, 10)) ||
    (rx.data.valid_until &&
      rx.data.valid_until.slice(0, 10) < now.toISOString().slice(0, 10))
  )
    return { reason: "Prescription needs review or renewal." };
  const scheduleContext = await loadCsrScheduleContext(db, orgId);
  const lastDates = scheduleContext.dueAtAuthoritative
    ? new Map<string, string>()
    : await loadLastSupplyDates(db, [e.patient_id]);
  const schedule = resolveCsrSchedule(
    scheduleContext,
    patient.data,
    rx.data,
    e.due_at,
    lastDates.get(supplyDateKey(e.patient_id, rx.data.item_sku)),
    now,
  );
  if (!schedule.dueAt || Date.parse(schedule.dueAt) > now.getTime())
    return { reason: "Supplies are not scheduled as due yet." };
  if (channel === "email" ? !patient.data.email : !patient.data.phone_e164)
    return {
      reason:
        channel === "email"
          ? "No email address on file."
          : "No phone number on file.",
    };
  if (recent.data?.length)
    return {
      reason:
        "Patient was contacted within the last 48 hours. Review their conversation first.",
    };
  return {
    reason: null,
    patientId: e.patient_id as string,
    timezone: (patient.data.timezone as string | null) ?? "America/New_York",
  };
}
