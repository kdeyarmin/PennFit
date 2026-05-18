// Hand-rolled fetch wrapper for the /admin/rt-overview surface.
// Mirrors the analytics-api shape: a JSON list + a CSV download URL.

export interface RtOverviewAlert {
  kind: string;
  label: string;
  detectedAt: string;
}

export interface RtOverviewTherapyLink {
  source: string;
  status: string;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
}

export interface RtOverviewRow {
  patientId: string;
  pacwareId: string;
  firstName: string;
  lastName: string;
  nightsInWindow: number;
  lastNightDate: string | null;
  staleDays: number | null;
  ahiAvg: number | null;
  leakAvg: number | null;
  usageMinutesAvg: number | null;
  activeAlerts: RtOverviewAlert[];
  therapyLinks: RtOverviewTherapyLink[];
}

export interface RtOverviewResponse {
  asOf: string;
  windowDays: number;
  summary: {
    totalActive: number;
    totalAlerting: number;
    totalStale: number;
  };
  rows: RtOverviewRow[];
}

export async function fetchRtOverview(
  days: number,
): Promise<RtOverviewResponse> {
  const res = await fetch(`/resupply-api/admin/rt-overview?days=${days}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      msg = body.message ?? body.error ?? msg;
    } catch {
      // keep status
    }
    throw new Error(msg);
  }
  return (await res.json()) as RtOverviewResponse;
}

export function rtOverviewCsvUrl(days: number): string {
  return `/resupply-api/admin/rt-overview.csv?days=${days}`;
}
