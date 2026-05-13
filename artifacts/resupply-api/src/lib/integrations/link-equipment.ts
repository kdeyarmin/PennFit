// Auto-link helper: derive an equipment_assets row from an
// IntegrationSnapshot.settings block.
//
// Why this lives here
// -------------------
// The integration refresh handler is the natural place to learn
// about a patient's device (manufacturer + model + serial number).
// Auto-upserting an equipment_assets row from that data closes the
// classic recall-coordination gap: without this link, a Philips
// DreamStation recall would require a CSR to hand-key every patient's
// serial into the asset register before the recall-match query could
// surface affected patients. With it, the recall workflow runs over
// data the partner cloud already gave us for free.
//
// Posture
// -------
//   * The unique index on (manufacturer, serial_number) is the
//     dedupe key — re-running this helper for the same patient
//     does NOT produce duplicate rows. A serial that has migrated
//     between patients (rare but possible) is detected by the
//     existing-row patient_id mismatch and surfaced to the caller
//     as a `transferred` outcome so a CSR can resolve.
//   * device_class is inferred from therapyMode when present;
//     defaults to "cpap" otherwise.
//   * We never delete or overwrite an existing serial's
//     manufacturer/model — those should be immutable per serial.
//     A drift on those fields is a data-quality signal, not a row
//     we should silently change.

import type { DeviceSettings } from "@workspace/resupply-integrations";
import { type getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type Supabase = ReturnType<typeof getSupabaseServiceRoleClient>;
type EquipmentDeviceClass =
  | "cpap"
  | "auto_cpap"
  | "bipap"
  | "asv"
  | "avaps"
  | "humidifier"
  | "oximeter"
  | "other";

export type SnapshotEquipmentLinkOutcome =
  | { kind: "no_settings" }
  | { kind: "no_serial" }
  | { kind: "inserted"; assetId: string }
  | { kind: "matched"; assetId: string }
  | { kind: "transferred"; assetId: string; previousPatientId: string };

const MODE_TO_CLASS: Record<string, EquipmentDeviceClass> = {
  cpap: "cpap",
  fixed_cpap: "cpap",
  autoset: "auto_cpap",
  apap: "auto_cpap",
  "apap-auto": "auto_cpap",
  bipap: "bipap",
  "bilevel-st": "bipap",
  asv: "asv",
  avaps: "avaps",
};

export function inferDeviceClass(
  therapyMode: string | null | undefined,
): EquipmentDeviceClass {
  if (!therapyMode) return "cpap";
  const key = therapyMode.trim().toLowerCase().replace(/\s+/g, "_");
  return MODE_TO_CLASS[key] ?? "cpap";
}

export async function linkEquipmentFromSnapshot(
  supabase: Supabase,
  patientId: string,
  settings: DeviceSettings | null,
): Promise<SnapshotEquipmentLinkOutcome> {
  if (!settings) return { kind: "no_settings" };
  // Vendor responses don't reliably split manufacturer from model —
  // settings.deviceModel carries the model string and the
  // manufacturer is inferred from it (see inferManufacturer below).
  // This keeps the equipment_assets row queryable for recall match
  // without requiring every vendor adapter to parse it out.
  const serial = (settings.deviceSerial ?? "").trim();
  if (serial.length === 0) return { kind: "no_serial" };

  const inferredManufacturer = inferManufacturer(settings.deviceModel ?? "");
  if (!inferredManufacturer) return { kind: "no_settings" };

  // Check for an existing row by the unique-index key.
  const { data: existing, error: lookupErr } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .select("id, patient_id")
    .eq("manufacturer", inferredManufacturer)
    .eq("serial_number", serial)
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;

  if (existing) {
    if (existing.patient_id === patientId) {
      return { kind: "matched", assetId: existing.id };
    }
    // Serial known but linked to a different patient. Don't auto-
    // re-assign; raise the transfer outcome so a CSR can resolve.
    return {
      kind: "transferred",
      assetId: existing.id,
      previousPatientId: existing.patient_id,
    };
  }

  const { data: row, error } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .insert({
      patient_id: patientId,
      device_class: inferDeviceClass(settings.therapyMode),
      manufacturer: inferredManufacturer,
      // Use the vendor's raw deviceModel string verbatim — the CSR can
      // edit if the SKU map needs cleanup. Falling back to the
      // manufacturer name is a defensive default for vendors that
      // send blank model strings.
      model: settings.deviceModel?.trim() || inferredManufacturer,
      serial_number: serial,
      pressure_setting: formatPressure(settings),
      humidifier_setting:
        settings.humidifierLevel == null
          ? null
          : String(settings.humidifierLevel),
      status: "active",
      dispensing_note:
        "auto-linked from therapy-cloud snapshot — verify before relying on for recalls",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { kind: "inserted", assetId: row.id };
}

function formatPressure(settings: DeviceSettings): string | null {
  const min = settings.pressureMinCmh2o;
  const max = settings.pressureMaxCmh2o;
  if (min == null && max == null) return null;
  if (min != null && max != null) {
    return min === max ? `${min} cmH2O` : `${min}–${max} cmH2O`;
  }
  return min != null ? `${min} cmH2O` : `${max ?? ""} cmH2O`;
}

// Best-effort manufacturer inference. Returns null when we can't
// classify the device string — caller treats that the same as
// "no settings", i.e. skips the auto-link rather than guessing.
function inferManufacturer(deviceModel: string): string | null {
  const m = deviceModel.trim().toLowerCase();
  if (!m) return null;
  if (m.includes("airsense") || m.includes("aircurve") || m.includes("airmini")) {
    return "ResMed";
  }
  if (m.includes("dreamstation") || m.includes("dreamwear")) {
    return "Philips";
  }
  if (m.includes("luna") || m.includes("aura")) {
    // 3B Medical's product line, marketed as React Health in the US.
    return "3B Medical";
  }
  return null;
}
