// PodSection — proof-of-delivery photo upload + view for a single
// shop_orders row. Lives inside pennpaps-order-detail.tsx alongside
// the existing Insurance / Prescription / Measurements / Shipping
// sections.
//
// Flow follows the canonical 3-step upload pattern used elsewhere
// in the dashboard:
//
//   1. POST  …/pod/upload-url    → { uploadURL, objectPath }
//   2. PUT   <uploadURL>          (browser → GCS, image/* bytes)
//   3. POST  …/pod                { objectPath, contentType, sizeBytes,
//                                  signedName? }  — finalize + persist
//
// View / remove use GET and DELETE on the same path. The GET
// returns the image bytes inline; we render via `URL.createObjectURL`
// so the auth cookie travels with the request (a plain `<img src>`
// to the auth-gated endpoint would also work but skipping the
// object-URL would require an extra round-trip for headers).
//
// The order id type is `string` (text in DB, UUID in practice).

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";

import { csrfHeader } from "@/lib/csrf";

const BASE = "/resupply-api";

interface PodMetaResponse {
  uploadedAt: string | null;
  signedName: string | null;
}

async function fetchPodMeta(orderId: string): Promise<PodMetaResponse> {
  const res = await fetch(`${BASE}/admin/shop/orders/${orderId}/pod/meta`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) {
    // Order doesn't exist — surface as null POD so the section
    // still renders the upload affordance without crashing the
    // parent page. Real lookup errors fall through.
    return { uploadedAt: null, signedName: null };
  }
  if (!res.ok) throw new Error(`POD meta lookup failed (${res.status})`);
  return (await res.json()) as PodMetaResponse;
}

const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/heic",
  "image/heif",
  "image/webp",
] as const;
const ALLOWED_TYPES_SET = new Set<string>(ALLOWED_TYPES);
const MAX_BYTES = 8 * 1024 * 1024;

async function getPodImageObjectUrl(orderId: string): Promise<string> {
  const res = await fetch(`${BASE}/admin/shop/orders/${orderId}/pod`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`POD download failed (${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

async function uploadPodFile(
  orderId: string,
  file: File,
  signedName: string | null,
): Promise<void> {
  // Step 1: get presigned PUT URL.
  const presignedRes = await fetch(
    `${BASE}/admin/shop/orders/${orderId}/pod/upload-url`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...csrfHeader() },
      body: JSON.stringify({
        contentType: file.type,
        sizeBytes: file.size,
      }),
    },
  );
  if (!presignedRes.ok) {
    throw new Error(`upload-url failed (${presignedRes.status})`);
  }
  const { uploadURL, objectPath } = (await presignedRes.json()) as {
    uploadURL: string;
    objectPath: string;
  };

  // Step 2: PUT bytes directly to GCS. NOTE: no auth header — the
  // signed URL itself is the capability.
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`bucket PUT failed (${putRes.status})`);
  }

  // Step 3: finalize on the API — server re-verifies bucket truth
  // and persists pod_object_key + pod_uploaded_at + (optional)
  // pod_signed_name.
  const finalRes = await fetch(`${BASE}/admin/shop/orders/${orderId}/pod`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      objectPath,
      contentType: file.type,
      sizeBytes: file.size,
      signedName: signedName?.trim() || null,
    }),
  });
  if (!finalRes.ok) {
    let detail = "";
    try {
      const json = (await finalRes.json()) as { error?: string };
      detail = json.error ?? "";
    } catch {
      // ignore
    }
    throw new Error(
      detail
        ? `finalize failed (${finalRes.status}): ${detail}`
        : `finalize failed (${finalRes.status})`,
    );
  }
}

async function deletePod(orderId: string): Promise<void> {
  const res = await fetch(`${BASE}/admin/shop/orders/${orderId}/pod`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { ...csrfHeader() },
  });
  if (!res.ok) throw new Error(`POD delete failed (${res.status})`);
}

export interface PodSectionProps {
  orderId: string;
  /** Optional invalidation hook so the parent's order-summary query
   *  refetches POD timestamps after upload/remove succeeds. */
  parentQueryKey?: readonly unknown[];
}

export function PodSection({ orderId, parentQueryKey }: PodSectionProps) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [signedName, setSignedName] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const metaQuery = useQuery({
    queryKey: ["pod-meta", orderId],
    queryFn: () => fetchPodMeta(orderId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const meta = metaQuery.data ?? { uploadedAt: null, signedName: null };
  const hasPhoto = !!meta.uploadedAt;

  // Fetch the image bytes only when the user clicks "Show" — keeps
  // the order detail panel light until they actually want to look.
  const [viewing, setViewing] = useState(false);
  useEffect(() => {
    if (!viewing || !hasPhoto) return;
    let revoked = false;
    let url: string | null = null;
    void getPodImageObjectUrl(orderId).then((u) => {
      if (revoked) {
        URL.revokeObjectURL(u);
        return;
      }
      url = u;
      setPreviewUrl(u);
    });
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
      setPreviewUrl(null);
    };
  }, [viewing, hasPhoto, orderId, meta.uploadedAt]);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      setUploadError(null);
      if (!ALLOWED_TYPES_SET.has(file.type)) {
        throw new Error(
          `Unsupported file type "${file.type}". Allowed: PNG, JPEG, HEIC, WebP.`,
        );
      }
      if (file.size > MAX_BYTES) {
        throw new Error(
          `${(file.size / 1024 / 1024).toFixed(1)} MB exceeds the 8 MB POD limit.`,
        );
      }
      await uploadPodFile(orderId, file, signedName);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pod-meta", orderId] });
      if (parentQueryKey) {
        void qc.invalidateQueries({ queryKey: [...parentQueryKey] });
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      // Drop any cached preview so the next "Show" fetches the
      // newly-uploaded bytes.
      setViewing(false);
      setPreviewUrl(null);
    },
    onError: (err) => {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    },
  });

  const remove = useMutation({
    mutationFn: () => deletePod(orderId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pod-meta", orderId] });
      if (parentQueryKey) {
        void qc.invalidateQueries({ queryKey: [...parentQueryKey] });
      }
      setViewing(false);
      setPreviewUrl(null);
      setSignedName("");
    },
    onError: (err) => {
      setUploadError(err instanceof Error ? err.message : "Delete failed.");
    },
  });

  return (
    <section
      className="rounded-lg border bg-card p-5 space-y-3"
      data-testid="pod-section"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold inline-flex items-center gap-2">
            <Camera className="h-4 w-4" />
            Proof of delivery
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Doorstep photo + optional signature name. Surveyors ask for POD
            evidence on audit and we use it to resolve "I never got it"
            disputes.
          </p>
        </div>
        {hasPhoto && (
          <span className="text-[11px] text-muted-foreground">
            Uploaded{" "}
            {meta.uploadedAt ? new Date(meta.uploadedAt).toLocaleString() : "—"}
            {meta.signedName ? ` · ${meta.signedName}` : ""}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs font-semibold block mb-1 text-muted-foreground">
            Signed name (optional)
          </span>
          <input
            type="text"
            value={signedName}
            onChange={(e) => setSignedName(e.target.value)}
            placeholder="J. Smith"
            maxLength={160}
            disabled={upload.isPending}
            className="rounded border px-2 py-1.5 text-sm min-w-[180px]"
            data-testid="pod-signed-name"
          />
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_TYPES.join(",")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
          }}
          disabled={upload.isPending || remove.isPending}
          className="text-sm"
          data-testid="pod-file-input"
        />
        {upload.isPending && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Uploading…
          </span>
        )}
      </div>

      {uploadError && (
        <p className="text-xs text-red-600" data-testid="pod-upload-error">
          {uploadError}
        </p>
      )}

      {hasPhoto && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => setViewing((v) => !v)}
            className="text-xs underline inline-flex items-center gap-1"
            data-testid="pod-toggle-view"
          >
            <RefreshCw className="h-3 w-3" />
            {viewing ? "Hide photo" : "Show photo"}
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="text-xs text-red-600 underline inline-flex items-center gap-1 disabled:opacity-50"
            data-testid="pod-remove"
          >
            <Trash2 className="h-3 w-3" />
            {remove.isPending ? "Removing…" : "Remove POD"}
          </button>
        </div>
      )}

      {viewing && previewUrl && (
        <img
          src={previewUrl}
          alt="Proof of delivery"
          className="mt-2 max-w-md max-h-96 rounded border"
          data-testid="pod-preview-img"
        />
      )}

      {!hasPhoto && !upload.isPending && (
        <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
          <Upload className="h-3.5 w-3.5" />
          No POD on file yet — pick an image above to upload.
        </p>
      )}
    </section>
  );
}
