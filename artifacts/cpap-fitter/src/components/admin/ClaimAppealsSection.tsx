// ClaimAppealsSection — the appeal-letter workbench for a denied/appealed
// claim, rendered inside the claim drawer (admin-insurance-claims.tsx).
//
// The whole appeal lifecycle already exists server-side (routes/admin/
// claim-appeals.ts): generate the letter PDF, list letters, fax to the payer
// (auto-transitions denied → appealed), record an out-of-band delivery
// (mail/email/portal), and record the payer's outcome so win-rate + response
// aging are measurable. This is the UI for that backend — it had none.
//
// Gating mirrors the server: generate/fax/mark/outcome are patients.update;
// the list is patients.read. PHI: letter body is patient-facing copy; it is
// rendered but never logged.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gavel } from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Spinner } from "@/components/admin/Spinner";
import {
  type AppealLetterRow,
  faxAppealLetter,
  generateAppealLetter,
  getDenialSketch,
  listAppealLetters,
  markAppealDelivered,
  recordAppealOutcome,
} from "@/lib/admin/claim-appeals-api";

const OUTCOME_TONE: Record<string, { bg: string; color: string }> = {
  overturned: { bg: "rgba(21,128,61,0.12)", color: "#15803d" },
  partial: { bg: "rgba(180,83,9,0.12)", color: "#b45309" },
  upheld: { bg: "rgba(185,28,28,0.12)", color: "#b91c1c" },
  withdrawn: { bg: "rgba(0,0,0,0.06)", color: "hsl(var(--ink-3))" },
  pending: { bg: "rgba(29,78,216,0.12)", color: "#1d4ed8" },
};

export function ClaimAppealsSection({
  patientId,
  claimId,
}: {
  patientId: string;
  claimId: string;
}) {
  const qc = useQueryClient();
  const queryKey = ["admin", "claim-appeals", patientId, claimId] as const;
  const letters = useQuery({
    queryKey,
    queryFn: () => listAppealLetters(patientId, claimId),
    staleTime: 15_000,
  });

  function invalidate() {
    void qc.invalidateQueries({ queryKey });
    // The fax path auto-transitions the claim denied → appealed, so refresh
    // the claim + list too.
    void qc.invalidateQueries({
      queryKey: ["admin", "insurance-claim", patientId, claimId],
    });
    void qc.invalidateQueries({
      queryKey: ["admin", "insurance-claims", patientId],
    });
  }

  const [letterBody, setLetterBody] = useState("");
  const [bodyTouched, setBodyTouched] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Pre-fill the letter body from the denial analyzer's appeal-letter sketch so
  // the CSR edits a draft rather than writing from scratch; only seed an empty,
  // untouched textarea so we never clobber in-progress edits.
  const sketchQuery = useQuery({
    queryKey: ["admin", "claim-appeals", "sketch", patientId, claimId],
    queryFn: () => getDenialSketch(patientId, claimId),
    staleTime: 60_000,
  });
  const sketch = sketchQuery.data?.sketch ?? null;
  const denialAnalysisId = sketchQuery.data?.denialAnalysisId ?? null;
  useEffect(() => {
    if (sketch && !bodyTouched && letterBody === "") {
      setLetterBody(sketch);
    }
  }, [sketch, bodyTouched, letterBody]);

  const generate = useMutation({
    mutationFn: () =>
      generateAppealLetter(patientId, claimId, {
        letterBody: letterBody.trim(),
        denialAnalysisId,
      }),
    onSuccess: () => {
      setGenError(null);
      setLetterBody("");
      // Keep the textarea marked touched after a generate so the prefill effect
      // doesn't re-seed the cleared body (which would re-enable Generate and
      // let a second click persist a duplicate appeal letter for the claim).
      setBodyTouched(true);
      invalidate();
    },
    onError: (err) =>
      setGenError(
        err instanceof Error ? err.message : "Could not generate the letter.",
      ),
  });

  return (
    <section
      className="space-y-3 rounded border p-4"
      style={{ borderColor: "hsl(var(--surface-3))" }}
      data-testid="claim-appeals-section"
    >
      <h3 className="text-sm font-semibold inline-flex items-center gap-2">
        <Gavel className="h-4 w-4" />
        Appeals
      </h3>
      <p className="text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
        Generate an appeal letter, then fax it to the payer or record an
        out-of-band delivery. Faxing moves the claim to <em>appealed</em>.
        Record the payer&rsquo;s outcome when it lands so win-rate is
        measurable.
      </p>

      {/* Generate */}
      <div
        className="rounded border border-dashed p-3 space-y-2"
        style={{ borderColor: "hsl(var(--surface-3))" }}
      >
        <label className="block">
          <span className="text-xs font-medium block mb-1">
            Appeal letter body
            {sketch && !bodyTouched && letterBody === sketch ? (
              <span
                className="ml-2 font-normal"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                · pre-filled from the denial analysis — edit as needed
              </span>
            ) : null}
          </span>
          <textarea
            value={letterBody}
            onChange={(e) => {
              setLetterBody(e.target.value);
              setBodyTouched(true);
            }}
            rows={4}
            minLength={20}
            maxLength={8000}
            placeholder="Paste/edit the appeal narrative (often from the denial analysis appeal-letter sketch). The PDF is rendered with your DME letterhead + the payer address."
            className="w-full px-3 py-2 rounded-md border text-sm"
            style={{
              borderColor: "hsl(var(--surface-3))",
              backgroundColor: "hsl(var(--surface-2))",
            }}
          />
        </label>
        <div className="flex items-center gap-3">
          <Button
            disabled={letterBody.trim().length < 20 || generate.isPending}
            onClick={() => {
              setGenError(null);
              generate.mutate();
            }}
            data-testid="generate-appeal-letter"
          >
            {generate.isPending ? "Generating…" : "Generate letter (PDF)"}
          </Button>
          {letterBody.trim().length > 0 && letterBody.trim().length < 20 && (
            <span className="text-[12px]" style={{ color: "#b45309" }}>
              At least 20 characters.
            </span>
          )}
          {genError && (
            <span className="text-[12px]" style={{ color: "#9f1239" }}>
              ✗ {genError}
            </span>
          )}
        </div>
      </div>

      {/* Letters list */}
      {letters.isPending ? (
        <Spinner label="Loading appeal letters…" />
      ) : letters.isError ? (
        <p className="text-[12px]" style={{ color: "#9f1239" }}>
          Could not load appeal letters.
        </p>
      ) : letters.data.length === 0 ? (
        <p className="text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
          No appeal letters yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {letters.data.map((l) => (
            <AppealLetterCard
              key={l.id}
              patientId={patientId}
              claimId={claimId}
              letter={l}
              onChanged={invalidate}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AppealLetterCard({
  patientId,
  claimId,
  letter,
  onChanged,
}: {
  patientId: string;
  claimId: string;
  letter: AppealLetterRow;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const fax = useMutation({
    mutationFn: (faxNumber: string) =>
      faxAppealLetter(patientId, claimId, letter.id, faxNumber),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Fax failed."),
  });

  const markDelivered = useMutation({
    mutationFn: (method: "mail" | "email" | "portal_upload") =>
      markAppealDelivered(patientId, claimId, letter.id, method),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Could not record."),
  });

  const outcome = useMutation({
    mutationFn: (o: "overturned" | "upheld" | "partial" | "withdrawn") =>
      recordAppealOutcome(patientId, claimId, letter.id, o),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Could not record."),
  });

  const busy = fax.isPending || markDelivered.isPending || outcome.isPending;
  const outcomeTone = letter.outcome ? OUTCOME_TONE[letter.outcome] : null;

  return (
    <li
      className="rounded border p-3 space-y-2 text-sm"
      style={{ borderColor: "hsl(var(--surface-3))" }}
      data-testid={`appeal-letter-${letter.id}`}
    >
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span style={{ color: "hsl(var(--ink-3))" }}>
          {new Date(letter.created_at).toLocaleDateString()}
          {letter.delivery_method ? ` · ${letter.delivery_method}` : ""}
          {letter.delivered_at
            ? ` · delivered ${new Date(letter.delivered_at).toLocaleDateString()}`
            : ""}
        </span>
        {outcomeTone && letter.outcome && (
          <span
            className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
            style={{
              backgroundColor: outcomeTone.bg,
              color: outcomeTone.color,
            }}
          >
            {letter.outcome}
            {letter.responded_at
              ? ` · ${new Date(letter.responded_at).toLocaleDateString()}`
              : ""}
          </span>
        )}
      </div>

      {/* Delivery actions — only until the appeal has a recorded outcome. */}
      {!letter.outcome && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            intent="secondary"
            disabled={busy}
            onClick={() => {
              const n = window.prompt(
                "Payer appeal fax number (E.164, e.g. +18145551234):",
              );
              const trimmed = n?.trim();
              if (trimmed) fax.mutate(trimmed);
            }}
            data-testid={`appeal-fax-${letter.id}`}
          >
            {fax.isPending ? "Faxing…" : "Fax to payer"}
          </Button>
          <span className="text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
            or mark delivered:
          </span>
          {(["mail", "email", "portal_upload"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={busy}
              onClick={() => markDelivered.mutate(m)}
              className="text-[12px] font-semibold underline disabled:opacity-50"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              {m === "portal_upload" ? "portal" : m}
            </button>
          ))}
        </div>
      )}

      {/* Outcome — recordable once the appeal has gone out. */}
      {letter.delivered_at && !letter.outcome && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
            Payer outcome:
          </span>
          {(["overturned", "partial", "upheld", "withdrawn"] as const).map(
            (o) => (
              <button
                key={o}
                type="button"
                disabled={busy}
                onClick={() => outcome.mutate(o)}
                className="text-[12px] font-semibold underline disabled:opacity-50"
                style={{ color: "hsl(var(--ink-2))" }}
                data-testid={`appeal-outcome-${o}-${letter.id}`}
              >
                {o}
              </button>
            ),
          )}
        </div>
      )}

      {error && (
        <p className="text-[12px]" style={{ color: "#9f1239" }}>
          ✗ {error}
        </p>
      )}
    </li>
  );
}
