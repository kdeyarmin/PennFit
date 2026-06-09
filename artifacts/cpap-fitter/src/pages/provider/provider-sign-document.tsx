// Provider signing screen — shows one document and captures the
// e-signature: a typed legal name + explicit ESIGN consent. No drawn
// image is collected (typed-name + consent is the ESIGN/CMS-compliant
// capture and avoids storing signature images).

import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, FileSignature, CheckCircle2 } from "lucide-react";

import {
  getProviderQueueItem,
  signProviderDocument,
  declineProviderDocument,
} from "@/lib/provider/provider-api";
import {
  Button,
  Card,
  ErrorNote,
  ProviderShell,
  Spinner,
  formatDateTime,
} from "./provider-ui";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export function ProviderSignDocument({
  id,
  providerName,
}: {
  id: string;
  providerName?: string | null;
}) {
  const [, setLocation] = useLocation();
  const [signerName, setSignerName] = useState("");
  const [signerTitle, setSignerTitle] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [done, setDone] = useState<"signed" | "declined" | null>(null);

  const query = useQuery({
    queryKey: ["provider", "queue", "item", id],
    queryFn: () => getProviderQueueItem(id),
  });

  // Prefill the typed name with the provider's legal name on first load.
  useEffect(() => {
    if (providerName && !signerName) setSignerName(providerName);
  }, [providerName, signerName]);

  const signMut = useMutation({
    mutationFn: () =>
      signProviderDocument(id, {
        consentEsign: true,
        signerName: signerName.trim(),
        signerTitle: signerTitle.trim() || undefined,
      }),
    onSuccess: () => setDone("signed"),
    onError: (err: Error) => setError(err.message),
  });

  const declineMut = useMutation({
    mutationFn: () =>
      declineProviderDocument(id, declineReason.trim() || undefined),
    onSuccess: () => setDone("declined"),
    onError: (err: Error) => setError(err.message),
  });

  if (done) {
    return (
      <ProviderShell providerName={providerName}>
        <Card className="mx-auto max-w-lg p-8 text-center">
          <CheckCircle2
            className="mx-auto h-12 w-12 text-emerald-500"
            aria-hidden="true"
          />
          <h1 className="mt-3 text-xl font-bold text-slate-900">
            {done === "signed" ? "Signature recorded" : "Document declined"}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {done === "signed"
              ? "Thank you. The practice has been notified."
              : "The practice has been notified of your decision."}
          </p>
          <Button className="mt-6" onClick={() => setLocation("/provider")}>
            Back to my documents
          </Button>
        </Card>
      </ProviderShell>
    );
  }

  return (
    <ProviderShell providerName={providerName}>
      <button
        onClick={() => setLocation("/provider")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to queue
      </button>

      {query.isPending ? (
        <Spinner label="Loading document…" />
      ) : query.isError ? (
        <ErrorNote>This document could not be loaded.</ErrorNote>
      ) : query.data.status !== "pending" ? (
        <Card className="p-6">
          <p className="text-sm text-slate-600">
            This document is no longer awaiting your signature (status:{" "}
            {query.data.status}).
          </p>
        </Card>
      ) : (
        <div className="space-y-5">
          <Card className="p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                <FileSignature className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h1 className="text-xl font-bold text-slate-900">
                  {query.data.title}
                </h1>
                <p className="text-sm text-slate-500">
                  {query.data.subjectLabel}
                  {query.data.patientName ? ` · ${query.data.patientName}` : ""}
                </p>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-slate-400">Requested</dt>
                <dd className="text-slate-700">
                  {formatDateTime(query.data.createdAt)}
                </dd>
              </div>
              {query.data.expiresAt ? (
                <div>
                  <dt className="text-slate-400">Expires</dt>
                  <dd className="text-slate-700">
                    {formatDateTime(query.data.expiresAt)}
                  </dd>
                </div>
              ) : null}
            </dl>
            {query.data.detail && Object.keys(query.data.detail).length > 0 ? (
              <pre className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                {JSON.stringify(query.data.detail, null, 2)}
              </pre>
            ) : null}
          </Card>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          {declining ? (
            <Card className="p-6">
              <h2 className="font-semibold text-slate-900">Decline to sign</h2>
              <p className="mt-1 text-sm text-slate-500">
                Optionally tell the practice why.
              </p>
              <textarea
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                rows={3}
                className={`${inputClass} mt-3`}
                placeholder="Reason (optional)"
              />
              <div className="mt-4 flex gap-3">
                <Button
                  variant="danger"
                  onClick={() => declineMut.mutate()}
                  disabled={declineMut.isPending}
                >
                  {declineMut.isPending ? "Submitting…" : "Confirm decline"}
                </Button>
                <Button variant="ghost" onClick={() => setDeclining(false)}>
                  Cancel
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="p-6">
              <h2 className="font-semibold text-slate-900">
                Apply your signature
              </h2>
              <form
                className="mt-4 space-y-4"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  if (!consent || signerName.trim().length < 2) return;
                  signMut.mutate();
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
                <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span>
                    I agree that typing my name above is my legal electronic
                    signature on this document — the legal equivalent of my
                    handwritten signature under the federal ESIGN Act and CMS /
                    Medicare e-signature requirements.
                  </span>
                </label>
                <div className="flex gap-3">
                  <Button
                    type="submit"
                    disabled={
                      signMut.isPending ||
                      !consent ||
                      signerName.trim().length < 2
                    }
                  >
                    {signMut.isPending ? "Signing…" : "Sign document"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setDeclining(true)}
                  >
                    Decline
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </div>
      )}
    </ProviderShell>
  );
}
