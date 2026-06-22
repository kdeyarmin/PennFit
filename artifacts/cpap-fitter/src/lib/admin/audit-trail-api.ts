// Hand-rolled fetch wrapper for /admin/patient-access-log — the admin
// Audit Trail report (who accessed which patient's info, and when).

import { ApiError } from "@workspace/api-client-react/admin";

export interface AuditTrailRow {
  id: string;
  occurredAt: string;
  adminEmail: string;
  adminUserId: string;
  adminRole: string | null;
  action: string;
  method: string | null;
  path: string | null;
  targetTable: string | null;
  targetId: string | null;
  patientId: string | null;
  patientName: string | null;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  impersonatorUserId: string | null;
}

export interface AuditTrailResponse {
  rows: AuditTrailRow[];
  total: number | null;
  limit: number;
  offset: number;
  filters: {
    from: string | null;
    to: string | null;
    adminEmail: string | null;
    adminUserId: string | null;
    patientId: string | null;
    targetTable: string | null;
    action: string | null;
  };
}

export interface AuditTrailFilters {
  /** ISO date or datetime (inclusive lower bound). */
  from?: string;
  /** ISO date or datetime (inclusive upper bound). */
  to?: string;
  /** Employee email (substring match). */
  adminEmail?: string;
  /** Exact patient/customer id. */
  patientId?: string;
  /** Action verb substring, e.g. "view" / "update". */
  action?: string;
  /** Record type, e.g. "patients" / "conversations". */
  targetTable?: string;
  limit?: number;
  offset?: number;
}

const BASE = "/resupply-api/admin/patient-access-log";

function buildParams(
  params: AuditTrailFilters,
  extra?: Record<string, string>,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.adminEmail) sp.set("adminEmail", params.adminEmail);
  if (params.patientId) sp.set("patientId", params.patientId);
  if (params.action) sp.set("action", params.action);
  if (params.targetTable) sp.set("targetTable", params.targetTable);
  if (typeof params.limit === "number") sp.set("limit", String(params.limit));
  if (typeof params.offset === "number")
    sp.set("offset", String(params.offset));
  for (const [k, v] of Object.entries(extra ?? {})) sp.set(k, v);
  return sp;
}

export async function fetchAuditTrail(
  params: AuditTrailFilters,
): Promise<AuditTrailResponse> {
  const qs = buildParams(params).toString();
  const url = qs ? `${BASE}?${qs}` : BASE;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "GET", url });
  }
  return (await res.json()) as AuditTrailResponse;
}

/** URL for the CSV export of the same filtered view (limit/offset are
 *  ignored server-side for CSV — it exports the whole matching set up to
 *  a cap). Used by an `<a href download>` so the browser handles the
 *  Content-Disposition attachment. */
export function auditTrailCsvUrl(params: AuditTrailFilters): string {
  const sp = buildParams(
    { ...params, limit: undefined, offset: undefined },
    { format: "csv" },
  );
  return `${BASE}?${sp.toString()}`;
}
