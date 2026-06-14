// /admin/asset-recovery — worklist for recovering CPAP machines from
// patients who discontinued therapy, so the device can be refurbished
// and redeployed. PennFit already detects likely discontinuation
// (low-usage smart triggers + lapsed-customer win-back); this is the
// human action queue that moves a device from "identified" through to
// "received" / "redeployed". Viewing needs cases.read; create/advance
// need cases.manage (enforced server-side).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageX } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  listAssetRecoveryCases,
  createAssetRecoveryCase,
  updateAssetRecoveryCase,
  ASSET_RECOVERY_STATUS_OPTIONS,
  ASSET_RECOVERY_REASON_OPTIONS,
  type AssetRecoveryCase,
  type AssetRecoveryStatus,
  type AssetRecoveryReason,
} from "@/lib/admin/asset-recovery-api";

const QUERY_KEY = ["admin", "asset-recovery"] as const;

const STATUS_LABEL = new Map(
  ASSET_RECOVERY_STATUS_OPTIONS.map((o) => [o.value, o.label]),
);
const REASON_LABEL = new Map(
  ASSET_RECOVERY_REASON_OPTIONS.map((o) => [o.value, o.label]),
);

// Terminal statuses render muted; in-flight ones render as active work.
const CLOSED_STATUSES = new Set<AssetRecoveryStatus>([
  "redeployed",
  "closed_unrecovered",
]);

export function AdminAssetRecoveryPage() {
  const [filter, setFilter] = useState<AssetRecoveryStatus | "">("");
  const query = useQuery({
    queryKey: [...QUERY_KEY, filter] as const,
    queryFn: () => listAssetRecoveryCases(filter || undefined),
    staleTime: 30_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-asset-recovery-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <PackageX className="h-6 w-6" />
            Asset recovery
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Recover CPAP machines from patients who stopped therapy so they can
            be refurbished and redeployed. Open a case when a low-usage or
            lapsed-customer signal flags a likely discontinuation, then work it
            through to <em>received</em> / <em>redeployed</em>.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <span style={{ color: "hsl(var(--ink-3))" }}>Status</span>
          <select
            value={filter}
            onChange={(e) =>
              setFilter(e.target.value as AssetRecoveryStatus | "")
            }
            className="rounded border px-2 py-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid="asset-recovery-status-filter"
          >
            <option value="">All statuses</option>
            {ASSET_RECOVERY_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {query.data && <SummaryTiles counts={query.data.counts} />}

      <CreateCaseForm />

      {query.isPending ? (
        <Spinner label="Loading cases…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.cases.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No recovery cases{filter ? ` with status “${STATUS_LABEL.get(filter)}”` : ""}.
            Open one above when a device needs to come back.
          </p>
        </Card>
      ) : (
        <Card title={`Cases (${query.data.cases.length})`}>
          <div className="space-y-2">
            {query.data.cases.map((c) => (
              <CaseRow key={c.id} item={c} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function SummaryTiles({ counts }: { counts: Record<string, number> }) {
  const open = ASSET_RECOVERY_STATUS_OPTIONS.filter(
    (o) => !CLOSED_STATUSES.has(o.value),
  ).reduce((sum, o) => sum + (counts[o.value] ?? 0), 0);
  const received = counts["received"] ?? 0;
  const redeployed = counts["redeployed"] ?? 0;

  const tiles = [
    { label: "Open", value: open },
    { label: "Received", value: received },
    { label: "Redeployed", value: redeployed },
  ];
  return (
    <div className="grid grid-cols-3 gap-3 max-w-md">
      {tiles.map((t) => (
        <Card key={t.label}>
          <div className="text-2xl font-semibold tabular-nums">{t.value}</div>
          <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            {t.label}
          </div>
        </Card>
      ))}
    </div>
  );
}

function CreateCaseForm() {
  const qc = useQueryClient();
  const [patientLabel, setPatientLabel] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [reason, setReason] = useState<AssetRecoveryReason>("discontinued");
  const create = useMutation({
    mutationFn: () =>
      createAssetRecoveryCase({
        patientLabel: patientLabel.trim() || undefined,
        deviceLabel: deviceLabel.trim() || undefined,
        reason,
      }),
    onSuccess: () => {
      setPatientLabel("");
      setDeviceLabel("");
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const canSubmit = patientLabel.trim().length > 0;

  return (
    <Card title="Open a recovery case">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs flex-1 min-w-[180px]">
          <span style={{ color: "hsl(var(--ink-3))" }}>Patient</span>
          <input
            value={patientLabel}
            onChange={(e) => setPatientLabel(e.target.value)}
            placeholder="Name or identifier"
            className="rounded border px-2 py-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid="asset-recovery-patient-input"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs flex-1 min-w-[180px]">
          <span style={{ color: "hsl(var(--ink-3))" }}>Device</span>
          <input
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            placeholder="e.g. ResMed AirSense 11"
            className="rounded border px-2 py-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span style={{ color: "hsl(var(--ink-3))" }}>Reason</span>
          <select
            value={reason}
            onChange={(e) =>
              setReason(e.target.value as AssetRecoveryReason)
            }
            className="rounded border px-2 py-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {ASSET_RECOVERY_REASON_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          disabled={!canSubmit}
          isLoading={create.isPending}
          onClick={() => create.mutate()}
        >
          Open case
        </Button>
      </div>
      {create.error instanceof Error && (
        <p className="text-xs mt-2" style={{ color: "#b91c1c" }} role="alert">
          Couldn&apos;t open the case — check the fields and that you have
          permission.
        </p>
      )}
    </Card>
  );
}

function CaseRow({ item }: { item: AssetRecoveryCase }) {
  const qc = useQueryClient();
  const [tracking, setTracking] = useState(item.trackingNumber ?? "");
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof updateAssetRecoveryCase>[1]) =>
      updateAssetRecoveryCase(item.id, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const closed = CLOSED_STATUSES.has(item.status);
  const trackingDirty = tracking.trim() !== (item.trackingNumber ?? "");

  return (
    <div
      className="rounded border p-3 flex flex-col gap-2"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="asset-recovery-row"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="flex items-center gap-2 min-w-0">
          <Badge variant={closed ? "muted" : "success"}>
            {STATUS_LABEL.get(item.status) ?? item.status}
          </Badge>
          <span
            className="font-medium truncate"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {item.patientLabel ?? item.patientId ?? "—"}
          </span>
          {item.deviceLabel && (
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {item.deviceLabel}
            </span>
          )}
          <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            · {REASON_LABEL.get(item.reason) ?? item.reason}
          </span>
        </span>
        <label className="flex items-center gap-2 text-xs">
          <span style={{ color: "hsl(var(--ink-3))" }}>Advance</span>
          <select
            value={item.status}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate({ status: e.target.value as AssetRecoveryStatus })
            }
            className="rounded border px-2 py-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid="asset-recovery-status-select"
          >
            {ASSET_RECOVERY_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <label className="flex flex-col gap-1 text-xs flex-1 min-w-[200px]">
          <span style={{ color: "hsl(var(--ink-3))" }}>Tracking number</span>
          <input
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="Carrier tracking #"
            className="rounded border px-2 py-1 font-mono"
            style={{ borderColor: "hsl(var(--line-1))" }}
          />
        </label>
        <Button
          size="sm"
          intent="secondary"
          disabled={!trackingDirty}
          isLoading={update.isPending}
          onClick={() => update.mutate({ trackingNumber: tracking.trim() })}
        >
          Save tracking
        </Button>
      </div>
    </div>
  );
}
