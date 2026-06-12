// /account → "My documents" section.
//
// Patient-facing surface for uploading insurance cards,
// prescriptions, referrals, and other documents to Penn Home
// Medical Supply. Lists what's already uploaded, lets the
// patient pick a document type before uploading, and shows the
// review status (pending / reviewed) per document so the
// patient knows we've actually seen it.

import { useEffect, useRef, useState } from "react";

import { useConfirmDialog } from "@/hooks/use-confirm-dialog";

import { CheckCircle2, FileText, Loader2, Trash2, Upload } from "lucide-react";

import {
  DOCUMENT_TYPE_LABELS,
  deleteMyDocument,
  fetchMyDocuments,
  uploadMyDocument,
  type PatientDocumentItem,
  type PatientDocumentType,
} from "@/lib/account-api";

const DOCUMENT_ACCEPT =
  "application/pdf,image/png,image/jpeg,image/heic,image/heif,image/webp";
const MAX_DOC_BYTES = 10 * 1024 * 1024;

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsSection() {
  const [docs, setDocs] = useState<PatientDocumentItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [selectedType, setSelectedType] =
    useState<PatientDocumentType>("insurance_card");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const r = await fetchMyDocuments();
      setDocs(r.documents);
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load your documents.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_DOC_BYTES) {
      setUploadError("File is too large. Maximum size is 10 MB.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      await uploadMyDocument(selectedType, file);
      await load();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(doc: PatientDocumentItem) {
    const ok = await confirm({
      title: `Delete "${doc.filename ?? "this document"}"?`,
      description: "This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(doc.id);
    setDeleteError(null);
    try {
      await deleteMyDocument(doc.id);
      await load();
    } catch {
      setDeleteError("Couldn't delete the document — please try again.");
      await load(); // reconcile in case it actually went through
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-documents-section"
    >
      <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold">My documents</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Upload insurance cards, prescriptions, referrals, or other documents for
        Penn Home Medical Supply. Our team will be able to view these directly.
      </p>

      {/* Upload controls */}
      <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-end">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground mb-1 block">
            Document type
          </span>
          <select
            value={selectedType}
            onChange={(e) =>
              setSelectedType(e.target.value as PatientDocumentType)
            }
            disabled={uploading}
            className="rounded-md border border-border/60 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-navy)/0.3)]"
            data-testid="account-doc-type-select"
          >
            {(Object.keys(DOCUMENT_TYPE_LABELS) as PatientDocumentType[]).map(
              (t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ),
            )}
          </select>
        </label>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept={DOCUMENT_ACCEPT}
            className="hidden"
            disabled={uploading}
            onChange={handleFileChange}
            data-testid="account-doc-file-input"
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-full bg-[hsl(var(--penn-navy))] text-white text-sm font-semibold px-4 py-2 hover:bg-[hsl(var(--penn-navy))]/90 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="account-doc-upload-btn"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" /> Upload document
              </>
            )}
          </button>
          <p className="text-xs text-muted-foreground mt-1">
            PDF or image · max 10 MB
          </p>
        </div>
      </div>

      {uploadError && (
        <p
          className="text-sm text-destructive"
          data-testid="account-doc-upload-error"
          role="alert"
        >
          {uploadError}
        </p>
      )}

      {deleteError && (
        <p className="text-sm text-destructive" role="alert">
          {deleteError}
        </p>
      )}

      {/* Document list */}
      {loadError && (
        <p className="text-sm text-muted-foreground">
          {loadError}{" "}
          <button
            type="button"
            onClick={() => void load()}
            className="underline font-medium"
          >
            Try again
          </button>
        </p>
      )}
      {docs === null && !loadError && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {docs !== null && docs.length === 0 && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="account-doc-empty"
        >
          No documents uploaded yet.
        </p>
      )}
      {docs !== null && docs.length > 0 && (
        <ul
          className="divide-y divide-border/40"
          data-testid="account-doc-list"
        >
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="py-3 flex items-center justify-between gap-3"
              data-testid={`account-doc-${doc.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <p className="text-sm font-medium truncate">
                    {doc.filename ?? "Document"}
                  </p>
                  {doc.reviewedAt ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 shrink-0"
                      style={{ background: "#d1fae5", color: "#065f46" }}
                      title={`Reviewed ${new Date(doc.reviewedAt).toLocaleDateString()}`}
                      data-testid={`account-doc-reviewed-${doc.id}`}
                    >
                      <CheckCircle2 className="h-3 w-3" /> Reviewed
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 shrink-0"
                      style={{ background: "#fef3c7", color: "#92400e" }}
                      data-testid={`account-doc-pending-${doc.id}`}
                    >
                      Pending review
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {[
                    DOCUMENT_TYPE_LABELS[
                      doc.documentType as PatientDocumentType
                    ] ?? doc.documentType,
                    formatBytes(doc.sizeBytes),
                    new Date(doc.createdAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                disabled={deletingId === doc.id}
                onClick={() => void handleDelete(doc)}
                className="text-muted-foreground hover:text-destructive disabled:opacity-40 shrink-0"
                aria-label="Delete document"
                data-testid={`account-doc-delete-${doc.id}`}
              >
                {deletingId === doc.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {ConfirmDialogEl}
    </section>
  );
}
