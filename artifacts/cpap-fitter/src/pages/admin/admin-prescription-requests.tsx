// /admin/patients/:patientId/prescription-requests
//
// CSR workflow for creating + dispatching pre-populated Rx packets
// that the physician signs and returns. Mirror of the inbound-
// referrals admin page shape:
//   - Header + "Create new" button
//   - List of existing packets for this patient
//   - Create modal (equipment lines + settings + dx codes)
//   - Detail/dispatch modal with lifecycle actions
//
// Page-level URL param: patientId. The page is patient-scoped
// because the backend list endpoint is per-patient (a global CSR
// work-list lands as a follow-up).

import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import {
  createPrescriptionRequest,
  getPrescriptionRequest,
  listPatientPrescriptionRequests,
  markPrescriptionSigned,
  prescriptionRequestPdfUrl,
  sendPrescriptionFax,
  voidPrescriptionRequest,
  type CreatePrescriptionRequestRequest,
  type PrescriptionDeviceClass,
  type PrescriptionRequestDetail,
  type PrescriptionRequestHcpcsLine,
  type PrescriptionRequestListItem,
  type PrescriptionRequestSettings,
  type PrescriptionRequestStatus,
} from "@/lib/admin/prescription-requests-api";

const listKey = (patientId: string) =>
  ["admin", "prescription-requests", "patient", patientId] as const;
const detailKey = (id: string) =>
  ["admin", "prescription-requests", "detail", id] as const;

export function AdminPrescriptionRequestsPage() {
  const params = useParams<{ patientId: string }>();
  const patientId = params.patientId ?? "";
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deep-link entry: PrescriptionsTab's "Renew via fax packet"
  // button creates a draft server-side and redirects here with
  // ?packet=<id>. Open the detail modal automatically on first
  // mount; strip the query string so a refresh doesn't re-open
  // the same modal.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const packetId = url.searchParams.get("packet");
    if (packetId && /^[0-9a-f-]{36}$/i.test(packetId)) {
      setSelectedId(packetId);
      url.searchParams.delete("packet");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: listKey(patientId),
    queryFn: () => listPatientPrescriptionRequests(patientId),
    enabled: patientId.length > 0,
  });

  if (!patientId) {
    return (
      <div className="p-6">
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Missing patientId in URL.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FileText className="h-6 w-6" />
            Prescription requests
          </h1>
          <p
            className="text-sm mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Pre-populated, faxable prescriptions the physician can sign as-is
            and fax back. Patient ID:{" "}
            <span className="font-mono">{patientId}</span>
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-3 w-3 mr-1" /> Create new
        </Button>
      </header>

      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.packets.length === 0 ? (
          <p
            className="text-sm py-3"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            No prescription requests yet for this patient. Click &quot;Create
            new&quot; to draft one.
          </p>
        ) : (
          <PacketTable rows={data.packets} onSelect={setSelectedId} />
        )}
      </Card>

      {createOpen && (
        <CreateModal
          patientId={patientId}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {selectedId && (
        <DetailModal
          packetId={selectedId}
          patientId={patientId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// List table
// ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<PrescriptionRequestStatus, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent_fax: "bg-blue-100 text-blue-900",
  delivered: "bg-amber-100 text-amber-900",
  signed: "bg-emerald-100 text-emerald-900",
  expired: "bg-rose-100 text-rose-900",
  void: "bg-gray-100 text-gray-700",
  failed: "bg-rose-100 text-rose-900",
};

function PacketTable({
  rows,
  onSelect,
}: {
  rows: PrescriptionRequestListItem[];
  onSelect: (id: string) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Created</th>
          <th className="py-2 font-semibold">Status</th>
          <th className="py-2 font-semibold">Fax to</th>
          <th className="py-2 font-semibold">Sent</th>
          <th className="py-2 font-semibold">Signed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            className="border-b cursor-pointer hover:bg-[hsl(var(--bg-2))]"
            style={{ borderColor: "hsl(var(--line-2))" }}
            onClick={() => onSelect(r.id)}
          >
            <td className="py-2 text-xs">
              {new Date(r.createdAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </td>
            <td className="py-2">
              <span
                className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_COLOR[r.status]}`}
              >
                {r.status.replace("_", " ")}
              </span>
            </td>
            <td className="py-2 text-xs font-mono">
              {r.sentToFaxE164 ?? r.returnFaxE164 ?? "—"}
            </td>
            <td
              className="py-2 text-xs"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {r.sentAt
                ? new Date(r.sentAt).toLocaleDateString()
                : "—"}
            </td>
            <td
              className="py-2 text-xs"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {r.signedAt
                ? new Date(r.signedAt).toLocaleDateString()
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ────────────────────────────────────────────────────────────────────
// Create modal
// ────────────────────────────────────────────────────────────────────

const HCPCS_PRESETS: Array<{
  label: string;
  description: string;
  lines: PrescriptionRequestHcpcsLine[];
}> = [
  {
    label: "Standard CPAP starter",
    description: "Device + nasal mask + tubing + filters",
    lines: [
      { hcpcs: "E0601", description: "CPAP device", quantity: 1 },
      {
        hcpcs: "A7034",
        description: "Nasal mask interface",
        quantity: 1,
        cadenceDays: 90,
      },
      {
        hcpcs: "A7037",
        description: "Tubing",
        quantity: 1,
        cadenceDays: 90,
      },
      {
        hcpcs: "A7038",
        description: "Disposable filter",
        quantity: 2,
        cadenceDays: 30,
      },
    ],
  },
  {
    label: "Resupply (90-day)",
    description: "Mask cushion + filters",
    lines: [
      {
        hcpcs: "A7032",
        description: "Mask cushion",
        quantity: 1,
        cadenceDays: 90,
      },
      {
        hcpcs: "A7038",
        description: "Disposable filter",
        quantity: 2,
        cadenceDays: 30,
      },
    ],
  },
  {
    label: "BiPAP starter",
    description: "BiPAP device + mask + tubing",
    lines: [
      { hcpcs: "E0470", description: "BiPAP device", quantity: 1 },
      {
        hcpcs: "A7034",
        description: "Nasal mask interface",
        quantity: 1,
        cadenceDays: 90,
      },
      {
        hcpcs: "A7037",
        description: "Tubing",
        quantity: 1,
        cadenceDays: 90,
      },
    ],
  },
];

function CreateModal({
  patientId,
  onClose,
}: {
  patientId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [providerId, setProviderId] = useState("");
  const [lines, setLines] = useState<PrescriptionRequestHcpcsLine[]>([
    { hcpcs: "E0601", description: "CPAP device", quantity: 1 },
  ]);
  const [icd10, setIcd10] = useState("G47.33");
  const [deviceClass, setDeviceClass] = useState<PrescriptionDeviceClass | "none">("auto_cpap");
  const [pressureMin, setPressureMin] = useState("6");
  const [pressureMax, setPressureMax] = useState("16");
  const [pressureFixed, setPressureFixed] = useState("8");
  const [ipap, setIpap] = useState("14");
  const [epap, setEpap] = useState("8");
  const [rampMinutes, setRampMinutes] = useState("30");
  const [humidifier, setHumidifier] = useState("3");
  const [heatedTube, setHeatedTube] = useState(true);
  const [backupRate, setBackupRate] = useState("10");
  const [lon, setLon] = useState("99");
  const [returnFax, setReturnFax] = useState("");
  const [clinicalNotes, setClinicalNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: CreatePrescriptionRequestRequest) =>
      createPrescriptionRequest(patientId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: listKey(patientId) });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function applyPreset(presetLabel: string) {
    const preset = HCPCS_PRESETS.find((p) => p.label === presetLabel);
    if (preset) setLines(preset.lines.map((l) => ({ ...l })));
  }

  function addLine() {
    setLines((rows) => [
      ...rows,
      { hcpcs: "", description: "", quantity: 1, cadenceDays: 90 },
    ]);
  }

  function updateLine(idx: number, patch: Partial<PrescriptionRequestHcpcsLine>) {
    setLines((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  }

  function removeLine(idx: number) {
    setLines((rows) => rows.filter((_, i) => i !== idx));
  }

  function buildSettings(): PrescriptionRequestSettings | null {
    if (deviceClass === "none") return null;
    const settings: PrescriptionRequestSettings = { deviceClass };
    const toNum = (s: string): number | null => {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    if (deviceClass === "cpap") {
      settings.pressureCmh2o = toNum(pressureFixed);
    } else if (deviceClass === "auto_cpap" || deviceClass === "bipap") {
      settings.pressureMinCmh2o = toNum(pressureMin);
      settings.pressureMaxCmh2o = toNum(pressureMax);
    }
    if (deviceClass === "bipap" || deviceClass === "bipap_st") {
      settings.ipapCmh2o = toNum(ipap);
      settings.epapCmh2o = toNum(epap);
    }
    if (deviceClass === "bipap_st" || deviceClass === "asv") {
      settings.backupRateBpm = toNum(backupRate);
    }
    settings.rampMinutes = toNum(rampMinutes);
    settings.humidifierSetting = toNum(humidifier);
    settings.heatedTube = heatedTube;
    return settings;
  }

  function submit() {
    setError(null);
    const icd10Codes = icd10
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]\d{2}(\.\d{1,4})?$/.test(s));
    if (icd10Codes.length === 0) {
      setError("At least one valid ICD-10 code is required.");
      return;
    }
    if (lines.length === 0) {
      setError("At least one equipment line is required.");
      return;
    }
    const cleanedLines = lines
      .map((l) => ({
        hcpcs: l.hcpcs.trim().toUpperCase(),
        description: l.description.trim(),
        quantity: l.quantity,
        cadenceDays:
          typeof l.cadenceDays === "number" && l.cadenceDays > 0
            ? l.cadenceDays
            : null,
        modifiers: l.modifiers,
      }))
      .filter(
        (l) =>
          /^[A-Z]\d{4}$/.test(l.hcpcs) &&
          l.description.length > 0 &&
          l.quantity > 0,
      );
    if (cleanedLines.length === 0) {
      setError("All equipment lines need valid HCPCS, description, qty.");
      return;
    }
    if (!/^[0-9a-f-]{36}$/i.test(providerId.trim())) {
      setError("Provider ID must be a UUID.");
      return;
    }
    if (returnFax.trim() && !/^\+[1-9]\d{6,14}$/.test(returnFax.trim())) {
      setError("Return fax must be E.164 (e.g. +14125550100).");
      return;
    }
    const lonNum = Number(lon);
    if (!Number.isFinite(lonNum) || lonNum < 1 || lonNum > 99) {
      setError("Length of need must be 1–99 months.");
      return;
    }
    create.mutate({
      providerId: providerId.trim(),
      hcpcsLines: cleanedLines,
      icd10Codes,
      settings: buildSettings(),
      lengthOfNeedMonths: lonNum,
      returnFaxE164: returnFax.trim() || null,
      clinicalNotes: clinicalNotes.trim() || null,
    });
  }

  return (
    <ModalShell title="Create prescription request" onClose={onClose}>
      <div className="space-y-4">
        <Field
          label="Provider ID (UUID)"
          value={providerId}
          onChange={setProviderId}
          placeholder="copy from /admin/providers"
        />

        <div className="space-y-2">
          <label className="text-xs font-semibold block" style={{ color: "hsl(var(--penn-navy))" }}>
            Preset
          </label>
          <div className="flex flex-wrap gap-2">
            {HCPCS_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p.label)}
                className="rounded-full px-3 py-1 text-xs"
                style={{ backgroundColor: "hsl(var(--line-2))", color: "hsl(var(--ink-2))" }}
                title={p.description}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold block" style={{ color: "hsl(var(--penn-navy))" }}>
            Equipment lines
          </label>
          {lines.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <Input
                className="col-span-2"
                value={l.hcpcs}
                onChange={(e) => updateLine(idx, { hcpcs: e.target.value })}
                placeholder="E0601"
                aria-label="HCPCS code"
              />
              <Input
                className="col-span-6"
                value={l.description}
                onChange={(e) => updateLine(idx, { description: e.target.value })}
                placeholder="Description"
                aria-label="Line description"
              />
              <Input
                className="col-span-1"
                type="number"
                min={1}
                max={50}
                value={String(l.quantity)}
                onChange={(e) =>
                  updateLine(idx, { quantity: Number(e.target.value) || 1 })
                }
                aria-label="Quantity"
              />
              <Input
                className="col-span-2"
                type="number"
                min={0}
                value={l.cadenceDays ? String(l.cadenceDays) : ""}
                onChange={(e) =>
                  updateLine(idx, {
                    cadenceDays: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
                placeholder="days"
                aria-label="Cadence days"
              />
              <button
                type="button"
                className="col-span-1 text-rose-700"
                onClick={() => removeLine(idx)}
                aria-label="Remove line"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addLine}
            className="text-xs text-[hsl(var(--penn-navy))] hover:underline"
          >
            + Add line
          </button>
        </div>

        <Field
          label="Diagnoses (ICD-10, comma-separated)"
          value={icd10}
          onChange={setIcd10}
          placeholder="G47.33"
        />

        <div className="space-y-2">
          <label className="text-xs font-semibold block" style={{ color: "hsl(var(--penn-navy))" }}>
            Therapy mode + settings
          </label>
          <select
            className="rounded border px-2 py-1 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
            value={deviceClass}
            onChange={(e) =>
              setDeviceClass(e.target.value as PrescriptionDeviceClass | "none")
            }
            aria-label="Therapy mode"
          >
            <option value="none">No settings (mask-only refill)</option>
            <option value="cpap">CPAP (fixed pressure)</option>
            <option value="auto_cpap">Auto-CPAP</option>
            <option value="bipap">BiPAP</option>
            <option value="bipap_st">BiPAP ST</option>
            <option value="asv">ASV</option>
          </select>
          {deviceClass === "cpap" && (
            <Field
              label="Pressure (cm H₂O)"
              value={pressureFixed}
              onChange={setPressureFixed}
              type="number"
            />
          )}
          {(deviceClass === "auto_cpap" || deviceClass === "bipap") && (
            <div className="grid grid-cols-2 gap-2">
              <Field
                label="Pressure min"
                value={pressureMin}
                onChange={setPressureMin}
                type="number"
              />
              <Field
                label="Pressure max"
                value={pressureMax}
                onChange={setPressureMax}
                type="number"
              />
            </div>
          )}
          {(deviceClass === "bipap" || deviceClass === "bipap_st") && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="IPAP" value={ipap} onChange={setIpap} type="number" />
              <Field label="EPAP" value={epap} onChange={setEpap} type="number" />
            </div>
          )}
          {(deviceClass === "bipap_st" || deviceClass === "asv") && (
            <Field
              label="Backup rate (BPM)"
              value={backupRate}
              onChange={setBackupRate}
              type="number"
            />
          )}
          {deviceClass !== "none" && (
            <div className="grid grid-cols-3 gap-2">
              <Field
                label="Ramp (min)"
                value={rampMinutes}
                onChange={setRampMinutes}
                type="number"
              />
              <Field
                label="Humidifier"
                value={humidifier}
                onChange={setHumidifier}
                type="number"
              />
              <label className="flex items-center gap-2 text-xs mt-5">
                <input
                  type="checkbox"
                  checked={heatedTube}
                  onChange={(e) => setHeatedTube(e.target.checked)}
                />
                Heated tube
              </label>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Length of need (months, 99 = lifetime)"
            value={lon}
            onChange={setLon}
            type="number"
          />
          <Field
            label="Return fax (override; E.164)"
            value={returnFax}
            onChange={setReturnFax}
            placeholder="defaults to provider.fax_e164"
          />
        </div>

        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: "hsl(var(--penn-navy))" }}>
            Clinical notes (optional)
          </label>
          <textarea
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
            rows={3}
            maxLength={2000}
            value={clinicalNotes}
            onChange={(e) => setClinicalNotes(e.target.value)}
            aria-label="Clinical notes"
          />
        </div>

        {error && (
          <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border/40">
          <Button intent="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : null}
            Create draft
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

// ────────────────────────────────────────────────────────────────────
// Detail / dispatch modal
// ────────────────────────────────────────────────────────────────────

function DetailModal({
  packetId,
  patientId,
  onClose,
}: {
  packetId: string;
  patientId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: detailKey(packetId),
    queryFn: () => getPrescriptionRequest(packetId),
  });
  const [signedKey, setSignedKey] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  function invalidate() {
    void qc.invalidateQueries({ queryKey: detailKey(packetId) });
    void qc.invalidateQueries({ queryKey: listKey(patientId) });
  }

  const send = useMutation({
    mutationFn: () => sendPrescriptionFax(packetId),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (e: Error) => setActionError(e.message),
  });
  const sign = useMutation({
    mutationFn: () =>
      markPrescriptionSigned(packetId, signedKey.trim() || undefined),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (e: Error) => setActionError(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => voidPrescriptionRequest(packetId),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (e: Error) => setActionError(e.message),
  });

  return (
    <ModalShell title="Prescription request detail" onClose={onClose}>
      {detail.isPending ? (
        <Spinner />
      ) : detail.isError ? (
        <ErrorPanel error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <div className="space-y-4">
          <Header packet={detail.data} />
          <div className="grid grid-cols-2 gap-4">
            <PdfPreviewPane packetId={packetId} />
            <SummaryPane packet={detail.data} />
          </div>
          <LifecycleActions
            packet={detail.data}
            actionError={actionError}
            send={send}
            sign={sign}
            cancel={cancel}
            signedKey={signedKey}
            onSignedKeyChange={setSignedKey}
          />
        </div>
      )}
    </ModalShell>
  );
}

function Header({ packet }: { packet: PrescriptionRequestDetail }) {
  return (
    <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: "hsl(var(--line-1))" }}>
      <div>
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Packet ID: <span className="font-mono">{packet.id.slice(0, 8)}…</span>
        </p>
        <p className="text-xs">
          <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_COLOR[packet.status]}`}
          >
            {packet.status.replace("_", " ")}
          </span>
        </p>
      </div>
      <a
        href={prescriptionRequestPdfUrl(packet.id)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-semibold text-[hsl(var(--penn-navy))] hover:underline"
      >
        <ExternalLink className="h-3 w-3" />
        Open PDF in new tab
      </a>
    </div>
  );
}

function PdfPreviewPane({ packetId }: { packetId: string }) {
  return (
    <div
      className="border rounded h-[60vh] overflow-hidden"
      style={{ borderColor: "hsl(var(--line-1))", backgroundColor: "hsl(var(--bg-2))" }}
    >
      <iframe
        src={prescriptionRequestPdfUrl(packetId)}
        title="Prescription request preview"
        className="w-full h-full"
        style={{ border: 0 }}
      />
    </div>
  );
}

function SummaryPane({ packet }: { packet: PrescriptionRequestDetail }) {
  return (
    <div className="space-y-2 text-sm overflow-y-auto" style={{ maxHeight: "60vh" }}>
      <KV label="Created" value={new Date(packet.createdAt).toLocaleString()} />
      <KV label="Status" value={packet.status} />
      <KV
        label="Return fax"
        value={packet.sentToFaxE164 ?? packet.returnFaxE164 ?? "—"}
      />
      <KV label="Sent" value={packet.sentAt ? new Date(packet.sentAt).toLocaleString() : "—"} />
      <KV
        label="Delivered"
        value={packet.deliveredAt ? new Date(packet.deliveredAt).toLocaleString() : "—"}
      />
      <KV
        label="Signed"
        value={packet.signedAt ? new Date(packet.signedAt).toLocaleString() : "—"}
      />
      <KV label="Length of need" value={`${packet.lengthOfNeedMonths} months`} />
      <KV label="ICD-10" value={packet.icd10Codes.join(", ")} />
      <div className="text-xs">
        <span className="font-semibold" style={{ color: "hsl(var(--penn-navy))" }}>
          Equipment lines:
        </span>
        <ul className="mt-1 space-y-0.5">
          {packet.hcpcsLines.map((l, i) => (
            <li key={i} className="font-mono">
              {l.hcpcs} × {l.quantity} · {l.description}
              {l.cadenceDays ? ` · every ${l.cadenceDays} d` : ""}
            </li>
          ))}
        </ul>
      </div>
      {packet.settings && (
        <div className="text-xs">
          <span className="font-semibold" style={{ color: "hsl(var(--penn-navy))" }}>
            Settings:
          </span>
          <pre className="mt-1 text-[10px] whitespace-pre-wrap font-mono">
            {JSON.stringify(packet.settings, null, 2)}
          </pre>
        </div>
      )}
      {packet.clinicalNotes && (
        <KV label="Notes" value={packet.clinicalNotes} />
      )}
      {packet.failureReason && (
        <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
          <strong>Failure:</strong> {packet.failureReason}
        </div>
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="font-semibold w-28" style={{ color: "hsl(var(--penn-navy))" }}>
        {label}
      </span>
      <span>{value}</span>
    </div>
  );
}

function LifecycleActions({
  packet,
  actionError,
  send,
  sign,
  cancel,
  signedKey,
  onSignedKeyChange,
}: {
  packet: PrescriptionRequestDetail;
  actionError: string | null;
  send: ReturnType<typeof useMutation<{ status: "sent_fax"; vendorRef: string }, Error, void>>;
  sign: ReturnType<typeof useMutation<{ status: "signed" }, Error, void>>;
  cancel: ReturnType<typeof useMutation<{ status: "void" }, Error, void>>;
  signedKey: string;
  onSignedKeyChange: (v: string) => void;
}) {
  const canSend = packet.status === "draft" || packet.status === "failed";
  const canSign =
    packet.status === "sent_fax" ||
    packet.status === "delivered" ||
    packet.status === "draft";
  const canVoid =
    packet.status !== "signed" && packet.status !== "void";

  return (
    <div className="space-y-3 border-t pt-3" style={{ borderColor: "hsl(var(--line-1))" }}>
      {actionError && (
        <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
          {actionError}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          disabled={!canSend || send.isPending}
          onClick={() => send.mutate()}
        >
          {send.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <Send className="h-3 w-3 mr-1" />
          )}
          Send via fax
        </Button>
        <div className="flex items-center gap-1">
          <Input
            className="text-xs"
            value={signedKey}
            onChange={(e) => onSignedKeyChange(e.target.value)}
            placeholder="signed scan object key (optional)"
            aria-label="Signed scan object key"
            style={{ minWidth: 220 }}
          />
          <Button
            intent="secondary"
            disabled={!canSign || sign.isPending}
            onClick={() => sign.mutate()}
          >
            {sign.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <CheckCircle2 className="h-3 w-3 mr-1" />
            )}
            Mark signed
          </Button>
        </div>
        <Button
          intent="ghost"
          disabled={!canVoid || cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {cancel.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <XCircle className="h-3 w-3 mr-1" />
          )}
          Void
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Small primitives
// ────────────────────────────────────────────────────────────────────

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
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
        className="w-full max-w-5xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: "hsl(var(--line-1))" }}>
            <h2 className="text-lg font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
              {title}
            </h2>
            <Button intent="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="text-xs font-semibold block mb-1" style={{ color: "hsl(var(--penn-navy))" }}>
        {label}
      </label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
    </div>
  );
}
