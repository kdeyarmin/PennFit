// /admin/billing/notes — the billing team's free-form notes log (0467).
//
// A shared scratchpad for billers: cross-cutting notes about claims,
// collections, payers, and patient accounts that don't belong on one
// specific claim or order. Append-only, newest first, filterable by
// category. Any admin staffer can read + post.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { StickyNote } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  type BillingNote,
  type BillingNoteCategory,
  createBillingNote,
  getBillingNotes,
} from "@/lib/admin/billing-notes-api";

const CATEGORIES: { value: BillingNoteCategory; label: string }[] = [
  { value: "claims", label: "Claims" },
  { value: "collections", label: "Collections" },
  { value: "payer", label: "Payer" },
  { value: "patient", label: "Patient" },
  { value: "general", label: "General" },
];

const CATEGORY_LABEL: Record<BillingNoteCategory, string> = {
  claims: "Claims",
  collections: "Collections",
  payer: "Payer",
  patient: "Patient",
  general: "General",
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function AdminBillingNotesPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<BillingNoteCategory | "all">("all");

  const query = useQuery({
    queryKey: ["admin", "billing-notes", filter] as const,
    queryFn: () => getBillingNotes(filter === "all" ? undefined : filter),
    staleTime: 15_000,
  });

  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] =
    useState<BillingNoteCategory>("general");

  const addMut = useMutation({
    mutationFn: () =>
      createBillingNote({ category: draftCategory, body: draft.trim() }),
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: ["admin", "billing-notes"] });
    },
  });

  const canSubmit = draft.trim().length > 0 && !addMut.isPending;

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-billing-notes-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <StickyNote className="h-6 w-6" />
          Billing notes
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          A shared log for the billing team — claims follow-ups, collections,
          payer calls, and account context. For notes about one specific claim,
          use the event log on that claim instead.
        </p>
      </header>

      {/* Compose */}
      <Card title="Add a note">
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <label
              className="text-xs font-medium"
              style={{ color: "hsl(var(--ink-3))" }}
              htmlFor="billing-note-category"
            >
              Category
            </label>
            <select
              id="billing-note-category"
              className="text-sm rounded border px-2 py-1 bg-transparent"
              style={{ borderColor: "hsl(var(--line-1))" }}
              value={draftCategory}
              onChange={(e) =>
                setDraftCategory(e.target.value as BillingNoteCategory)
              }
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="w-full text-sm rounded border px-3 py-2 bg-transparent min-h-[80px]"
            style={{ borderColor: "hsl(var(--line-1))" }}
            placeholder="What should the next biller know?"
            maxLength={4000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {draft.length}/4000
            </span>
            <button
              type="button"
              className="text-sm rounded border px-3 py-1.5 disabled:opacity-50"
              style={{ borderColor: "hsl(var(--line-1))" }}
              disabled={!canSubmit}
              onClick={() => addMut.mutate()}
            >
              {addMut.isPending ? "Saving…" : "Add note"}
            </button>
          </div>
          {addMut.isError ? (
            <p className="text-xs" style={{ color: "hsl(354 75% 38%)" }}>
              Couldn't save the note. Try again.
            </p>
          ) : null}
        </div>
      </Card>

      {/* Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterChip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label="All"
        />
        {CATEGORIES.map((c) => (
          <FilterChip
            key={c.value}
            active={filter === c.value}
            onClick={() => setFilter(c.value)}
            label={c.label}
          />
        ))}
      </div>

      {/* Feed */}
      {query.isPending ? (
        <Spinner label="Loading notes…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No notes yet
            {filter === "all" ? "" : ` in ${CATEGORY_LABEL[filter]}`}. Add the
            first one above.
          </p>
        </Card>
      ) : (
        <Card title={`Notes (${query.data.length})`}>
          <div className="space-y-2">
            {query.data.map((note) => (
              <NoteRow key={note.id} note={note} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="text-xs rounded-full border px-3 py-1"
      style={{
        borderColor: "hsl(var(--line-1))",
        background: active ? "hsl(var(--ink-1))" : "transparent",
        color: active ? "hsl(var(--paper-1))" : "hsl(var(--ink-2))",
      }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function NoteRow({ note }: { note: BillingNote }) {
  return (
    <div
      className="rounded border p-3 space-y-2"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="billing-note-row"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="flex items-center gap-2 text-sm">
          <Badge variant="neutral">{CATEGORY_LABEL[note.category]}</Badge>
          {note.patientId ? (
            <Link
              href={`/admin/patients/${note.patientId}`}
              className="text-xs underline"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              View patient
            </Link>
          ) : null}
        </span>
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {note.authorEmail} · {formatWhen(note.createdAt)}
        </span>
      </div>
      <p
        className="text-sm whitespace-pre-wrap"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {note.body}
      </p>
    </div>
  );
}
