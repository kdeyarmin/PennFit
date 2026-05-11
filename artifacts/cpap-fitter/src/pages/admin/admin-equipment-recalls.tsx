// /admin/equipment-recalls — manufacturer recall registry.
//
// Page surface
// ------------
//   * List of recalls grouped by status (active first).
//   * Severity badge (urgent / priority / advisory).
//   * "Scan now" button per recall — runs the match engine and
//     surfaces every affected dispensed serial in a modal.
//   * "Add recall" button opens a 1-step modal — manufacturer +
//     model + optional serial criteria (range or list).
//
// The scan is READ-ONLY. It surfaces who's affected; transitioning
// each device's status to "recalled" is a deliberate per-device
// action the CSR takes from the patient-detail Equipment tab.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  ExternalLink,
  Plus,
  Search,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createEquipmentRecall,
  listEquipmentRecalls,
  scanEquipmentRecall,
  type CreateRecallRequest,
  type EquipmentRecall,
  type RecallScanResult,
  type RecallSerialMatch,
  type RecallSeverity,
} from "@/lib/admin/equipment-api";

const queryKey = ["admin", "equipment-recalls"] as const;

export function AdminEquipmentRecallsPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: listEquipmentRecalls,
  });
  const [showAdd, setShowAdd] = useState(false);
  const [scanResult, setScanResult] = useState<RecallScanResult | null>(null);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <AlertTriangle className="h-6 w-6" />
            Equipment recalls
          </h1>
          <p
            className="text-sm mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Manufacturer recall notices the supplier is tracking.
            Scan a recall to surface every dispensed serial that
            matches its criteria; transition affected devices to
            &ldquo;recalled&rdquo; from each patient&apos;s Equipment
            tab.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Record recall
        </Button>
      </header>

      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.recalls.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            No recalls on file. Add one when a manufacturer publishes
            a notice.
          </p>
        ) : (
          <ul className="space-y-3">
            {data.recalls.map((r) => (
              <RecallRow
                key={r.id}
                recall={r}
                onScanResult={setScanResult}
              />
            ))}
          </ul>
        )}
      </Card>

      {showAdd && (
        <AddRecallModal
          onClose={() => setShowAdd(false)}
          onCreated={() => setShowAdd(false)}
        />
      )}

      {scanResult && (
        <ScanResultModal
          result={scanResult}
          onClose={() => setScanResult(null)}
        />
      )}
    </div>
  );
}

const SEVERITY_COLOR: Record<RecallSeverity, string> = {
  urgent: "bg-rose-100 text-rose-900",
  priority: "bg-amber-100 text-amber-900",
  advisory: "bg-blue-100 text-blue-900",
};

function RecallRow({
  recall,
  onScanResult,
}: {
  recall: EquipmentRecall;
  onScanResult: (r: RecallScanResult) => void;
}) {
  const [scanError, setScanError] = useState<string | null>(null);
  const scan = useMutation({
    mutationFn: () => scanEquipmentRecall(recall.id),
    onSuccess: (r) => onScanResult(r),
    onError: (e: Error) => setScanError(e.message),
  });

  return (
    <li
      className="rounded border p-4"
      style={{
        borderColor:
          recall.status === "closed"
            ? "hsl(var(--line-2))"
            : "hsl(var(--line-1))",
        opacity: recall.status === "closed" ? 0.6 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${SEVERITY_COLOR[recall.severity]}`}
            >
              {recall.severity}
            </span>
            <span className="font-medium">{recall.title}</span>
            <span className="text-xs text-muted-foreground">
              · ref {recall.recallReference}
            </span>
            {recall.status === "closed" && (
              <span className="text-xs text-muted-foreground">
                · closed
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {recall.manufacturer}
            {recall.modelMatch && ` · model: ${recall.modelMatch}`}
            {recall.issuedAt && ` · issued ${recall.issuedAt}`}
            {recall.deadlineAt && ` · deadline ${recall.deadlineAt}`}
          </div>
          {recall.serialMatch && (
            <div className="text-xs text-muted-foreground">
              {recall.serialMatch.kind === "range"
                ? `Serial range: ${recall.serialMatch.from} … ${recall.serialMatch.to}`
                : `Serial list: ${recall.serialMatch.serials.length} entries`}
            </div>
          )}
          {recall.description && (
            <p className="text-sm mt-1">{recall.description}</p>
          )}
          {recall.referenceUrl && (
            <a
              href={recall.referenceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-semibold text-[hsl(var(--penn-navy))] hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Notice
            </a>
          )}
          {scanError && (
            <p className="text-xs text-rose-700 mt-1">{scanError}</p>
          )}
        </div>
        <Button
          intent="secondary"
          disabled={recall.status === "closed" || scan.isPending}
          isLoading={scan.isPending}
          onClick={() => scan.mutate()}
        >
          <Search className="h-3 w-3 mr-1" />
          Scan
        </Button>
      </div>
    </li>
  );
}

function ScanResultModal({
  result,
  onClose,
}: {
  result: RecallScanResult;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-3xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <h2
            className="text-lg font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Recall scan result
          </h2>
          <p className="text-sm text-muted-foreground">
            Scanned {result.candidatesScanned} candidate devices ·{" "}
            <strong>{result.affectedCount} affected</strong>.
          </p>

          {result.affectedCount === 0 ? (
            <div className="rounded border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              No dispensed devices match this recall&apos;s criteria.
              Nothing to action.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left border-b"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <th className="py-2 font-semibold">Patient</th>
                  <th className="py-2 font-semibold">Serial</th>
                  <th className="py-2 font-semibold">Model</th>
                  <th className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {result.affected.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b"
                    style={{ borderColor: "hsl(var(--line-2))" }}
                  >
                    <td className="py-2">
                      <Link
                        href={`/admin/patients/${a.patientId}`}
                        className="text-[hsl(var(--penn-navy))] hover:underline"
                      >
                        View patient →
                      </Link>
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {a.serialNumber}
                    </td>
                    <td className="py-2">{a.model}</td>
                    <td className="py-2 text-xs">{a.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex justify-end pt-3 border-t border-border/40">
            <Button intent="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddRecallModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const qc = useQueryClient();
  const [recallReference, setRecallReference] = useState("");
  const [title, setTitle] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [modelMatch, setModelMatch] = useState("");
  const [severity, setSeverity] = useState<RecallSeverity>("priority");
  const [issuedAt, setIssuedAt] = useState("");
  const [deadlineAt, setDeadlineAt] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [description, setDescription] = useState("");
  const [serialKind, setSerialKind] = useState<"none" | "range" | "list">(
    "none",
  );
  const [serialFrom, setSerialFrom] = useState("");
  const [serialTo, setSerialTo] = useState("");
  const [serialList, setSerialList] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      let serialMatch: RecallSerialMatch = null;
      if (serialKind === "range" && serialFrom.trim() && serialTo.trim()) {
        serialMatch = {
          kind: "range",
          from: serialFrom.trim(),
          to: serialTo.trim(),
        };
      } else if (serialKind === "list" && serialList.trim()) {
        const serials = serialList
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (serials.length === 0) {
          throw new Error("Serial list is empty.");
        }
        serialMatch = { kind: "list", serials };
      }
      const body: CreateRecallRequest = {
        recallReference: recallReference.trim(),
        title: title.trim(),
        manufacturer: manufacturer.trim(),
        modelMatch: modelMatch.trim() || null,
        serialMatch,
        severity,
        issuedAt: issuedAt || null,
        deadlineAt: deadlineAt || null,
        referenceUrl: referenceUrl.trim() || null,
        description: description.trim() || null,
      };
      return createEquipmentRecall(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      onCreated();
    },
    onError: (e: Error) => setError(e.message),
  });

  const canSave =
    recallReference.trim() && title.trim() && manufacturer.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !create.isPending && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <h2
            className="text-lg font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Record manufacturer recall
          </h2>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Recall reference"
              value={recallReference}
              onChange={setRecallReference}
              placeholder="Z-1234-2021"
              required
            />
            <Field
              label="Severity"
              value={severity}
              onChange={(v) => setSeverity(v as RecallSeverity)}
              select={["urgent", "priority", "advisory"]}
            />
            <div className="col-span-2">
              <Field
                label="Title"
                value={title}
                onChange={setTitle}
                placeholder="Foam degradation — DreamStation"
                required
              />
            </div>
            <Field
              label="Manufacturer"
              value={manufacturer}
              onChange={setManufacturer}
              placeholder="Philips"
              required
            />
            <Field
              label="Model match (optional)"
              value={modelMatch}
              onChange={setModelMatch}
              placeholder="DreamStation"
            />
            <Field
              label="Issued"
              type="date"
              value={issuedAt}
              onChange={setIssuedAt}
            />
            <Field
              label="Deadline"
              type="date"
              value={deadlineAt}
              onChange={setDeadlineAt}
            />
            <div className="col-span-2">
              <Field
                label="Reference URL"
                value={referenceUrl}
                onChange={setReferenceUrl}
                placeholder="https://www.fda.gov/medical-devices/..."
              />
            </div>
            <div className="col-span-2">
              <label
                className="text-xs font-semibold block mb-1"
                style={{ color: "hsl(var(--penn-navy))" }}
              >
                Serial criteria
              </label>
              <select
                value={serialKind}
                onChange={(e) =>
                  setSerialKind(e.target.value as "none" | "range" | "list")
                }
                className="w-full rounded border px-2 py-1.5 text-sm"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <option value="none">Every serial from this manufacturer</option>
                <option value="range">Lexicographic range</option>
                <option value="list">Explicit list</option>
              </select>
            </div>
            {serialKind === "range" && (
              <>
                <Field
                  label="From serial"
                  value={serialFrom}
                  onChange={setSerialFrom}
                />
                <Field
                  label="To serial"
                  value={serialTo}
                  onChange={setSerialTo}
                />
              </>
            )}
            {serialKind === "list" && (
              <div className="col-span-2">
                <label
                  className="text-xs font-semibold block mb-1"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  Serial list (comma or newline separated)
                </label>
                <textarea
                  className="w-full rounded border px-2 py-1.5 text-sm font-mono"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                  rows={4}
                  value={serialList}
                  onChange={(e) => setSerialList(e.target.value)}
                  placeholder="SN001, SN002, SN003"
                />
              </div>
            )}
            <div className="col-span-2">
              <label
                className="text-xs font-semibold block mb-1"
                style={{ color: "hsl(var(--penn-navy))" }}
              >
                Description
              </label>
              <textarea
                className="w-full rounded border px-2 py-1.5 text-sm"
                style={{ borderColor: "hsl(var(--line-1))" }}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
              />
            </div>
          </div>

          {error && (
            <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
            <Button intent="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!canSave || create.isPending}
              isLoading={create.isPending}
              onClick={() => create.mutate()}
            >
              Save recall
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  required,
  select,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  select?: readonly string[];
}) {
  return (
    <div>
      <label
        className="text-xs font-semibold block mb-1"
        style={{ color: "hsl(var(--penn-navy))" }}
      >
        {label}{required && " *"}
      </label>
      {select ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border px-2 py-1.5 text-sm"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {select.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <Input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}
