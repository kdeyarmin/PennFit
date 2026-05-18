// Hand-rolled fetch wrapper for the /admin/rt-overview surface.
// Mirrors the analytics-api shape: a JSON list + a CSV download URL.

export interface RtOverviewAlert {
  /** patient_smart_trigger_events.id, used by dismissSmartTrigger. */
  id: string;
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

/**
 * Dismiss one smart-trigger event from the RT board.
 *
 * Posts to POST /admin/smart-triggers/:id/dismiss with the optional
 * reason. Resolves on 200/204 (success) and 409 (already_dismissed —
 * idempotent; the row is in the desired state, the board just hasn't
 * refetched yet, so the caller treats it the same as a fresh
 * dismiss). All other non-2xx responses throw the parsed error code
 * so the page can surface it.
 */
export async function dismissSmartTrigger(
  id: string,
  reason: string | null,
): Promise<void> {
  const csrfToken =
    typeof document !== "undefined"
      ? document.cookie
          .split("; ")
          .find((c) => c.startsWith("pf_csrf="))
          ?.split("=")[1] ?? null
      : null;
  const res = await fetch(
    `/resupply-api/admin/smart-triggers/${encodeURIComponent(id)}/dismiss`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(csrfToken ? { "X-PF-CSRF": csrfToken } : {}),
      },
      body: JSON.stringify({ reason: reason ?? null }),
    },
  );
  if (res.status === 409) return;
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.message ?? body.error ?? msg;
    } catch {
      // keep status
    }
    throw new Error(msg);
  }
}
