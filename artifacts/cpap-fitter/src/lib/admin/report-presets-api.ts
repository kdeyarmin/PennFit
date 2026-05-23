// Hand-rolled fetch wrappers for /admin/reports/presets — backs the
// "Saved presets" section on the Reports page.

export interface ReportPreset {
  id: string;
  name: string;
  slug: string;
  format: "csv" | "pdf" | "iif" | "qbo.csv";
  rangeKind: "absolute" | "preset";
  /** Set when rangeKind === "preset". References the `testId`
   *  field of an entry in admin-reports-presets.ts (e.g.
   *  "preset-last-month"). */
  rangePreset: string | null;
  /** Set when rangeKind === "absolute". ISO date (YYYY-MM-DD). */
  rangeFrom: string | null;
  rangeTo: string | null;
  /** Optional pre-fill for the Email-this-report modal. */
  recipient: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ReportPresetCreate =
  | {
      name: string;
      slug: string;
      format: "csv" | "pdf" | "iif" | "qbo.csv";
      rangeKind: "preset";
      rangePreset: string;
      recipient?: string | null;
    }
  | {
      name: string;
      slug: string;
      format: "csv" | "pdf" | "iif" | "qbo.csv";
      rangeKind: "absolute";
      rangeFrom: string;
      rangeTo: string;
      recipient?: string | null;
    };

async function jsonFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/resupply-api${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  // 204 No Content has an empty body — skip the JSON parse rather
  // than letting it throw.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const listReportPresets = () =>
  jsonFetch<{ presets: ReportPreset[] }>("/admin/reports/presets");

export const createReportPreset = (body: ReportPresetCreate) =>
  jsonFetch<{ preset: ReportPreset }>("/admin/reports/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const deleteReportPreset = (id: string) =>
  jsonFetch<void>(`/admin/reports/presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
