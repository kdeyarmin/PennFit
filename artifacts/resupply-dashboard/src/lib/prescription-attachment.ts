// Hand-rolled dashboard wrappers for the prescription-attachment
// endpoints (W4 T-C4).
//
// Why these aren't generated from OpenAPI:
//   The flow has three JSON exchanges plus one direct PUT to a
//   GCS-issued presigned URL. The PUT is intentionally outside the
//   API contract — it streams binary bytes to a third-party origin
//   with no Replit/admin auth attached. Generating typed hooks for
//   only the three JSON calls would create surface-area drift
//   between endpoints that ship as a single coordinated workflow,
//   so we keep the whole orchestration colocated here.
//
// All paths are relative — the same proxy rules that route
// `/resupply-api/*` to the resupply-api service apply.

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
  const urlRes = await fetch(
    `${API_PREFIX}/patients/${patientId}/prescriptions/${rxId}/attachment/upload-url`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    },
  );
  if (!urlRes.ok) {
    throw new Error(await readErrorMessage(urlRes, "Couldn't start upload."));
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
    throw new Error(
      `Upload to storage failed (${putRes.status} ${putRes.statusText}).`,
    );
  }

  // Step 3: tell the API we're done so it can write the row + ACL.
  const finRes = await fetch(
    `${API_PREFIX}/patients/${patientId}/prescriptions/${rxId}/attachment`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        objectPath,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    },
  );
  if (!finRes.ok) {
    throw new Error(
      await readErrorMessage(finRes, "Couldn't finalize upload."),
    );
  }
}

export async function removePrescriptionAttachment(args: {
  patientId: string;
  rxId: string;
}): Promise<void> {
  const res = await fetch(
    `${API_PREFIX}/patients/${args.patientId}/prescriptions/${args.rxId}/attachment`,
    { method: "DELETE", credentials: "same-origin" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorMessage(res, "Couldn't remove attachment."),
    );
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

async function readErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; issues?: unknown };
    if (body.error === "object_missing") {
      return "Upload didn't complete — please try again.";
    }
    if (body.error === "invalid_body" && Array.isArray(body.issues)) {
      const first = (body.issues as Array<{ message?: string }>)[0];
      if (first?.message) return `${fallback} ${first.message}`;
    }
    if (typeof body.error === "string") {
      return `${fallback} (${body.error})`;
    }
  } catch {
    // fall through
  }
  return `${fallback} (HTTP ${res.status})`;
}
