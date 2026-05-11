// Shared helper to fetch a server-rendered PDF, open it in a new
// tab on success, and surface a structured error message on failure.
//
// Why pre-flight fetch (vs. just window.open)
// -------------------------------------------
// The SWO + compliance-attestation routes return 422 with a JSON
// payload (e.g. "missing provider link") when the inputs are
// incomplete. A plain window.open would render that JSON as a
// download or a JSON-formatted blob in a new tab — not useful for a
// CSR. Pre-flight lets us surface a clear "fix HCPCS code first"
// message inline, only opening the tab when the PDF is real.

export interface PdfDownloadError {
  status: number;
  error: string;
  message?: string;
  issues?: Array<{ field?: string; path?: string; message: string }>;
}

export async function openPdfInNewTab(
  url: string,
): Promise<{ ok: true } | { ok: false; error: PdfDownloadError }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/pdf" },
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        status: 0,
        error: "network_error",
        message: err instanceof Error ? err.message : "Network error",
      },
    };
  }

  if (!res.ok) {
    // Route returns JSON on error per the admin API conventions.
    let payload: PdfDownloadError;
    try {
      const json = (await res.json()) as Partial<PdfDownloadError>;
      payload = {
        status: res.status,
        error: json.error ?? "error",
        message: json.message,
        issues: json.issues,
      };
    } catch {
      payload = {
        status: res.status,
        error: "unknown_error",
        message: `Server returned ${res.status} ${res.statusText}`,
      };
    }
    return { ok: false, error: payload };
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  // Open in a new tab. If a pop-up blocker intervenes, the helper
  // still returns ok=true — the CSR can re-click; we don't try to
  // detect the block here because there is no portable way.
  window.open(objectUrl, "_blank", "noopener,noreferrer");
  // Defer revoke so the new tab has a chance to load.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  return { ok: true };
}

/** Best-effort human summary of an error result from openPdfInNewTab. */
export function summarizePdfError(error: PdfDownloadError): string {
  if (error.message) return error.message;
  if (error.issues && error.issues.length > 0) {
    return error.issues.map((i) => i.message).join("; ");
  }
  return error.error;
}
