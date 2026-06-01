// /admin/analytics/ltv-cac — LTV & CAC by acquisition channel (Owner #3).
//
// Average lifetime value vs average customer-acquisition cost per
// channel, with the LTV:CAC ratio (the headline "is this channel worth
// it" number). CAC is over the costed-customer subset only — channels
// with thin cost data show their costed/total split rather than a
// fabricated CAC. A small form records a customer's channel + cost.
//
// cost.read-gated server-side; nav gated to match.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchLtvCac,
  recordAcquisition,
  type AcquisitionChannel,
  type ChannelEconomics,
} from "@/lib/admin/ltv-cac-api";

const CHANNELS: ReadonlyArray<{ value: AcquisitionChannel; label: string }> = [
  { value: "organic", label: "Organic" },
  { value: "paid_search", label: "Paid search" },
  { value: "paid_social", label: "Paid social" },
  { value: "referral", label: "Referral" },
  { value: "fitter", label: "Fitter" },
  { value: "insurance_lead", label: "Insurance lead" },
  { value: "partner", label: "Partner" },
  { value: "other", label: "Other" },
];

const CHANNEL_LABEL: Record<string, string> = {
  ...Object.fromEntries(CHANNELS.map((c) => [c.value, c.label])),
  unattributed: "Unattributed",
};

const QUERY_KEY = ["admin", "ltv-cac"] as const;

function money(cents: number | null): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function ratio(r: number | null): string {
  return r == null ? "—" : `${r.toFixed(1)}:1`;
}

export function AdminLtvCacPage() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchLtvCac,
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-ltv-cac-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <TrendingUp className="h-6 w-6" />
          LTV &amp; CAC by channel
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Average lifetime value vs acquisition cost per channel. CAC is
          averaged over customers whose cost is recorded — a channel&apos;s
          costed/total split is shown so thin data is visible, never a guessed
          CAC. LTV:CAC above ~3:1 is the usual healthy bar.
        </p>
      </header>

      <RecordAcquisitionCard />

      {query.isPending ? (
        <Spinner label="Loading cohort economics…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <ChannelTable rows={query.data.byChannel} />
      )}
    </div>
  );
}

function RecordAcquisitionCard() {
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState("");
  const [channel, setChannel] = useState<AcquisitionChannel>("organic");
  const [cost, setCost] = useState("");

  const costNum = cost.trim() === "" ? null : Number(cost);
  const costValid =
    costNum == null || (Number.isFinite(costNum) && costNum >= 0);
  const valid = customerId.trim() !== "" && costValid;

  const save = useMutation({
    mutationFn: () =>
      recordAcquisition(customerId.trim(), {
        channel,
        // dollars entered → cents stored.
        acquisitionCostCents:
          costNum == null ? null : Math.round(costNum * 100),
      }),
    onSuccess: () => {
      setCustomerId("");
      setCost("");
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  return (
    <Card title="Record acquisition">
      <div className="flex flex-wrap gap-2 items-end">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Customer ID
          </span>
          <Input
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            placeholder="customer id"
            aria-label="Customer ID"
            className="font-mono w-[220px]"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Channel
          </span>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as AcquisitionChannel)}
            className="rounded border border-slate-300 px-2 py-2 text-sm"
            aria-label="Acquisition channel"
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Acq. cost ($, optional)
          </span>
          <Input
            type="number"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="e.g. 80"
            aria-label="Acquisition cost dollars"
            className="w-[130px]"
          />
        </label>
        <Button
          disabled={!valid || save.isPending}
          isLoading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </div>
      {save.error instanceof Error && (
        <p className="mt-2 text-sm" style={{ color: "#b91c1c" }} role="alert">
          {save.error.message}
        </p>
      )}
    </Card>
  );
}

function ChannelTable({ rows }: { rows: ChannelEconomics[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No customers with revenue or recorded attribution yet.
        </p>
      </Card>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[820px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Channel</th>
            <th className="text-right px-3 py-2">Customers</th>
            <th className="text-right px-3 py-2">Avg LTV</th>
            <th className="text-right px-3 py-2">Avg CAC</th>
            <th className="text-right px-3 py-2">LTV:CAC</th>
            <th className="text-right px-3 py-2">Cost coverage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cov =
              r.customerCount > 0
                ? r.customersWithCost / r.customerCount
                : null;
            const ratioTone =
              r.ltvToCacRatio == null
                ? "hsl(var(--ink-3))"
                : r.ltvToCacRatio >= 3
                  ? "#15803d"
                  : r.ltvToCacRatio >= 1
                    ? "#b45309"
                    : "#b91c1c";
            return (
              <tr
                key={r.channel}
                className="border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="px-3 py-2 text-slate-800">
                  {CHANNEL_LABEL[r.channel] ?? r.channel}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.customerCount}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {money(r.avgLtvCents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {money(r.avgCacCents)}
                </td>
                <td
                  className="px-3 py-2 text-right tabular-nums font-semibold"
                  style={{ color: ratioTone }}
                >
                  {ratio(r.ltvToCacRatio)}
                </td>
                <td
                  className="px-3 py-2 text-right tabular-nums"
                  style={{
                    color:
                      cov != null && cov < 1 ? "#b45309" : "hsl(var(--ink-3))",
                  }}
                >
                  {cov == null ? "—" : `${Math.round(cov * 100)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
