// Composable patient-segment filter spec for bulk campaigns.
//
// `audience_kind='patient_segment'` campaigns carry one of these specs in
// the `bulk_campaigns.audience_filter` jsonb column (migration 0396). The
// criteria are ANDed together: a patient is in the audience only when they
// satisfy EVERY criterion that's set. An unset criterion is ignored.
//
// Every dimension here is backed by data the resolver can actually query
// (see fetch-candidates.ts `fetchPatientSegmentCandidates`):
//
//   * manufacturers / deviceClasses / equipmentModelContains
//       → resupply.equipment_assets (the clinical "which device does this
//         patient have" registry). equipmentModelContains matches the free-
//         text model, so it covers masks/cushions where the model string is
//         recorded (e.g. "DreamWear", "AirFit P10").
//   * therapyFailing
//       → an OPEN low-adherence compliance alert
//         (resupply.csr_compliance_alerts, alert_type='low_usage') — the
//         same "failing therapy" signal the daily compliance scanner writes.
//   * insurancePayer
//       → patients.insurance_payer (exact match, like by_patient_payer).
//   * notContactedInDays
//       → patients with NO outbound/inbound message in the last N days
//         (resupply.patient_latest_message); never-contacted patients are
//         included.
//
// PURE module: no DB, no logging. The resolver/route import the type + zod
// schema; the UI imports the labels + summarize() for display.
//
// Deliberately NOT here: a "past / inactive patient" filter. The only
// non-active patient status in this system is 'paused', which is set when a
// patient texts STOP or unsubscribes — i.e. an explicit opt-out. Mass-
// messaging opted-out patients is a compliance violation, so segments only
// ever target the messageable (active) population; the audience resolver
// suppresses any non-active patient regardless of what a segment selects.

import { z } from "zod";

/** equipment_assets.device_class enum (migration 0078). */
export const SEGMENT_DEVICE_CLASSES = [
  "cpap",
  "auto_cpap",
  "bipap",
  "asv",
  "avaps",
  "humidifier",
  "oximeter",
  "other",
] as const;

export type SegmentDeviceClass = (typeof SEGMENT_DEVICE_CLASSES)[number];

export const DEVICE_CLASS_LABELS: Record<SegmentDeviceClass, string> = {
  cpap: "CPAP",
  auto_cpap: "Auto-CPAP",
  bipap: "BiPAP",
  asv: "ASV",
  avaps: "AVAPS",
  humidifier: "Humidifier",
  oximeter: "Oximeter",
  other: "Other",
};

export const patientSegmentFilterSchema = z
  .object({
    /** Match patients with an ACTIVE equipment asset from any of these
     *  manufacturers (case-insensitive). */
    manufacturers: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    /** Match patients with an ACTIVE equipment asset of any of these
     *  device classes. */
    deviceClasses: z
      .array(z.enum(SEGMENT_DEVICE_CLASSES))
      .max(SEGMENT_DEVICE_CLASSES.length)
      .optional(),
    /** Substring match (case-insensitive) on an active equipment asset's
     *  model — covers mask / cushion / machine model targeting. */
    equipmentModelContains: z.string().trim().min(1).max(120).optional(),
    /** Only patients with an open low-adherence ("failing therapy") alert. */
    therapyFailing: z.boolean().optional(),
    /** Exact insurance-payer match (patients.insurance_payer). */
    insurancePayer: z.string().trim().min(1).max(120).optional(),
    /** Only patients we have NOT contacted in the last N days (or never). */
    notContactedInDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict()
  .refine(
    (f) =>
      (f.manufacturers && f.manufacturers.length > 0) ||
      (f.deviceClasses && f.deviceClasses.length > 0) ||
      Boolean(f.equipmentModelContains) ||
      f.therapyFailing === true ||
      Boolean(f.insurancePayer) ||
      typeof f.notContactedInDays === "number",
    {
      message:
        "A patient segment needs at least one filter (manufacturer, device class, equipment model, failing-therapy, payer, or contact recency).",
    },
  );

export type PatientSegmentFilter = z.infer<typeof patientSegmentFilterSchema>;

/**
 * Does this filter reference equipment_assets at all? Lets the resolver
 * skip the equipment scan when no equipment criterion is set.
 */
export function segmentHasEquipmentCriteria(f: PatientSegmentFilter): boolean {
  return (
    (f.manufacturers?.length ?? 0) > 0 ||
    (f.deviceClasses?.length ?? 0) > 0 ||
    Boolean(f.equipmentModelContains)
  );
}

/**
 * Human-readable one-line summary for the campaign list / detail UI and
 * the audit metadata. PHI-free (no patient identifiers, just the criteria).
 */
export function summarizePatientSegment(f: PatientSegmentFilter): string {
  const parts: string[] = [];
  if (f.manufacturers && f.manufacturers.length > 0) {
    parts.push(`make: ${f.manufacturers.join(", ")}`);
  }
  if (f.deviceClasses && f.deviceClasses.length > 0) {
    parts.push(
      `device: ${f.deviceClasses.map((d) => DEVICE_CLASS_LABELS[d]).join(", ")}`,
    );
  }
  if (f.equipmentModelContains) {
    parts.push(`model contains "${f.equipmentModelContains}"`);
  }
  if (f.therapyFailing) {
    parts.push("failing therapy");
  }
  if (f.insurancePayer) {
    parts.push(`payer: ${f.insurancePayer}`);
  }
  if (typeof f.notContactedInDays === "number") {
    parts.push(`not contacted in ${f.notContactedInDays}d`);
  }
  return parts.length > 0 ? parts.join(" · ") : "all active patients";
}
