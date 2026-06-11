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
  ListChecks,
  Plus,
  Search,
  Send,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createEquipmentRecall,
  listEquipmentRecalls,
  listRecallNotifications,
  listRecallRemediation,
  logRecallRemediation,
  matchRecallAssets,
  scanEquipmentRecall,
  type CreateRecallRequest,
  type RemediationAction,
  type RecallNotification,
  type RemediationLogEntry,
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
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Manufacturer recall notices the supplier is tracking. Scan a recall
            to surface every dispensed serial that matches its criteria;
            transition affected devices to &ldquo;recalled&rdquo; from each
            patient&apos;s Equipment tab.
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
            No recalls on file. Add one when a manufacturer publishes a notice.
          </p>
        ) : (
          <ul className="space-y-3">
            {data.recalls.map((r) => (
              <RecallRow key={r.id} recall={r} onScanResult={setScanResult} />
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
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchSummary, setMatchSummary] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const scan = useMutation({
    mutationFn: () => scanEquipmentRecall(recall.id),
    onSuccess: (r) => onScanResult(r),
    onError: (e: Error) => setScanError(e.message),
  });
  const match = useMutation({
    mutationFn: () => matchRecallAssets(recall.id),
    onSuccess: (r) => {
      setMatchError(null);
      setMatchSummary(
        `Matched ${r.matchedCount} asset${r.matchedCount === 1 ? "" : "s"}; queued ${r.newlyQueuedCount} new notification${r.newlyQueuedCount === 1 ? "" : "s"} (${r.alreadyQueuedCount} already queued).`,
      );
    },
    onError: (e: Error) => setMatchError(e.message),
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
              <span className="text-xs text-muted-foreground">· closed</span>
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
          {matchError && (
            <p className="text-xs text-rose-700 mt-1">{matchError}</p>
          )}
          {matchSummary && (
            <p className="text-xs text-emerald-800 mt-1">{matchSummary}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Button
            intent="secondary"
            size="sm"
            disabled={recall.status === "closed" || scan.isPending}
            isLoading={scan.isPending}
            onClick={() => scan.mutate()}
          >
            <Search className="h-3 w-3 mr-1" />
            Scan
          </Button>
          <Button
            intent="secondary"
            size="sm"
            disabled={recall.status === "closed" || match.isPending}
            isLoading={match.isPending}
            onClick={() => match.mutate()}
            title="Run the matcher, flag affected assets, and queue notifications"
          >
            <Send className="h-3 w-3 mr-1" />
            Match &amp; notify
          </Button>
          <Button
            intent="ghost"
            size="sm"
            onClick={() => setShowRoster(true)}
            title="View notification status + remediation log for this recall"
          >
            <ListChecks className="h-3 w-3 mr-1" />
            Roster
          </Button>
        </div>
      </div>
      {showRoster && (
        <RecallRosterModal
          recallId={recall.id}
          recallTitle={recall.title}
          onClose={() => setShowRoster(false)}
        />
      )}
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
              No dispensed devices match this recall&apos;s criteria. Nothing to
              action.
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
                    <td className="py-2 font-mono text-xs">{a.serialNumber}</td>
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

  const canSave = recallReference.trim() && title.trim() && manufacturer.trim();

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
                aria-label="Serial criteria"
                className="w-full rounded border px-2 py-1.5 text-sm"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <option value="none">
                  Every serial from this manufacturer
                </option>
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
                  aria-label="Serial list"
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
                aria-label="Description"
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
        {label}
        {required && " *"}
      </label>
      {select ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
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
          aria-label={label}
        />
      )}
    </div>
  );
}

// ── Roster modal — notifications + remediation log + log-action form

const REMEDIATION_ACTIONS: Array<{ value: RemediationAction; label: string }> =
  [
    { value: "returned_to_manufacturer", label: "Returned to manufacturer" },
    { value: "destroyed", label: "Destroyed (requires evidence)" },
    { value: "replaced", label: "Replaced" },
    { value: "patient_declined", label: "Patient declined" },
    { value: "lost", label: "Lost / no longer owned" },
    { value: "unreachable", label: "Unreachable after attempts" },
  ];

const NOTIFICATION_TONE: Record<string, string> = {
  queued: "bg-amber-100 text-amber-900",
  sent: "bg-emerald-100 text-emerald-900",
  failed: "bg-rose-100 text-rose-900",
  bounced: "bg-rose-100 text-rose-900",
  skipped: "bg-slate-200 text-slate-700",
};

function RecallRosterModal({
  recallId,
  recallTitle,
  onClose,
}: {
  recallId: string;
  recallTitle: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const notifQuery = useQuery({
    queryKey: ["admin", "recalls", recallId, "notifications"] as const,
    queryFn: () => listRecallNotifications(recallId),
  });
  const remediationQuery = useQuery({
    queryKey: ["admin", "recalls", recallId, "remediation"] as const,
    queryFn: () => listRecallRemediation(recallId),
  });
  const invalidate = () => {
    void qc.invalidateQueries({
      queryKey: ["admin", "recalls", recallId, "remediation"],
    });
  };

  const remediationByAsset = new Map<string, RemediationLogEntry>();
  for (const entry of remediationQuery.data?.actions ?? []) {
    if (!remediationByAsset.has(entry.assetId)) {
      remediationByAsset.set(entry.assetId, entry);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-4xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">{recallTitle} — roster</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-muted-foreground hover:underline"
            >
              Close
            </button>
          </div>

          <div className="flex items-start justify-between gap-2">
            <RosterCountsBar
              notifications={notifQuery.data?.counts ?? {}}
              remediation={remediationQuery.data?.counts ?? {}}
            />
            <a
              href={`/resupply-api/admin/equipment-recalls/${recallId}/roster.csv`}
              className="rounded border px-2 py-1 text-xs font-semibold whitespace-nowrap"
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(var(--penn-navy))",
              }}
              title="Surveyor binder doc — notifications + remediation joined per asset"
            >
              Roster CSV
            </a>
          </div>

          {notifQuery.isPending ? (
            <Spinner />
          ) : notifQuery.isError ? (
            <ErrorPanel
              error={notifQuery.error}
              onRetry={() => void notifQuery.refetch()}
            />
          ) : (notifQuery.data?.notifications ?? []).length === 0 ? (
            <p className="text-sm py-2 text-muted-foreground">
              No notifications yet. Run &quot;Match &amp; notify&quot; to
              populate.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left border-b"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <th className="py-2 font-semibold">Asset</th>
                  <th className="py-2 font-semibold">Notification</th>
                  <th className="py-2 font-semibold">Channel</th>
                  <th className="py-2 font-semibold">Remediation</th>
                  <th className="py-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {(notifQuery.data?.notifications ?? []).map((n) => (
                  <RosterRow
                    key={n.id}
                    recallId={recallId}
                    notification={n}
                    existing={remediationByAsset.get(n.assetId) ?? null}
                    onLogged={invalidate}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function RosterCountsBar({
  notifications,
  remediation,
}: {
  notifications: Record<string, number>;
  remediation: Record<string, number>;
}) {
  const totalNotif = Object.values(notifications).reduce((a, b) => a + b, 0);
  const totalRem = Object.values(remediation).reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
      <div>
        <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
          Notifications ({totalNotif})
        </div>
        <div className="flex gap-2 mt-1 flex-wrap">
          {Object.entries(notifications).map(([k, v]) => (
            <span
              key={k}
              className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${
                NOTIFICATION_TONE[k] ?? "bg-slate-100 text-slate-700"
              }`}
            >
              {k}: {v}
            </span>
          ))}
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
          Remediation logged ({totalRem})
        </div>
        <div className="flex gap-2 mt-1 flex-wrap">
          {Object.entries(remediation).map(([k, v]) => (
            <span
              key={k}
              className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider bg-blue-100 text-blue-900"
            >
              {k.replace(/_/g, " ")}: {v}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function RosterRow({
  recallId,
  notification,
  existing,
  onLogged,
}: {
  recallId: string;
  notification: RecallNotification;
  existing: RemediationLogEntry | null;
  onLogged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <tr className="border-b" style={{ borderColor: "hsl(var(--line-2))" }}>
        <td className="py-1.5 font-mono text-xs">
          <a
            href={`/admin/patients/${notification.patientId}`}
            className="hover:underline"
            style={{ color: "hsl(var(--penn-navy))" }}
          >
            {notification.assetId.slice(0, 8)}
          </a>
        </td>
        <td className="py-1.5">
          <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${
              NOTIFICATION_TONE[notification.status] ??
              "bg-slate-100 text-slate-700"
            }`}
          >
            {notification.status}
          </span>
          {/* Carrier-side SMS outcome. 'sent' means Twilio ACCEPTED the
              text; the status callback can still report a bounce after
              the fact — without this badge a bounced safety-recall text
              looks identical to a delivered one. */}
          {notification.deliveryStatus === "undelivered" ||
          notification.deliveryStatus === "failed" ? (
            <span
              className="ml-1 inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider bg-rose-100 text-rose-900"
              title={
                notification.deliveryErrorCode
                  ? `Twilio error ${notification.deliveryErrorCode}`
                  : "Carrier reported the text undeliverable"
              }
            >
              sms bounced
            </span>
          ) : notification.deliveryStatus === "delivered" ? (
            <span className="ml-1 inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider bg-emerald-100 text-emerald-900">
              delivered
            </span>
          ) : null}
        </td>
        <td className="py-1.5 text-xs">{notification.channel ?? "—"}</td>
        <td className="py-1.5 text-xs">
          {existing ? (
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider bg-blue-100 text-blue-900"
              title={existing.notes ?? ""}
            >
              {existing.action.replace(/_/g, " ")}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-1.5 text-right">
          <Button
            intent="ghost"
            size="sm"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Cancel" : existing ? "Update" : "Log action"}
          </Button>
        </td>
      </tr>
      {editing && (
        <tr style={{ borderColor: "hsl(var(--line-2))" }}>
          <td colSpan={5} className="py-2 px-2 bg-slate-50">
            <LogActionForm
              recallId={recallId}
              assetId={notification.assetId}
              onSaved={() => {
                setEditing(false);
                onLogged();
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function LogActionForm({
  recallId,
  assetId,
  onSaved,
}: {
  recallId: string;
  assetId: string;
  onSaved: () => void;
}) {
  const [action, setAction] = useState<RemediationAction>(
    "returned_to_manufacturer",
  );
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [notes, setNotes] = useState("");
  const log = useMutation({
    mutationFn: () =>
      logRecallRemediation(recallId, {
        assetId,
        action,
        evidenceUrl: evidenceUrl.trim() || null,
        notes: notes.trim() || null,
      }),
    onSuccess: onSaved,
  });
  const needsEvidence = action === "destroyed";
  const valid = !needsEvidence || evidenceUrl.trim().length > 0;
  return (
    <div className="grid sm:grid-cols-2 gap-2">
      <div>
        <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
          Action
        </label>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as RemediationAction)}
          aria-label="Action"
          className="w-full rounded border px-2 py-1.5 text-sm"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {REMEDIATION_ACTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
          Evidence URL {needsEvidence ? "(required)" : "(optional)"}
        </label>
        <Input
          value={evidenceUrl}
          onChange={(e) => setEvidenceUrl(e.target.value)}
          placeholder="https://…/destruction-cert.pdf"
          aria-label="Evidence URL"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
          Notes
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, 2000))}
          rows={2}
          className="w-full rounded border px-2 py-1.5 text-sm"
          style={{ borderColor: "hsl(var(--line-1))" }}
          aria-label="Notes"
        />
      </div>
      {log.error instanceof Error && (
        <div className="sm:col-span-2 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
          {log.error.message}
        </div>
      )}
      <div className="sm:col-span-2">
        <Button
          disabled={!valid || log.isPending}
          isLoading={log.isPending}
          onClick={() => log.mutate()}
        >
          Save remediation
        </Button>
      </div>
    </div>
  );
}
