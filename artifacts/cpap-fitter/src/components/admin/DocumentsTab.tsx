// Patient-detail "Documents" tab — patient-uploaded document review.
//
// CSR-facing surface: list documents the patient uploaded through the
// portal (insurance cards, sleep studies, prescriptions, etc.), mark
// them reviewed (with optional note), and delete on operator confirm.
//
// The "Mark all reviewed" bulk action is best-effort: it iterates and
// swallows per-doc failures so a single permission error doesn't strand
// the queue. The optimistic UI update reflects the assumed-success state
// regardless; CSRs can re-open the tab if a hard failure is suspected.

import { useCallback, useEffect, useState } from "react";

import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  DOCUMENT_TYPE_LABELS,
  deletePatientDocument,
  listPatientDocuments,
  markPatientDocumentReviewed,
  patientDocumentDownloadUrl,
  type AdminPatientDocument,
} from "@/lib/admin/patient-documents-api";

/**
 * Format a byte count into a human-readable string.
 *
 * @param bytes - The number of bytes to format
 * @returns A string using bytes, kilobytes, or megabytes:
 *  - `< 1024` → `X B`
 *  - `< 1,048,576` → `X KB` (rounded)
 *  - otherwise → `Y.Y MB` (one decimal)
 */
function formatDocBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Renders a UI for listing and managing a patient's uploaded documents.
 *
 * The tab shows document metadata, download links, and badges for unreviewed items.
 * It supports marking individual documents reviewed (optionally with a review note),
 * a best-effort bulk "mark all reviewed" action, and deleting documents via a confirm dialog.
 * Loading and error states are displayed for initial load and delete failures.
 *
 * @param patientId - The ID of the patient whose documents are displayed and managed
 * @returns The component's UI for listing and managing a patient's uploaded documents
 */
export function DocumentsTab({ patientId }: { patientId: string }) {
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [docs, setDocs] = useState<AdminPatientDocument[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // noteOpenId: which doc has the note field expanded (for explicit mark-reviewed)
  const [noteOpenId, setNoteOpenId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  // markingAllReviewed: bulk action in flight
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const rows = await listPatientDocuments(patientId);
      setDocs(rows);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load documents.");
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  function openNoteField(docId: string) {
    setNoteOpenId(docId);
    setNoteText("");
  }

  function closeNoteField() {
    setNoteOpenId(null);
    setNoteText("");
  }

  async function handleMarkReviewed(doc: AdminPatientDocument, note?: string) {
    if (doc.reviewedAt) return;
    setReviewingId(doc.id);
    try {
      await markPatientDocumentReviewed(patientId, doc.id, note || undefined);
      const now = new Date().toISOString();
      setDocs((prev) =>
        prev
          ? prev.map((d) =>
              d.id === doc.id
                ? { ...d, reviewedAt: now, reviewNote: note ?? null }
                : d,
            )
          : prev,
      );
      closeNoteField();
    } catch {
      // Non-fatal: badge stays, CSR can try again.
    } finally {
      setReviewingId(null);
    }
  }

  async function handleMarkAllReviewed() {
    if (!docs) return;
    const unreviewed = docs.filter((d) => !d.reviewedAt);
    if (unreviewed.length === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    for (const doc of unreviewed) {
      try {
        await markPatientDocumentReviewed(patientId, doc.id);
      } catch {
        // best-effort — carry on
      }
    }
    setDocs((prev) =>
      prev
        ? prev.map((d) => (!d.reviewedAt ? { ...d, reviewedAt: now } : d))
        : prev,
    );
    setMarkingAll(false);
  }

  async function handleDelete(doc: AdminPatientDocument) {
    if (
      !(await confirm({
        title: "Delete document?",
        description: `Delete "${doc.filename ?? "this document"}"? This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    setDeletingId(doc.id);
    setDeleteError(null);
    try {
      await deletePatientDocument(patientId, doc.id);
      await load();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Couldn't delete document.",
      );
    } finally {
      setDeletingId(null);
    }
  }

  if (loadError) {
    return (
      <ErrorPanel
        error={new Error(loadError)}
        onRetry={() => void load()}
        title="Couldn't load documents"
      />
    );
  }

  if (docs === null) {
    return <Spinner label="Loading documents…" />;
  }

  const unreviewedCount = docs.filter((d) => !d.reviewedAt).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">Patient-uploaded documents</h3>
          {unreviewedCount > 0 && (
            <span
              className="text-xs font-semibold rounded-full px-2 py-0.5"
              style={{ background: "#fef3c7", color: "#92400e" }}
              title={`${unreviewedCount} unreviewed`}
            >
              {unreviewedCount} new
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {unreviewedCount > 1 && (
            <button
              type="button"
              disabled={markingAll}
              onClick={() => void handleMarkAllReviewed()}
              className="text-xs underline disabled:opacity-40"
              style={{
                color: markingAll ? "#9ca3af" : "#047857",
                background: "none",
                border: "none",
                cursor: markingAll ? "not-allowed" : "pointer",
                font: "inherit",
              }}
            >
              {markingAll ? "Marking all…" : `Mark all ${unreviewedCount} reviewed`}
            </button>
          )}
          <span className="text-xs text-muted-foreground">
            {docs.length} document{docs.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      {deleteError && (
        <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
          {deleteError}
        </p>
      )}
      {docs.length === 0 ? (
        <EmptyState title="No documents uploaded yet." />
      ) : (
        <ul className="divide-y divide-border/40">
          {docs.map((doc) => {
            const isNew = !doc.reviewedAt;
            const isReviewing = reviewingId === doc.id;
            const isDeleting = deletingId === doc.id;
            const noteOpen = noteOpenId === doc.id;
            return (
              <li
                key={doc.id}
                className="py-3 space-y-2"
                style={isNew ? { background: "hsl(47 100% 97%)" } : undefined}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {isNew && (
                        <span
                          className="text-xs font-bold rounded-full px-2 py-0.5 shrink-0"
                          style={{ background: "#fef3c7", color: "#92400e" }}
                        >
                          New
                        </span>
                      )}
                      <span
                        className="text-xs font-semibold rounded-full px-2 py-0.5"
                        style={{
                          background: "hsl(var(--ink-1)/0.08)",
                          color: "hsl(var(--ink-1))",
                        }}
                      >
                        {DOCUMENT_TYPE_LABELS[doc.documentType] ?? doc.documentType}
                      </span>
                      <a
                        href={patientDocumentDownloadUrl(patientId, doc.id)}
                        target="_blank"
                        rel="noopener"
                        download={doc.filename ?? undefined}
                        className="text-sm font-medium underline truncate"
                        style={{ color: "#1d4ed8" }}
                      >
                        {doc.filename ?? "Document"}
                      </a>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDocBytes(doc.sizeBytes)} ·{" "}
                      {new Date(doc.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                      {doc.reviewedAt && (
                        <span>
                          {" "}
                          · Reviewed{" "}
                          {new Date(doc.reviewedAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      )}
                    </p>
                    {doc.reviewNote && (
                      <p
                        className="text-xs mt-1 italic"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        "{doc.reviewNote}"
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {isNew && !noteOpen && (
                      <button
                        type="button"
                        disabled={isReviewing || isDeleting || markingAll}
                        onClick={() => openNoteField(doc.id)}
                        className="text-xs underline disabled:opacity-40"
                        style={{
                          color: "#047857",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          font: "inherit",
                        }}
                      >
                        Mark reviewed
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isDeleting || isReviewing || markingAll}
                      onClick={() => void handleDelete(doc)}
                      className="text-xs underline disabled:opacity-40"
                      style={{
                        color: isDeleting ? "#9ca3af" : "#b91c1c",
                        background: "none",
                        border: "none",
                        cursor: isDeleting ? "not-allowed" : "pointer",
                        font: "inherit",
                      }}
                    >
                      {isDeleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>

                {/* Inline note field — expands when "Mark reviewed" is clicked */}
                {noteOpen && (
                  <div className="pl-2 space-y-1.5">
                    <textarea
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Optional note (e.g. &quot;Insurance card verified — expires 12/2026&quot;)"
                      aria-label="Review note"
                      maxLength={500}
                      rows={2}
                      disabled={isReviewing}
                      className="w-full rounded-md border border-border/60 bg-white px-3 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-navy)/0.3)] disabled:opacity-50"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isReviewing}
                        onClick={() => void handleMarkReviewed(doc, noteText)}
                        className="text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-40"
                        style={{
                          background: isReviewing ? "#d1d5db" : "#047857",
                          color: "#fff",
                          border: "none",
                          cursor: isReviewing ? "not-allowed" : "pointer",
                        }}
                      >
                        {isReviewing ? "Marking…" : "Confirm reviewed"}
                      </button>
                      <button
                        type="button"
                        disabled={isReviewing}
                        onClick={closeNoteField}
                        className="text-xs underline disabled:opacity-40"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "hsl(var(--ink-3))",
                          font: "inherit",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ConfirmDialogEl}
    </div>
  );
}
