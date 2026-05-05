// Hand-rolled fetch wrappers for the per-patient smart-trigger
// endpoints (Phase G.19).
//
// Used by the patient-detail "Smart triggers" tab to list trigger
// events and dismiss false positives without leaving the patient
// page.

export type SmartTriggerKind =
  | "leak_rising"
  | "usage_dropping"
  | "cushion_wear"
  | "humidifier_drop";

export interface SmartTriggerEventRow {
  id: string;
  kind: SmartTriggerKind;
  detectedAt: string;
  windowStartDate: string;
  windowEndDate: string;
  sentAt: string | null;
  dismissedAt: string | null;
  dismissedByEmail: string | null;
  dismissedReason: string | null;
  createdAt: string;
}

export async function listPatientSmartTriggers(
  patientId: string,
): Promise<{ events: SmartTriggerEventRow[] }> {
  const res = await fetch(
    `/resupply-api/admin/patients/${encodeURIComponent(patientId)}/smart-triggers`,
    { headers: { Accept: "application/json" }, credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load smart triggers (${res.status})`);
  }
  return (await res.json()) as { events: SmartTriggerEventRow[] };
}

export async function dismissSmartTrigger(
  id: string,
  reason?: string | null,
): Promise<void> {
  const res = await fetch(
    `/resupply-api/admin/smart-triggers/${encodeURIComponent(id)}/dismiss`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to dismiss trigger (${res.status}): ${text}`);
  }
}
