// Hand-rolled CSV download helper for the audit log.
//
// We can't use the OpenAPI codegen client here because the export
// endpoint streams `text/csv` rather than JSON. Auth flows over
// the `pf_session` cookie, sent automatically by the browser on
// same-origin requests.

import { ApiError } from "@workspace/api-client-react/admin";

export interface AuditExportFilters {
  action?: string;
  targetTable?: string;
  since?: string;
}

function buildQuery(filters: AuditExportFilters): string {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.targetTable) params.set("targetTable", filters.targetTable);
  if (filters.since) params.set("since", filters.since);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Download the audit log as CSV with the supplied filters applied.
 *
 * Triggers a browser save dialog via a synthetic <a download>
 * click. Returns the filename suggested by the server (parsed from
 * Content-Disposition) so the caller can surface it in toast/UI.
 */
export async function downloadAuditExport(
  filters: AuditExportFilters,
): Promise<{ filename: string; rowCountApprox: number }> {
  const url = `/resupply-api/audit/export.csv${buildQuery(filters)}`;
  const res = await fetch(url, {
    headers: { Accept: "text/csv" },
  });
  if (!res.ok) {
    let detail: string;
    try {
      detail = await res.text();
    } catch {
      detail = "";
    }
    throw new ApiError(res, detail || null, { method: "GET", url });
  }

  const blob = await res.blob();

  // Parse server-suggested filename, fall back to a sane default.
  const cd = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/i.exec(cd);
  const filename = match?.[1] ?? `audit-export-${Date.now()}.csv`;

  // Approximate row count = number of \n in the blob minus 1
  // (header). Used purely for an end-of-export confirmation
  // toast; the real number lives in the file.
  let rowCountApprox: number;
  try {
    const text = await blob.text();
    rowCountApprox = Math.max(0, text.split("\n").length - 1);
  } catch {
    rowCountApprox = 0;
  }

  // Trigger the download via a synthetic anchor click. We re-create
  // the blob from the text we already read so the URL is fresh.
  const downloadBlob = new Blob([await blob.text()], {
    type: "text/csv;charset=utf-8",
  });
  const objectUrl = URL.createObjectURL(downloadBlob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

  return { filename, rowCountApprox };
}
