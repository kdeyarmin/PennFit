// Patient-detail "Smart Notes" tab.
//
// A nurse/clinician writes a clinical note. Before saving, "Review"
// runs the note through the AI Medicare-compliance reviewer: it grades
// the note against the fixed documentation checklist, cross-checks it
// against the patient's chart (sleep study + device adherence), and
// compares it against the patient's previous note for trends. The nurse
// fixes any gaps, then saves — the review snapshot is frozen onto the
// saved note so the next note can be compared against it.
//
// Append-only: review (preview), save, list. No edit/delete.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { Button } from "@/components/admin/Button";
import { formatDateTime } from "@/lib/admin/format";
import {
  listSmartNotes,
  reviewSmartNote,
  saveSmartNote,
  type SmartNote,
  type SmartNoteComparison,
  type SmartNoteProvider,
  type SmartNoteReview,
  type SmartNoteReviewResult,
} from "@/lib/admin/smart-notes-api";

const MAX_NOTE = 6000;

export function SmartNotesTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const [noteText, setNoteText] = useState("");
  const [preview, setPreview] = useState<SmartNoteReviewResult | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const queryKey = ["admin", "patients", patientId, "smart-notes"] as const;
  const { data, isPending, isError } = useQuery({
    queryKey,
    queryFn: () => listSmartNotes(patientId),
  });

  const reviewMutation = useMutation({
    mutationFn: (text: string) => reviewSmartNote(patientId, text),
    onSuccess: (result) => {
      setPreview(result);
      setSubmitError(null);
    },
    onError: (err) =>
      setSubmitError(
        err instanceof Error ? err.message : "Failed to review note.",
      ),
  });

  const saveMutation = useMutation({
    mutationFn: (text: string) => saveSmartNote(patientId, text),
    onSuccess: () => {
      setNoteText("");
      setPreview(null);
      setSubmitError(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) =>
      setSubmitError(
        err instanceof Error ? err.message : "Failed to save note.",
      ),
  });

  const trimmed = noteText.trim();
  const tooLong = trimmed.length > MAX_NOTE;
  const busy = reviewMutation.isPending || saveMutation.isPending;
  const canAct = trimmed.length > 0 && !tooLong && !busy;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <textarea
          value={noteText}
          onChange={(e) => {
            setNoteText(e.target.value);
            // Editing invalidates a stale preview.
            if (preview) setPreview(null);
          }}
          placeholder="Document the clinical encounter (subjective findings, adherence/usage, benefit from therapy, exam/device data, assessment & plan, your name + credentials)…"
          aria-label="Clinical note"
          rows={6}
          maxLength={MAX_NOTE + 200}
          disabled={busy}
          className="w-full rounded border px-3 py-2 text-sm font-sans"
          style={{ borderColor: "hsl(var(--line-1))" }}
          data-testid="smart-notes-body"
        />
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="text-xs"
            style={{ color: tooLong ? "#b91c1c" : "hsl(var(--ink-3))" }}
          >
            {trimmed.length} / {MAX_NOTE}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              size="sm"
              intent="secondary"
              disabled={!canAct}
              isLoading={reviewMutation.isPending}
              onClick={() => reviewMutation.mutate(trimmed)}
              data-testid="smart-notes-review"
            >
              Review compliance
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canAct}
              isLoading={saveMutation.isPending}
              onClick={() => saveMutation.mutate(trimmed)}
              data-testid="smart-notes-save"
            >
              Save note
            </Button>
          </div>
        </div>
        {submitError && (
          <p className="text-xs" style={{ color: "#b91c1c" }} role="alert">
            {submitError}
          </p>
        )}
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Review checks the note against the Medicare PAP documentation
          checklist and the patient&apos;s chart. Saving re-runs the review and
          stores it so the next note can be compared for trends.
        </p>
      </div>

      {preview && (
        <div
          className="rounded border p-3 space-y-3"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "#f9fafb",
          }}
          data-testid="smart-notes-preview"
        >
          <div
            className="text-xs font-semibold"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Compliance preview (not yet saved)
          </div>
          <ReviewPanel
            review={preview.review}
            comparison={preview.comparison}
          />
        </div>
      )}

      <SmartNotesList
        isPending={isPending}
        isError={isError}
        notes={data?.notes ?? []}
      />
    </div>
  );
}

function ProviderBadge({ provider }: { provider: SmartNoteProvider }) {
  if (provider === "offline") {
    return (
      <span
        className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
        style={{ backgroundColor: "#fef3c7", color: "#92400e" }}
        title="AI is offline — heuristic keyword checklist only. Verify manually."
      >
        AI offline
      </span>
    );
  }
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: "#e0e7ff", color: "#3730a3" }}
    >
      {provider === "anthropic" ? "Claude" : "GPT"}
    </span>
  );
}

function ComplianceBadge({
  compliant,
  score,
}: {
  compliant: boolean;
  score: number;
}) {
  const bg = compliant ? "#dcfce7" : score >= 70 ? "#fef9c3" : "#fee2e2";
  const fg = compliant ? "#166534" : score >= 70 ? "#854d0e" : "#991b1b";
  return (
    <span
      className="rounded px-2 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: bg, color: fg }}
    >
      {compliant ? "Medicare compliant" : `${score}% complete`}
    </span>
  );
}

function ReviewPanel({
  review,
  comparison,
}: {
  review: SmartNoteReview;
  comparison: SmartNoteComparison;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ComplianceBadge compliant={review.compliant} score={review.score} />
        <ProviderBadge provider={review.provider} />
      </div>

      {review.summary && (
        <p className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
          {review.summary}
        </p>
      )}

      <ul className="space-y-1">
        {review.elements.map((el) => (
          <li key={el.key} className="flex gap-2 text-sm">
            <span
              aria-hidden
              style={{ color: el.present ? "#16a34a" : "#dc2626" }}
            >
              {el.present ? "✓" : "✗"}
            </span>
            <span className="flex-1">
              <span
                style={{
                  color: "hsl(var(--ink-1))",
                  fontWeight: 600,
                  textDecoration: el.present ? "none" : "none",
                }}
              >
                {el.label}
              </span>
              {el.detail && (
                <span
                  className="block text-xs"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {el.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {review.suggestions.length > 0 && (
        <div>
          <div
            className="text-xs font-semibold mb-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Suggestions to reach compliance
          </div>
          <ul className="list-disc pl-5 space-y-0.5 text-sm">
            {review.suggestions.map((s, i) => (
              <li key={i} style={{ color: "hsl(var(--ink-1))" }}>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {review.chartConsistency.discrepancies.length > 0 && (
        <div
          className="rounded border p-2"
          style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2" }}
        >
          <div
            className="text-xs font-semibold mb-1"
            style={{ color: "#991b1b" }}
          >
            Chart consistency
          </div>
          {review.chartConsistency.summary && (
            <p className="text-xs mb-1" style={{ color: "#7f1d1d" }}>
              {review.chartConsistency.summary}
            </p>
          )}
          <ul className="list-disc pl-5 space-y-0.5 text-sm">
            {review.chartConsistency.discrepancies.map((d, i) => (
              <li key={i} style={{ color: "#7f1d1d" }}>
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(comparison.summary || comparison.changes.length > 0) && (
        <div
          className="rounded border p-2"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "#ffffff",
          }}
        >
          <div
            className="text-xs font-semibold mb-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Trend vs previous note
          </div>
          {comparison.summary && (
            <p className="text-sm mb-1" style={{ color: "hsl(var(--ink-1))" }}>
              {comparison.summary}
            </p>
          )}
          {comparison.changes.length > 0 && (
            <ul className="list-disc pl-5 space-y-0.5 text-sm">
              {comparison.changes.map((c, i) => (
                <li key={i} style={{ color: "hsl(var(--ink-1))" }}>
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SmartNotesList({
  isPending,
  isError,
  notes,
}: {
  isPending: boolean;
  isError: boolean;
  notes: SmartNote[];
}) {
  if (isPending) return <Spinner label="Loading smart notes…" />;
  if (isError) {
    return (
      <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
        Failed to load smart notes.
      </p>
    );
  }
  if (notes.length === 0) {
    return (
      <EmptyState
        title="No smart notes yet."
        hint="Write a note above and review it for Medicare compliance before saving."
      />
    );
  }
  return (
    <ul className="space-y-3" data-testid="smart-notes-list">
      {notes.map((note) => (
        <SmartNoteCard key={note.id} note={note} />
      ))}
    </ul>
  );
}

function SmartNoteCard({ note }: { note: SmartNote }) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className="rounded border p-3"
      style={{ borderColor: "hsl(var(--line-1))", backgroundColor: "#ffffff" }}
    >
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <ComplianceBadge
          compliant={note.compliant}
          score={note.complianceScore}
        />
        <ProviderBadge provider={note.reviewProvider} />
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {formatDateTime(note.createdAt)}
          {note.authorEmail ? ` · ${note.authorEmail}` : ""}
        </span>
        <button
          type="button"
          className="ml-auto text-xs underline"
          style={{ color: "hsl(var(--ink-3))" }}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide review" : "Show review"}
        </button>
      </div>
      <div
        className="text-sm whitespace-pre-wrap break-words"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {note.noteText}
      </div>
      {open && (
        <div
          className="mt-3 pt-3 border-t"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <ReviewPanel review={note.review} comparison={note.comparison} />
        </div>
      )}
    </li>
  );
}
