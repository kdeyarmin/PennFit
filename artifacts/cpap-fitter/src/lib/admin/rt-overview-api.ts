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

/**
 * Sort keys supported by the RT board's column headers. Each value
 * here maps 1:1 to a column on the patient table. `default` is the
 * server-provided order (alerting-first, then alphabetical) — the
 * UI uses it when no header has been clicked.
 */
export type RtSortKey =
  | "default"
  | "patient"
  | "alerts"
  | "nights"
  | "lastNight"
  | "ahi"
  | "leak"
  | "usage";

export type RtSortDir = "asc" | "desc";

/**
 * Sort a fleet by the chosen column. Pure function — no DOM, no
 * side-effects — so the comparator is unit-testable.
 *
 * Null handling: rows with a null sort key always sink to the
 * bottom regardless of direction. That keeps "patients we have no
 * AHI data for" out of the way when the RT is sorting AHI desc to
 * find the worst-controlled cases, AND out of the way when sorting
 * AHI asc to find the best-controlled ones. Null isn't 0 here; it
 * means "no data," which has different semantics.
 */
export function sortRtRows(
  rows: RtOverviewRow[],
  key: RtSortKey,
  dir: RtSortDir,
): RtOverviewRow[] {
  if (key === "default") return rows;
  const out = [...rows];
  const sign = dir === "asc" ? 1 : -1;
  out.sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === null && bv === null) return 0;
    // Null always sinks regardless of direction.
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * sign;
    }
    return String(av).localeCompare(String(bv)) * sign;
  });
  return out;
}

function sortValue(
  row: RtOverviewRow,
  key: RtSortKey,
): number | string | null {
  switch (key) {
    case "patient":
      return `${row.lastName} ${row.firstName}`.toLowerCase();
    case "alerts":
      return row.activeAlerts.length;
    case "nights":
      return row.nightsInWindow;
    case "lastNight":
      return row.lastNightDate;
    case "ahi":
      return row.ahiAvg;
    case "leak":
      return row.leakAvg;
    case "usage":
      return row.usageMinutesAvg;
    case "default":
      return 0;
  }
}

/**
 * Client-side filter for the RT board. Composes with sortRtRows.
 *
 * Filters are AND-ed together — a row must satisfy every active
 * predicate to remain visible. Each filter has a defined "off"
 * value so callers can pass a single object that captures the full
 * filter state without optionality plumbing.
 *
 * The `search` term is matched case-insensitively against the
 * concatenation of last name + first name + pacware id. Pacware ids
 * are the field RTs most often have on hand from a paper chart, so
 * a partial pacware id ("PW-001") needs to find the row even when
 * the RT didn't type the patient's name.
 *
 * `sources` is a SET of partner integration source values to keep
 * (empty set = no source filter, NOT "show nothing"); a row passes
 * when ANY of its therapy_links matches one of the listed sources.
 */
export interface RtFilter {
  alertingOnly: boolean;
  staleOnly: boolean;
  sources: ReadonlySet<string>;
  search: string;
}

export function createRtFilterDefault(): RtFilter {
  return {
    alertingOnly: false,
    staleOnly: false,
    sources: new Set(),
    search: "",
  };
}

export const RT_FILTER_DEFAULT: RtFilter = createRtFilterDefault();

export function filterRtRows(
  rows: RtOverviewRow[],
  filter: RtFilter,
): RtOverviewRow[] {
  const search = filter.search.trim().toLowerCase();
  const sourceFilter = filter.sources;
  const useSourceFilter = sourceFilter.size > 0;
  return rows.filter((r) => {
    if (filter.alertingOnly && r.activeAlerts.length === 0) return false;
    if (filter.staleOnly && r.nightsInWindow !== 0) return false;
    if (useSourceFilter) {
      const match = r.therapyLinks.some((l) => sourceFilter.has(l.source));
      if (!match) return false;
    }
    if (search.length > 0) {
      const hay =
        `${r.lastName} ${r.firstName} ${r.pacwareId}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

/** Distinct list of therapy-link sources across the fleet, for the
 *  filter-chip render. Stable order: alphabetical. */
export function distinctSources(rows: RtOverviewRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    for (const l of r.therapyLinks) set.add(l.source);
  }
  return [...set].sort();
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
