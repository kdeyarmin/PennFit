// /admin/integrations — therapy-cloud vendor health dashboard.
//
// Shows each adapter (ResMed AirView, Philips Care Orchestrator,
// Health Connect) with:
//   * Availability badge (configured / stub / unavailable).
//   * Last-7d success vs error counts.
//   * Top 3 error codes when present.
//   * Last successful refresh timestamp.
//
// Includes a manual "Run nightly sync now" button (admin-only).
// The button calls the synchronous endpoint and prints the result;
// for the scheduled run, see the pg-boss job
// therapy-integrations.nightly-sync.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw, ServerCog, TriangleAlert } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  getIntegrationsStatus,
  triggerNightlySync,
  type IntegrationAdapterStatus,
} from "@/lib/admin/integrations-status-api";

const queryKey = ["admin", "integrations", "status"] as const;

const SOURCE_LABELS: Record<IntegrationAdapterStatus["source"], string> = {
  resmed_airview: "ResMed AirView",
  philips_care: "Philips Care Orchestrator",
  health_connect: "Health Connect",
};

export function AdminIntegrationsPage() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: getIntegrationsStatus,
    refetchOnWindowFocus: true,
  });
  const nightlySync = useMutation({
    mutationFn: triggerNightlySync,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ServerCog className="h-6 w-6" /> Therapy-cloud integrations
          </h1>
          <p
            className="text-sm mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            ResMed AirView, Philips Care Orchestrator, and Health
            Connect adapter health over the last 7 days.
          </p>
        </div>
        <Button
          onClick={() => nightlySync.mutate()}
          disabled={nightlySync.isPending}
          title="Synchronously refresh every active therapy link."
        >
          <RefreshCw
            className={`h-4 w-4 mr-1.5 ${
              nightlySync.isPending ? "animate-spin" : ""
            }`}
          />
          {nightlySync.isPending ? "Syncing…" : "Run nightly sync now"}
        </Button>
      </header>

      {nightlySync.data && (
        <div
          className="rounded-lg border px-3 py-2 text-sm"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "hsl(var(--surface-2))",
          }}
        >
          Sweep complete: <strong>{nightlySync.data.refreshed}</strong>{" "}
          refreshed · <strong>{nightlySync.data.failed}</strong> failed ·{" "}
          <strong>{nightlySync.data.nightsPersisted}</strong> nights persisted
          (out of {nightlySync.data.scanned} active links).
        </div>
      )}

      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : (
          <AdapterTable adapters={data.adapters} />
        )}
      </Card>
    </div>
  );
}

function AdapterTable({
  adapters,
}: {
  adapters: IntegrationAdapterStatus[];
}) {
  if (adapters.length === 0) {
    return (
      <p
        className="text-sm py-3"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        No adapters registered.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Vendor</th>
          <th className="py-2 font-semibold">Availability</th>
          <th className="py-2 font-semibold">Last 7d</th>
          <th className="py-2 font-semibold">Top errors</th>
          <th className="py-2 font-semibold">Last refresh</th>
        </tr>
      </thead>
      <tbody>
        {adapters.map((a) => (
          <AdapterRow key={a.source} adapter={a} />
        ))}
      </tbody>
    </table>
  );
}

function AdapterRow({ adapter }: { adapter: IntegrationAdapterStatus }) {
  const availStatus = adapter.availability.status;
  return (
    <tr className="border-b" style={{ borderColor: "hsl(var(--line-2))" }}>
      <td className="py-2 font-medium">
        {SOURCE_LABELS[adapter.source]}
      </td>
      <td className="py-2">
        <AvailabilityBadge status={availStatus} />
        {availStatus !== "configured" && (
          <span
            className="ml-2 text-xs"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {"reason" in adapter.availability
              ? adapter.availability.reason
              : ""}
          </span>
        )}
      </td>
      <td className="py-2 text-xs">
        <span style={{ color: "hsl(142,72%,29%)", fontWeight: 600 }}>
          {adapter.recentSnapshots.ok}
        </span>
        <span style={{ color: "hsl(var(--ink-3))" }}> ok · </span>
        <span
          style={{
            color:
              adapter.recentSnapshots.error > 0
                ? "hsl(0,84%,45%)"
                : "hsl(var(--ink-3))",
            fontWeight: 600,
          }}
        >
          {adapter.recentSnapshots.error}
        </span>
        <span style={{ color: "hsl(var(--ink-3))" }}> error</span>
      </td>
      <td className="py-2 text-xs">
        {adapter.errorSamples.length === 0 ? (
          <span style={{ color: "hsl(var(--ink-3))" }}>—</span>
        ) : (
          <ul className="space-y-0.5">
            {adapter.errorSamples.map((s) => (
              <li key={s.error} className="font-mono">
                <TriangleAlert
                  className="h-3 w-3 mr-1 inline-block"
                  style={{ color: "hsl(38,92%,45%)" }}
                />
                {s.error} ×{s.count}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="py-2 text-xs">
        {adapter.lastFetchedAt
          ? new Date(adapter.lastFetchedAt).toLocaleString()
          : "never"}
      </td>
    </tr>
  );
}

function AvailabilityBadge({
  status,
}: {
  status: "configured" | "stub" | "unavailable";
}) {
  const styles: Record<
    typeof status,
    { bg: string; fg: string; label: string }
  > = {
    configured: {
      bg: "rgba(16,185,129,0.15)",
      fg: "hsl(142,72%,29%)",
      label: "Live",
    },
    stub: {
      bg: "rgba(59,130,246,0.15)",
      fg: "hsl(217,91%,45%)",
      label: "Stub",
    },
    unavailable: {
      bg: "rgba(239,68,68,0.15)",
      fg: "hsl(0,84%,45%)",
      label: "Down",
    },
  };
  const s = styles[status];
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider"
      style={{ backgroundColor: s.bg, color: s.fg }}
    >
      {status === "configured" && (
        <CheckCircle2 className="h-3 w-3 mr-1" />
      )}
      {s.label}
    </span>
  );
}
