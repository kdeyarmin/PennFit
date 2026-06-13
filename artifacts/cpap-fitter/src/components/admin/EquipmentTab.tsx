// Patient-detail "Equipment" tab — the clinical asset registry.
//
// Read-mostly surface: list every device dispensed to this patient,
// add a new one, and transition status (active/returned/recalled/
// retired) via inline buttons. Identity fields (manufacturer,
// model, serial) are immutable post-create per the route's policy;
// if a CSR mistyped, they retire the row and add a new one.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus } from "lucide-react";

import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { todayAppDateIso } from "@/lib/utils";
import {
  createPatientEquipment,
  listPatientEquipment,
  patchPatientEquipment,
  type CreateEquipmentAssetRequest,
  type DeviceClass,
  type EquipmentAsset,
  type EquipmentStatus,
} from "@/lib/admin/equipment-api";

const DEVICE_CLASS_LABELS: Record<DeviceClass, string> = {
  cpap: "CPAP",
  auto_cpap: "Auto CPAP",
  bipap: "BiPAP",
  asv: "ASV",
  avaps: "AVAPS",
  humidifier: "Humidifier",
  oximeter: "Oximeter",
  other: "Other",
};

const STATUS_COLOR: Record<EquipmentStatus, string> = {
  active: "bg-emerald-100 text-emerald-900",
  returned: "bg-gray-100 text-gray-900",
  recalled: "bg-rose-100 text-rose-900",
  retired: "bg-amber-100 text-amber-900",
};

export function EquipmentTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const queryKey = ["admin", "patient", patientId, "equipment"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listPatientEquipment(patientId),
  });
  const [showAdd, setShowAdd] = useState(false);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: ({
      assetId,
      status,
    }: {
      assetId: string;
      status: EquipmentStatus;
    }) => patchPatientEquipment(patientId, assetId, { status }),
    onMutate: ({ assetId }) => {
      setBusyAssetId(assetId);
      setActionError(null);
    },
    onSettled: () => {
      setBusyAssetId(null);
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => setActionError(e.message),
  });

  if (isPending) return <Spinner />;
  if (isError)
    return <ErrorPanel error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          CPAP/BiPAP devices dispensed to this patient. Serial number binds each
          row to the manufacturer-recall scan. Clinical fields are immutable
          after save — if a serial was mistyped, retire the row and add a new
          one.
        </p>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add device
        </Button>
      </div>
      {actionError && (
        <p className="text-xs text-rose-700" role="alert">
          {actionError}
        </p>
      )}
      {data.equipment.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No devices on file.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.equipment.map((asset) => (
            <li
              key={asset.id}
              className="rounded border p-3"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div>
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider mr-2 ${STATUS_COLOR[asset.status]}`}
                    >
                      {asset.status}
                    </span>
                    <span className="font-medium">
                      {asset.manufacturer} {asset.model}
                    </span>
                    {asset.recallId && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-rose-700"
                        title="Manufacturer recall in effect"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        Recalled
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {DEVICE_CLASS_LABELS[asset.deviceClass]} · Serial{" "}
                    <span className="font-mono">{asset.serialNumber}</span>
                    {asset.dispensedAt && ` · Dispensed ${asset.dispensedAt}`}
                  </div>
                  {(asset.pressureSetting || asset.humidifierSetting) && (
                    <div className="text-xs text-muted-foreground">
                      {asset.pressureSetting &&
                        `Pressure: ${asset.pressureSetting}`}
                      {asset.pressureSetting &&
                        asset.humidifierSetting &&
                        " · "}
                      {asset.humidifierSetting &&
                        `Humidifier: ${asset.humidifierSetting}`}
                    </div>
                  )}
                  {asset.dispensingNote && (
                    <div className="text-xs italic text-muted-foreground">
                      {asset.dispensingNote}
                    </div>
                  )}
                </div>
                <StatusTransitionMenu
                  asset={asset}
                  busy={busyAssetId === asset.id}
                  onTransition={(to) =>
                    patch.mutate({ assetId: asset.id, status: to })
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {showAdd && (
        <AddEquipmentModal
          patientId={patientId}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </div>
  );
}

// Valid transitions mirror the server's VALID_TRANSITIONS map.
const TRANSITIONS: Record<EquipmentStatus, EquipmentStatus[]> = {
  active: ["returned", "recalled", "retired"],
  returned: ["active", "retired"],
  recalled: ["returned", "active"],
  retired: ["active"],
};

function StatusTransitionMenu({
  asset,
  busy,
  onTransition,
}: {
  asset: EquipmentAsset;
  busy: boolean;
  onTransition: (to: EquipmentStatus) => void;
}) {
  const options = TRANSITIONS[asset.status];
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {options.map((to) => (
        <Button
          key={to}
          intent="ghost"
          size="sm"
          disabled={busy}
          isLoading={busy}
          onClick={() => onTransition(to)}
        >
          Mark {to}
        </Button>
      ))}
    </div>
  );
}

function AddEquipmentModal({
  patientId,
  onClose,
  onCreated,
}: {
  patientId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [deviceClass, setDeviceClass] = useState<DeviceClass>("auto_cpap");
  const [manufacturer, setManufacturer] = useState("");
  const [model, setModel] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [pressureSetting, setPressureSetting] = useState("");
  const [humidifierSetting, setHumidifierSetting] = useState("");
  const [dispensedAt, setDispensedAt] = useState(todayAppDateIso());
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateEquipmentAssetRequest = {
        deviceClass,
        manufacturer: manufacturer.trim(),
        model: model.trim(),
        serialNumber: serialNumber.trim(),
        pressureSetting: pressureSetting.trim() || null,
        humidifierSetting: humidifierSetting.trim() || null,
        dispensedAt: dispensedAt || null,
      };
      return createPatientEquipment(patientId, body);
    },
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  });

  const canSave = manufacturer.trim() && model.trim() && serialNumber.trim();

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
            Record dispensed device
          </h2>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Serial-number identity is immutable after save. Verify the
            manufacturer&apos;s sticker before submitting.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Device class</Label>
              <select
                value={deviceClass}
                onChange={(e) => setDeviceClass(e.target.value as DeviceClass)}
                aria-label="Device class"
                className="w-full rounded border px-2 py-1.5 text-sm"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                {(Object.keys(DEVICE_CLASS_LABELS) as DeviceClass[]).map(
                  (c) => (
                    <option key={c} value={c}>
                      {DEVICE_CLASS_LABELS[c]}
                    </option>
                  ),
                )}
              </select>
            </div>
            <LabeledInput
              label="Manufacturer"
              value={manufacturer}
              onChange={setManufacturer}
              placeholder="ResMed, Philips, Fisher & Paykel…"
              required
            />
            <LabeledInput
              label="Model"
              value={model}
              onChange={setModel}
              placeholder="AirSense 11, DreamStation, Sleepstyle…"
              required
            />
            <LabeledInput
              label="Serial number"
              value={serialNumber}
              onChange={setSerialNumber}
              placeholder="From the manufacturer sticker"
              required
            />
            <LabeledInput
              label="Pressure"
              value={pressureSetting}
              onChange={setPressureSetting}
              placeholder="8-12 cm H2O"
            />
            <LabeledInput
              label="Humidifier setting"
              value={humidifierSetting}
              onChange={setHumidifierSetting}
              placeholder="3, auto, off…"
            />
            <LabeledInput
              label="Dispensed on"
              type="date"
              value={dispensedAt}
              onChange={setDispensedAt}
            />
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
              Save device
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      className="text-xs font-semibold block mb-1"
      style={{ color: "hsl(var(--penn-navy))" }}
    >
      {children}
    </label>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <Label>
        {label}
        {required && " *"}
      </Label>
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
