// Hand-rolled dashboard wrappers for the prescription-attachment
// endpoints (W4 T-C4).
//
// Why these aren't generated from OpenAPI:
//   The flow has three JSON exchanges plus one direct PUT to a
//   Supabase-Storage-issued presigned URL. The PUT is intentionally
//   outside the API contract — it streams binary bytes to a
//   third-party origin with no admin auth attached. Generating typed
//   hooks for only the three JSON calls would create surface-area
//   drift between endpoints that ship as a single coordinated
//   workflow, so we keep the whole orchestration colocated here.
//
// All paths are relative — the same proxy rules that route
// `/resupply-api/*` to the resupply-api service apply.

import { ApiError } from "@workspace/api-client-react/admin";

const API_PREFIX = "/resupply-api";

export type AttachmentMetadata = {
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
};

/**
 * Wraps the four-step upload flow (request signed URL → PUT bytes
 * to GCS → POST finalize → done) behind a single async call so the
 * UI can render one progress state.
 *
 * Throws Error with a human-readable message on any failure. The
 * caller is responsible for surfacing it to the admin and clearing
 * any optimistic UI state.
 */
export async function uploadPrescriptionAttachment(args: {
  patientId: string;
  rxId: string;
  file: File;
}): Promise<void> {
  const { patientId, rxId, file } = args;

  // Step 1: ask the API for a presigned URL. This also doubles as
  // the size/MIME validation gate — the API rejects unsupported
  // types and oversized files BEFORE we ever try to upload, so the
  // user gets a fast error instead of a silent S3-style 403.
  const urlReqUrl = `${API_PREFIX}/patients/${patientId}/prescriptions/${rxId}/attachment/upload-url`;
  const urlRes = await fetch(urlReqUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    }),
  });
  if (!urlRes.ok) {
    let data: unknown = null;
    try {
      data = await urlRes.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(urlRes, data, { method: "POST", url: urlReqUrl });
  }
  const { uploadURL, objectPath } = (await urlRes.json()) as {
    uploadURL: string;
    objectPath: string;
  };

  // Step 2: PUT the bytes directly to GCS. We send the same
  // content-type the user's browser inferred so download responses
  // can render natively. Any non-2xx here means the bucket rejected
  // the upload (rare; usually means the URL expired).
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: {
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!putRes.ok) {
    let data: unknown = null;
    try {
      data = await putRes.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(putRes, data, { method: "PUT", url: uploadURL });
  }

  // Step 3: tell the API we're done so it can write the row + ACL.
  const finUrl = `${API_PREFIX}/patients/${patientId}/prescriptions/${rxId}/attachment`;
  const finRes = await fetch(finUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      objectPath,
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    }),
  });
  if (!finRes.ok) {
    let data: unknown = null;
    try {
      data = await finRes.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(finRes, data, { method: "POST", url: finUrl });
  }
}

export async function removePrescriptionAttachment(args: {
  patientId: string;
  rxId: string;
}): Promise<void> {
  const url = `${API_PREFIX}/patients/${args.patientId}/prescriptions/${args.rxId}/attachment`;
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method: "DELETE", url });
  }
}

/**
 * Build the absolute URL the browser hits to download an
 * attachment. Returned as a string (rather than a navigation side
 * effect) so callers can pass it into an `<a href>` for native
 * "save as" UX. The endpoint itself is admin-gated and
 * audit-logged; nothing else is needed at the call site.
 */
export function prescriptionAttachmentDownloadUrl(args: {
  patientId: string;
  rxId: string;
}): string {
  return `${API_PREFIX}/patients/${args.patientId}/prescriptions/${args.rxId}/attachment`;
}
