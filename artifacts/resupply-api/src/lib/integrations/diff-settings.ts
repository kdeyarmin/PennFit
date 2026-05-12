// Device-settings change detection.
//
// When a vendor pushes an updated settings block (new pressure
// range, mode change from Auto to CPAP, humidifier off, etc.), the
// CSR should know — those changes correlate with patient discomfort,
// non-adherence, and clinical intervention.
//
// This module computes a small "what changed" diff between the
// previous snapshot's settings and the fresh one. The diff has a
// fixed allowlist of fields so a new column in the vendor's response
// doesn't accidentally start firing audit events.

import type { DeviceSettings } from "@workspace/resupply-integrations";

export type SettingsChange = {
  field: keyof DeviceSettings;
  before: DeviceSettings[keyof DeviceSettings];
  after: DeviceSettings[keyof DeviceSettings];
};

const TRACKED_FIELDS: Array<keyof DeviceSettings> = [
  "deviceModel",
  "deviceSerial",
  "therapyMode",
  "pressureMinCmh2o",
  "pressureMaxCmh2o",
  "rampMinutes",
  "humidifierLevel",
  "maskType",
];

export function diffSettings(
  before: DeviceSettings | null,
  after: DeviceSettings | null,
): SettingsChange[] {
  if (!before || !after) return [];
  const changes: SettingsChange[] = [];
  for (const field of TRACKED_FIELDS) {
    const b = before[field];
    const a = after[field];
    if (b !== a) {
      changes.push({ field, before: b, after: a });
    }
  }
  return changes;
}
