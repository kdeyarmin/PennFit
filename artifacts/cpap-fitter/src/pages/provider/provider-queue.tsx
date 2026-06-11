// Provider document queue — the list of items awaiting (or recently
// acted on by) the signed-in provider. Pending documents can be opened
// and signed one at a time, or selected with checkboxes and signed
// together: one typed name + one ESIGN consent (+ one optional drawn
// signature) executed against every selected document. Server-side
// each document is still signed individually (its own hash-chained
// event and certificate entry).

import { useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSignature, ChevronRight, Inbox, CheckCircle2 } from "lucide-react";

import {
  SignaturePad,
  type SignaturePadHandle,
} from "@/components/signature-pad";
import {
  getProviderQueue,
  signProviderDocumentsBatch,
  type QueueItem,
} from "@/lib/provider/provider-api";
import {
  Button,
  Card,
  ProviderShell,
  Spinner,
  StatusBadge,
  ErrorNote,
  formatDateTime,
} from "./provider-ui";

type Tab = "pending" | "signed" | "all";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

const SKIP_REASON_LABEL: Record<string, string> = {
  not_found: "could not be found",
  not_pending: "was no longer awaiting signature",
  expired: "had expired",
};

export function ProviderQueue({
  providerName,
}: {
  providerName?: string | null;
}) {
  const [tab, setTab] = useState<Tab>("pending");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const query = useQuery({
    queryKey: ["provider", "queue", tab],
    queryFn: () => getProviderQueue(tab),
  });

  const tabs: { key: Tab; label: string }[] = [
    { key: "pending", label: "Awaiting signature" },
    { key: "signed", label: "Signed" },
    { key: "all", label: "All" },
  ];

  const requests = query.data?.requests ?? [];
  const selected = requests.filter(
    (r) => r.status === "pending" && checked.has(r.id),
  );

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ProviderShell providerName={providerName}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Documents to sign</h1>
        <p className="mt-1 text-sm text-slate-500">
          Open a document to review and sign it, or check several and sign them
          together.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                setTab(t.key);
                setBatchOpen(false);
              }}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key
                  ? "bg-blue-700 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {selected.length > 0 && !batchOpen ? (
          <Button onClick={() => setBatchOpen(true)}>
            Sign {selected.length} selected
          </Button>
        ) : null}
      </div>

      {batchOpen && selected.length > 0 ? (
        <BatchSignPanel
          documents={selected}
          providerName={providerName}
          onClose={() => setBatchOpen(false)}
          onSigned={(signedIds) => {
            setChecked((prev) => {
              const next = new Set(prev);
              for (const id of signedIds) next.delete(id);
              return next;
            });
          }}
        />
      ) : null}

      {query.isPending ? (
        <Spinner label="Loading your documents…" />
      ) : query.isError ? (
        <ErrorNote>
          We couldn't load your documents. Please refresh and try again.
        </ErrorNote>
      ) : requests.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Inbox className="h-10 w-10 text-slate-300" aria-hidden="true" />
          <p className="text-sm text-slate-500">
            {tab === "pending"
              ? "You're all caught up — nothing is awaiting your signature."
              : "Nothing here yet."}
          </p>
        </Card>
      ) : (
        <Card className="divide-y divide-slate-100">
          {requests.map((r) => {
            return r.status === "pending" ? (
              <div key={r.id} className="flex items-stretch hover:bg-slate-50">
                <label className="flex cursor-pointer items-center pl-5">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    aria-label={`Select ${r.title} for signing`}
                    checked={checked.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                </label>
                <Link
                  href={`/provider/sign/${r.id}`}
                  className="block min-w-0 flex-1"
                >
                  <div className="flex items-center gap-4 px-4 py-4">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                      <FileSignature className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-900">
                        {r.title}
                      </p>
                      <p className="truncate text-sm text-slate-500">
                        {r.subjectLabel}
                        {r.patientName ? ` · ${r.patientName}` : ""} ·{" "}
                        {formatDateTime(r.createdAt)}
                      </p>
                    </div>
                    <StatusBadge status={r.status} />
                    <ChevronRight
                      className="h-5 w-5 shrink-0 text-slate-400"
                      aria-hidden="true"
                    />
                  </div>
                </Link>
              </div>
            ) : (
              <div key={r.id} className="flex items-center gap-4 px-5 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                  <FileSignature className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-900">
                    {r.title}
                  </p>
                  <p className="truncate text-sm text-slate-500">
                    {r.subjectLabel}
                    {r.patientName ? ` · ${r.patientName}` : ""} ·{" "}
                    {formatDateTime(r.createdAt)}
                  </p>
                </div>
                <StatusBadge status={r.status} />
              </div>
            );
          })}
        </Card>
      )}
    </ProviderShell>
  );
}

// ── Batch signing panel ───────────────────────────────────────────
function BatchSignPanel({
  documents,
  providerName,
  onClose,
  onSigned,
}: {
  documents: QueueItem[];
  providerName?: string | null;
  onClose: () => void;
  onSigned: (signedIds: string[]) => void;
}) {
  const qc = useQueryClient();
  const [signerName, setSignerName] = useState(providerName ?? "");
  const [signerTitle, setSignerTitle] = useState("");
  const sigRef = useRef<SignaturePadHandle | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    signedCount: number;
    skipped: Array<{ id: string; reason: string }>;
  } | null>(null);

  const batchMut = useMutation({
    mutationFn: () =>
      signProviderDocumentsBatch({
        ids: documents.map((d) => d.id),
        consentEsign: true,
        signerName: signerName.trim(),
        signerTitle: signerTitle.trim() || undefined,
        signatureImage: sigRef.current?.toDataURL() ?? undefined,
      }),
    onSuccess: (data) => {
      setSummary({ signedCount: data.signed.length, skipped: data.skipped });
      onSigned(data.signed);
      void qc.invalidateQueries({ queryKey: ["provider", "queue"] });
      void qc.invalidateQueries({ queryKey: ["provider", "me"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const titleById = new Map(documents.map((d) => [d.id, d.title]));

  if (summary) {
    return (
      <Card className="mb-5 p-6">
        <div className="flex items-start gap-3">
          <CheckCircle2
            className="h-6 w-6 shrink-0 text-emerald-500"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-900">
              {summary.signedCount}{" "}
              {summary.signedCount === 1 ? "document" : "documents"} signed
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              The practice has been notified.
            </p>
            {summary.skipped.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-sm text-amber-700">
                {summary.skipped.map((s) => (
                  <li key={s.id}>
                    “{titleById.get(s.id) ?? s.id}” was not signed — it{" "}
                    {SKIP_REASON_LABEL[s.reason] ?? "could not be signed"}.
                  </li>
                ))}
              </ul>
            ) : null}
            <Button className="mt-4" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-5 p-6">
      <h2 className="font-semibold text-slate-900">
        Sign {documents.length} documents together
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        One signature below is applied to each document individually — every
        document keeps its own audit trail and certificate. Open a document from
        the list first if you want to review its details.
      </p>

      <ul className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        {documents.map((d) => (
          <li key={d.id} className="truncate">
            • {d.title}
            {d.patientName ? ` — ${d.patientName}` : ""}
          </li>
        ))}
      </ul>

      {error ? (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      <form
        className="mt-4 space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!consent || signerName.trim().length < 2) return;
          setError(null);
          batchMut.mutate();
        }}
      >
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">
            Type your full legal name
          </label>
          <input
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            className={`${inputClass} font-[cursive] text-lg`}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">
            Title / credentials (optional)
          </label>
          <input
            value={signerTitle}
            onChange={(e) => setSignerTitle(e.target.value)}
            placeholder="e.g. MD, DO, NP"
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium text-slate-700">
            Draw your signature (optional)
          </label>
          <p className="text-xs text-slate-500">
            Your typed name above is your legal signature; a drawn signature is
            added to each document's record and printed certificate when
            provided.
          </p>
          <SignaturePad
            ref={sigRef}
            height={140}
            ariaLabel="Draw your signature"
          />
        </div>
        <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            I agree that typing my name above is my legal electronic signature
            on <strong>each of the {documents.length} documents listed</strong>{" "}
            — the legal equivalent of my handwritten signature under the federal
            ESIGN Act and CMS / Medicare e-signature requirements.
          </span>
        </label>
        <div className="flex gap-3">
          <Button
            type="submit"
            disabled={
              batchMut.isPending || !consent || signerName.trim().length < 2
            }
          >
            {batchMut.isPending
              ? "Signing…"
              : `Sign ${documents.length} documents`}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
