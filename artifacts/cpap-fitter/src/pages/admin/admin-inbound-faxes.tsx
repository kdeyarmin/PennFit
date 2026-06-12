// /admin/inbound-faxes — CSR triage queue for inbound faxes.
//
// Page layout
// -----------
// Header with status filter (Open / All / Archived); below it, a
// table of faxes with received-at, sender, page count, and a status
// pill. Selecting a row opens the triage modal which embeds the PDF
// in an iframe and exposes the attach-to-patient / archive controls.
//
// MVP scope: patient + provider + prescription IDs are entered as
// UUIDs (most CSRs will copy/paste from the patient-detail page in
// another tab). A follow-up sprint can replace those with proper
// autocomplete pickers. The state-machine validation lives on the
// server (returns 400 with the issue), so the form is permissive on
// purpose.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  Inbox,
  Loader2,
  ScanBarcode,
  Sparkles,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  autoFileInboundFax,
  inboundFaxMediaUrl,
  listInboundFaxes,
  patchInboundFax,
  runFaxOcr,
  type AutoFileFaxResponse,
  type AutoFileStatus,
  type FaxOcrFields,
  type InboundFaxListItem,
  type InboundFaxStatus,
  type RunFaxOcrResponse,
} from "@/lib/admin/inbound-faxes-api";
import { useUrlState } from "@/hooks/use-url-state";

// How each barcode auto-file outcome reads to a CSR, and how loud it
// should be. `filed` is the only success; the rest explain why a fax was
// left for manual triage. See migration 0258 / lib/fax/auto-file-signed.
const AUTO_FILE_TEXT: Record<
  AutoFileStatus,
  { tone: "ok" | "warn" | "muted"; label: string }
> = {
  filed: {
    tone: "ok",
    label: "Auto-filed to the patient chart and marked returned & signed.",
  },
  already_returned: {
    tone: "muted",
    label: "Matched a signature that was already returned — no action taken.",
  },
  no_match: {
    tone: "warn",
    label:
      "A tracking code was read, but no matching outstanding signature was found.",
  },
  no_patient: {
    tone: "warn",
    label:
      "Matched a signature with no linked patient — marked returned, but not filed to a chart.",
  },
  no_code: {
    tone: "muted",
    label: "No PennFit tracking barcode was found on this fax.",
  },
  failed: {
    tone: "warn",
    label:
      "Couldn't auto-file this fax (scan or filing error). Triage by hand.",
  },
  unsupported: {
    tone: "muted",
    label: "This fax type can't be scanned for a tracking barcode.",
  },
  offline: {
    tone: "muted",
    label: "Barcode auto-file is offline (no AI key configured).",
  },
};

// Banner shown in the triage modal summarizing the auto-file attempt.
function AutoFileBanner({ fax }: { fax: InboundFaxListItem | null }) {
  if (!fax?.autoFileStatus) return null;
  const meta = AUTO_FILE_TEXT[fax.autoFileStatus];
  const palette =
    meta.tone === "ok"
      ? { bg: "#ecfdf5", border: "#a7f3d0", fg: "#065f46" }
      : meta.tone === "warn"
        ? { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" }
        : {
            bg: "hsl(var(--bg-2))",
            border: "hsl(var(--line-1))",
            fg: "hsl(var(--ink-2))",
          };
  return (
    <div
      className="rounded border p-3 text-xs flex items-start gap-2"
      style={{
        backgroundColor: palette.bg,
        borderColor: palette.border,
        color: palette.fg,
      }}
    >
      {meta.tone === "ok" ? (
        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
      ) : (
        <Sparkles className="h-4 w-4 mt-0.5 shrink-0" />
      )}
      <div>
        <span className="font-semibold">{meta.label}</span>
        {fax.trackingCodeDetected && (
          <span className="ml-1 font-mono">({fax.trackingCodeDetected})</span>
        )}
      </div>
    </div>
  );
}

// In-modal action: run the barcode auto-file on this fax on demand — the
// same routine the ingest runs on arrival. On a confident match it files
// the fax to the patient chart + marks the signature returned, then closes
// the modal; otherwise it shows why it couldn't (no_code / no_match / …).
function BarcodeAutoFilePanel({
  faxId,
  onFiled,
}: {
  faxId: string;
  onFiled: () => void;
}) {
  const [result, setResult] = useState<AutoFileFaxResponse | null>(null);
  const run = useMutation({
    mutationFn: () => autoFileInboundFax(faxId),
    onSuccess: (r) => {
      setResult(r);
      if (r.status === "filed") onFiled();
    },
  });
  const meta = result ? AUTO_FILE_TEXT[result.status] : null;
  return (
    <div
      className="rounded border p-3 space-y-2"
      style={{
        borderColor: "hsl(var(--line-1))",
        backgroundColor: "hsl(var(--bg-2))",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs font-semibold flex items-center gap-1"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          <ScanBarcode className="h-3.5 w-3.5" />
          Barcode auto-file
        </span>
        <Button
          intent="ghost"
          size="sm"
          isLoading={run.isPending}
          onClick={() => {
            setResult(null);
            run.mutate();
          }}
        >
          Scan barcode &amp; file
        </Button>
      </div>
      <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        Reads the PennFit tracking barcode and, on a match, files this fax to
        the patient chart and marks the signature returned.
      </p>
      {run.isError && (
        <p className="text-xs text-rose-700">
          Couldn&apos;t run the scan. Try again.
        </p>
      )}
      {meta && result?.status !== "filed" && (
        <p
          className="text-xs"
          style={{
            color: meta.tone === "warn" ? "#92400e" : "hsl(var(--ink-2))",
          }}
        >
          {meta.label}
          {result?.trackingCode ? ` (${result.trackingCode})` : ""}
        </p>
      )}
    </div>
  );
}

// Auto-file outcomes a CSR should act on: a code was read/attempted but the
// fax couldn't be fully filed. Surfaced as a "Needs review" chip + filter.
const NEEDS_REVIEW_STATUSES: ReadonlySet<AutoFileStatus> = new Set([
  "no_match",
  "no_patient",
  "failed",
]);
const needsReview = (s: AutoFileStatus | null): boolean =>
  s !== null && NEEDS_REVIEW_STATUSES.has(s);

type Filter = "open" | "new" | "triaged" | "attached" | "archived";

const FILTER_IDS: ReadonlySet<string> = new Set<Filter>([
  "open",
  "new",
  "triaged",
  "attached",
  "archived",
]);
const isFilter = (v: string): v is Filter => FILTER_IDS.has(v);

const queryKey = (f: Filter) => ["admin", "inbound-faxes", f] as const;

export function AdminInboundFaxesPage() {
  const [filter, setFilter] = useUrlState<Filter>({
    key: "filter",
    defaultValue: "open",
    isAllowed: isFilter,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKey(filter),
    queryFn: () => listInboundFaxes(filter),
  });

  const rows = data?.faxes ?? [];
  const visibleRows = needsReviewOnly
    ? rows.filter((f) => needsReview(f.autoFileStatus))
    : rows;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Inbox className="h-6 w-6" />
          Inbound faxes
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Faxes delivered to our fax number. Triage each into the right patient
          + document category, or archive junk. Bytes are mirrored to private
          storage so the PDF stays available long after the carrier&apos;s
          365-day media retention window.
        </p>
      </header>

      <div className="flex items-center gap-2 flex-wrap">
        {(["open", "new", "triaged", "attached", "archived"] as const).map(
          (f) => (
            <FilterChip
              key={f}
              label={
                f === "open"
                  ? "Open queue"
                  : f.charAt(0).toUpperCase() + f.slice(1)
              }
              active={filter === f}
              onClick={() => setFilter(f)}
            />
          ),
        )}
        <label
          className="ml-auto flex items-center gap-1.5 text-xs font-semibold cursor-pointer"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          <input
            type="checkbox"
            checked={needsReviewOnly}
            onChange={(e) => setNeedsReviewOnly(e.target.checked)}
          />
          Needs review only
        </label>
      </div>

      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : visibleRows.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            {needsReviewOnly
              ? "Nothing needs review in this view."
              : "No faxes in this view."}
          </p>
        ) : (
          <FaxTable rows={visibleRows} onSelect={setSelectedId} />
        )}
      </Card>

      {selectedId && (
        <TriageModal
          faxId={selectedId}
          fax={data?.faxes.find((f) => f.id === selectedId) ?? null}
          onClose={() => setSelectedId(null)}
          filter={filter}
        />
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
      style={{
        backgroundColor: active
          ? "hsl(var(--penn-gold))"
          : "hsl(var(--line-2))",
        color: active ? "hsl(var(--penn-navy))" : "hsl(var(--ink-2))",
      }}
    >
      {label}
    </button>
  );
}

const STATUS_COLOR: Record<InboundFaxStatus, string> = {
  new: "bg-amber-100 text-amber-900",
  triaged: "bg-blue-100 text-blue-900",
  attached: "bg-emerald-100 text-emerald-900",
  archived: "bg-gray-100 text-gray-700",
};

function FaxTable({
  rows,
  onSelect,
}: {
  rows: InboundFaxListItem[];
  onSelect: (id: string) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Received</th>
          <th className="py-2 font-semibold">From</th>
          <th className="py-2 font-semibold">Pages</th>
          <th className="py-2 font-semibold">Category</th>
          <th className="py-2 font-semibold">Status</th>
          <th className="py-2 font-semibold"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const received = new Date(r.receivedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          return (
            <tr
              key={r.id}
              className="border-b cursor-pointer hover:bg-[hsl(var(--bg-2))]"
              style={{ borderColor: "hsl(var(--line-2))" }}
              onClick={() => onSelect(r.id)}
            >
              <td className="py-2">{received}</td>
              <td className="py-2 font-mono text-xs">{r.fromE164 ?? "—"}</td>
              <td
                className="py-2 tabular-nums text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {r.numPages ?? "—"}
              </td>
              <td className="py-2 text-xs">{r.attachedDocumentType ?? "—"}</td>
              <td className="py-2">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_COLOR[r.status]}`}
                >
                  {r.status}
                </span>
                {r.autoFileStatus === "filed" && (
                  <span
                    className="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-900"
                    title={
                      r.trackingCodeDetected
                        ? `Auto-filed from barcode ${r.trackingCodeDetected}`
                        : "Auto-filed from barcode"
                    }
                  >
                    <CheckCircle2 className="h-3 w-3" /> Auto-filed
                  </span>
                )}
                {needsReview(r.autoFileStatus) && (
                  <span
                    className="ml-1 inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-900"
                    title={
                      r.autoFileStatus
                        ? AUTO_FILE_TEXT[r.autoFileStatus].label
                        : undefined
                    }
                  >
                    Needs review
                  </span>
                )}
              </td>
              <td className="py-2 text-right">
                {r.hasMedia ? (
                  <span className="inline-flex items-center gap-1 text-xs text-[hsl(var(--penn-navy))]">
                    <FileText className="h-3 w-3" /> Has PDF
                  </span>
                ) : (
                  <span
                    className="text-xs"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    Media missing
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const DOCUMENT_TYPE_SUGGESTIONS = [
  "sleep_study",
  "prescription",
  "chart_note",
  "rx_renewal_response",
  "eob",
  "other",
];

function TriageModal({
  faxId,
  fax,
  onClose,
  filter,
}: {
  faxId: string;
  fax: InboundFaxListItem | null;
  onClose: () => void;
  filter: Filter;
}) {
  const qc = useQueryClient();

  const [patientId, setPatientId] = useState(fax?.attachedPatientId ?? "");
  const [providerId, setProviderId] = useState(fax?.attachedProviderId ?? "");
  const [prescriptionId, setPrescriptionId] = useState(
    fax?.attachedPrescriptionId ?? "",
  );
  const [docType, setDocType] = useState(fax?.attachedDocumentType ?? "");
  const [notes, setNotes] = useState(fax?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [ocr, setOcr] = useState<RunFaxOcrResponse | null>(null);

  const runOcr = useMutation({
    mutationFn: () => runFaxOcr(faxId),
    onSuccess: (r) => {
      setOcr(r);
      // Auto-apply the unambiguous, non-identifying field (document
      // category) only when the CSR hasn't already typed one. Patient
      // identity stays a human decision — we surface it as a hint, never
      // auto-fill a UUID we can't derive from a name anyway.
      if (r.fields?.documentType && docType.trim() === "") {
        setDocType(r.fields.documentType);
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  const patch = useMutation({
    mutationFn: (body: Parameters<typeof patchInboundFax>[1]) =>
      patchInboundFax(faxId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKey(filter) });
      void qc.invalidateQueries({ queryKey: ["admin-inbox-counts"] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function isUuidOrEmpty(s: string): boolean {
    return s === "" || /^[0-9a-f-]{36}$/i.test(s.trim());
  }

  const patientValid = isUuidOrEmpty(patientId);
  const providerValid = isUuidOrEmpty(providerId);
  const rxValid = isUuidOrEmpty(prescriptionId);
  const formValid = patientValid && providerValid && rxValid;

  function commonBody(): Parameters<typeof patchInboundFax>[1] {
    return {
      attachedPatientId: patientId.trim() || null,
      attachedProviderId: providerId.trim() || null,
      attachedPrescriptionId: prescriptionId.trim() || null,
      attachedDocumentType: docType.trim() || null,
      notes: notes.trim() || null,
    };
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !patch.isPending && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-5xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2
              className="text-lg font-semibold"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Triage fax
            </h2>
            {fax?.hasMedia && (
              <a
                href={inboundFaxMediaUrl(faxId)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-[hsl(var(--penn-navy))] hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Open PDF in new tab
              </a>
            )}
          </div>

          <AutoFileBanner fax={fax} />
          {fax?.referralReviewId && (
            <div
              className="rounded border p-3 text-xs flex items-center gap-2"
              style={{
                backgroundColor: "#eff6ff",
                borderColor: "#bfdbfe",
                color: "#1d4ed8",
              }}
            >
              <Sparkles className="h-4 w-4 shrink-0" />
              <span>
                The Referral Reviewer picked up this fax
                {fax.referralReviewStatus === "extracted"
                  ? " and has an extraction ready"
                  : fax.referralReviewStatus === "accepted"
                    ? " — it was accepted into a patient record"
                    : ""}
                .
              </span>
              <a
                className="font-semibold underline whitespace-nowrap"
                href={`/admin/referral-reviews?review=${encodeURIComponent(fax.referralReviewId)}`}
              >
                Open review
              </a>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* PDF preview pane */}
            <div className="border rounded h-[60vh] overflow-hidden bg-[hsl(var(--bg-2))]">
              {fax?.hasMedia ? (
                <iframe
                  src={inboundFaxMediaUrl(faxId)}
                  title="Fax preview"
                  className="w-full h-full"
                  style={{ border: 0 }}
                />
              ) : (
                <div className="h-full flex items-center justify-center text-sm text-muted-foreground p-4 text-center">
                  Media not persisted for this fax. The inbound webhook may have
                  hit the retention window, or the download failed at receive
                  time. Check the application log for the audit row with this
                  fax&apos;s ID.
                </div>
              )}
            </div>

            {/* Triage form */}
            <div className="space-y-3">
              {fax?.hasMedia && fax.autoFileStatus !== "filed" && (
                <BarcodeAutoFilePanel
                  faxId={faxId}
                  onFiled={() => {
                    void qc.invalidateQueries({ queryKey: queryKey(filter) });
                    void qc.invalidateQueries({
                      queryKey: ["admin-inbox-counts"],
                    });
                    onClose();
                  }}
                />
              )}
              {fax?.hasMedia && (
                <OcrPanel
                  running={runOcr.isPending}
                  result={ocr}
                  onRun={() => {
                    setError(null);
                    runOcr.mutate();
                  }}
                  onUseSummary={(text) =>
                    setNotes((prev) => (prev.trim() ? prev : text))
                  }
                />
              )}
              <FormField
                label="Patient ID"
                value={patientId}
                onChange={setPatientId}
                placeholder="UUID — copy from /admin/patients"
                invalid={!patientValid}
              />
              <FormField
                label="Provider ID (optional)"
                value={providerId}
                onChange={setProviderId}
                placeholder="UUID — copy from /admin/providers"
                invalid={!providerValid}
              />
              <FormField
                label="Prescription ID (optional)"
                value={prescriptionId}
                onChange={setPrescriptionId}
                placeholder="UUID — copy from the patient's Rx row"
                invalid={!rxValid}
              />
              <div>
                <label
                  className="text-xs font-semibold block mb-1"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  Document category
                </label>
                <Input
                  list="fax-doc-types"
                  value={docType}
                  onChange={(e) => setDocType(e.target.value)}
                  placeholder="sleep_study, prescription, chart_note…"
                  aria-label="Document category"
                />
                <datalist id="fax-doc-types">
                  {DOCUMENT_TYPE_SUGGESTIONS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              <div>
                <label
                  className="text-xs font-semibold block mb-1"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  Notes
                </label>
                <textarea
                  className="w-full rounded border px-2 py-1.5 text-sm"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={2000}
                  aria-label="Notes"
                />
              </div>

              {error && (
                <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
                  {error}
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
            <Button intent="ghost" onClick={onClose} disabled={patch.isPending}>
              Cancel
            </Button>
            <Button
              intent="ghost"
              disabled={patch.isPending}
              onClick={() =>
                patch.mutate({ ...commonBody(), status: "archived" })
              }
            >
              {patch.isPending && patch.variables?.status === "archived" ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : null}
              Archive (junk)
            </Button>
            <Button
              intent="secondary"
              disabled={patch.isPending || !formValid}
              onClick={() => patch.mutate(commonBody())}
            >
              Save (keep as new)
            </Button>
            <Button
              disabled={
                patch.isPending || !formValid || patientId.trim().length === 0
              }
              isLoading={
                patch.isPending && patch.variables?.status === "attached"
              }
              onClick={() =>
                patch.mutate({ ...commonBody(), status: "attached" })
              }
              title={
                patientId.trim().length === 0
                  ? "Set a patient ID first"
                  : undefined
              }
            >
              Attach to patient
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// AI extraction panel: a "read the fax for me" button plus the
// resulting fields shown as copy-able hints. We never auto-fill patient
// UUIDs (we can't derive them from a name); the CSR uses the hints to
// find the right patient. Document category auto-applies upstream.
function OcrPanel({
  running,
  result,
  onRun,
  onUseSummary,
}: {
  running: boolean;
  result: RunFaxOcrResponse | null;
  onRun: () => void;
  onUseSummary: (text: string) => void;
}) {
  return (
    <div
      className="rounded border p-3 space-y-2"
      style={{
        borderColor: "hsl(var(--line-1))",
        backgroundColor: "hsl(var(--bg-2))",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-xs font-semibold flex items-center gap-1"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          <Sparkles className="h-3.5 w-3.5" />
          AI field extraction
        </span>
        <Button intent="ghost" size="sm" disabled={running} onClick={onRun}>
          {running ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          {result ? "Re-run" : "Extract fields"}
        </Button>
      </div>

      {result?.status === "offline" && (
        <p className="text-xs text-muted-foreground">
          AI extraction isn&apos;t configured on this environment — key the
          fields by hand from the preview.
        </p>
      )}
      {(result?.status === "failed" || result?.status === "unsupported") && (
        <p className="text-xs text-amber-800">
          Couldn&apos;t read this fax automatically ({result.status}). Key the
          fields by hand from the preview.
        </p>
      )}
      {result?.status === "extracted" && result.fields && (
        <OcrFields fields={result.fields} onUseSummary={onUseSummary} />
      )}
    </div>
  );
}

function OcrFields({
  fields,
  onUseSummary,
}: {
  fields: FaxOcrFields;
  onUseSummary: (text: string) => void;
}) {
  const rows: Array<[string, string | null]> = [
    ["Patient", fields.patientName],
    ["DOB", fields.patientDob],
    ["Phone", fields.patientPhone],
    ["Physician", fields.physicianName],
    ["NPI", fields.physicianNpi],
    ["Doc type", fields.documentType],
  ];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Detected
        </span>
        <span
          className="text-[10px] rounded-full px-1.5 py-0.5"
          style={{
            backgroundColor: "hsl(var(--line-2))",
            color: "hsl(var(--ink-2))",
          }}
        >
          confidence: {fields.confidence}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium text-right truncate" title={v ?? ""}>
              {v ?? "—"}
            </dd>
          </div>
        ))}
      </dl>
      {fields.items.length > 0 && (
        <div className="text-xs">
          <div className="text-muted-foreground mb-0.5">Items</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {fields.items.map((it, i) => (
              <li key={i}>
                {it.description}
                {it.hcpcs ? ` (${it.hcpcs})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {fields.summary && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs italic text-muted-foreground">
            {fields.summary}
          </p>
          <button
            type="button"
            className="text-[11px] font-semibold whitespace-nowrap underline text-[hsl(var(--penn-navy))]"
            onClick={() => onUseSummary(fields.summary ?? "")}
          >
            Use as note
          </button>
        </div>
      )}
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
}) {
  return (
    <div>
      <label
        className="text-xs font-semibold block mb-1"
        style={{ color: "hsl(var(--penn-navy))" }}
      >
        {label}
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        style={{
          borderColor: invalid ? "#dc2626" : undefined,
        }}
      />
      {invalid && (
        <p className="text-[10px] text-rose-700 mt-1">
          Must be a UUID or empty.
        </p>
      )}
    </div>
  );
}
