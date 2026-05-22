// /admin/fitter-leads — funnel queue + KPI dashboard for the at-home
// fitter-to-supply-campaign conversion path.
//
// Page layout mirrors /admin/shop/insurance-leads: KPI strip with
// stage counts on top, stage filter buttons, then a table of leads.
// Each row carries an inline "force unsubscribe" button so CSRs can
// honor a phone-in opt-out without waiting for the patient to click
// the email link.
//
// PHI handling
// ------------
// Email + phone + recommended-mask reference are shown in the clear.
// The requireAdmin gate at the API layer has already cleared the PHI-
// access policy check; this page does not log per-row PHI to the
// browser console either.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type FitterLeadJourneyStage,
  type FitterLeadSource,
  listFitterLeads,
  unsubscribeFitterLead,
} from "@/lib/admin/fitter-leads-api";
import { ErrorPanel } from "@/components/admin/ErrorPanel";

const STAGE_STYLE: Record<
  FitterLeadJourneyStage,
  { bg: string; fg: string; label: string; description: string }
> = {
  consent: {
    bg: "#f1f5f9",
    fg: "#475569",
    label: "In funnel",
    description: "Opted in, not yet at /results",
  },
  completed: {
    bg: "#e0e7ff",
    fg: "#3730a3",
    label: "Completed",
    description: "Saw the recommendation",
  },
  campaign_active: {
    bg: "#fef3c7",
    fg: "#854d0e",
    label: "In campaign",
    description: "Receiving nurture touches",
  },
  converted: {
    bg: "#dcfce7",
    fg: "#14532d",
    label: "Converted",
    description: "Placed an order",
  },
  unsubscribed: {
    bg: "#fee2e2",
    fg: "#7f1d1d",
    label: "Unsubscribed",
    description: "Opted out (terminal)",
  },
  expired: {
    bg: "#e5e7eb",
    fg: "#374151",
    label: "Expired",
    description: "All touches exhausted",
  },
};

const STAGE_ORDER: readonly FitterLeadJourneyStage[] = [
  "consent",
  "completed",
  "campaign_active",
  "converted",
  "unsubscribed",
  "expired",
];

const SOURCE_LABEL: Record<FitterLeadSource, string> = {
  consent: "Fitter /consent",
  sleep_apnea_quiz: "Sleep apnea quiz",
  insurance_quote: "Insurance quote",
};

function formatRelative(iso: string, nowMs: number): string {
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatFuture(iso: string, nowMs: number): string {
  const ms = new Date(iso).getTime() - nowMs;
  if (ms <= 0) return "due now";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const days = Math.floor(hr / 24);
  return `in ${days}d`;
}

export function AdminFitterLeadsPage() {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<FitterLeadJourneyStage | "all">(
    "campaign_active",
  );
  const [source, setSource] = useState<FitterLeadSource | "all">("all");
  const queryKey = ["admin", "fitter-leads", stage, source] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listFitterLeads(stage, source),
  });

  const [pendingId, setPendingId] = useState<string | null>(null);
  const unsubscribeMut = useMutation({
    mutationFn: (id: string) => unsubscribeFitterLead(id),
    onMutate: (id) => setPendingId(id),
    onSettled: () => {
      setPendingId(null);
      void queryClient.invalidateQueries({
        queryKey: ["admin", "fitter-leads"],
      });
    },
  });

  const rows = data?.rows ?? [];
  const counts = useMemo(
    () =>
      data?.counts ?? {
        consent: 0,
        completed: 0,
        campaign_active: 0,
        converted: 0,
        unsubscribed: 0,
        expired: 0,
      },
    [data?.counts],
  );
  const total = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );
  const conversionRate = data?.conversionRate ?? 0;
  const conversionPct = (conversionRate * 100).toFixed(1);
  const nowMs = Date.now();

  return (
    <div className="space-y-6" data-testid="admin-fitter-leads-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Fitter prospects
        </h1>
        <p className="text-sm text-slate-600 max-w-2xl">
          Patients who started or finished the at-home mask fitter on{" "}
          <span className="font-mono text-xs">/consent → /results</span>.
          Completing the fitter enrolls a lead into a 6-touch nurture
          campaign over 60 days; conversions (orders placed) drop the lead
          out of the sequence automatically.
        </p>
      </header>

      {/* Headline conversion KPI — the one number ops cares most about. */}
      <div
        className="border rounded-lg bg-white p-4 flex items-baseline gap-4"
        style={{ borderColor: "hsl(var(--line-1))" }}
        data-testid="leads-conversion-rate"
      >
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Fitter → Order conversion
          </div>
          <div
            className="text-3xl font-semibold tabular-nums"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {conversionPct}%
          </div>
        </div>
        <div className="text-xs text-slate-500 leading-snug">
          {counts.converted} converted out of{" "}
          {counts.completed +
            counts.campaign_active +
            counts.converted +
            counts.expired}{" "}
          completed-fitter leads.{" "}
          <br />
          Excludes opted-out and pre-completion rows.
        </div>
      </div>

      <div
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3"
        data-testid="leads-counts"
      >
        {STAGE_ORDER.map((s) => {
          const sty = STAGE_STYLE[s];
          return (
            <button
              type="button"
              key={s}
              onClick={() => setStage(stage === s ? "all" : s)}
              className="text-left border rounded-lg p-3 bg-white hover:shadow transition-shadow"
              style={{
                borderColor: stage === s ? sty.fg : "hsl(var(--line-1))",
                outline: stage === s ? `2px solid ${sty.fg}` : "none",
                outlineOffset: "-2px",
              }}
              data-testid={`leads-count-${s}`}
            >
              <div
                className="text-[10px] font-bold uppercase tracking-wider mb-1"
                style={{ color: sty.fg }}
              >
                {sty.label}
              </div>
              <div
                className="text-2xl font-semibold tabular-nums"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {counts[s]}
              </div>
              <div className="text-[11px] text-slate-500 mt-1 leading-snug">
                {sty.description}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setStage("all")}
          disabled={stage === "all"}
          className="px-3 py-1.5 rounded text-xs font-semibold border bg-white disabled:opacity-50"
          style={{
            color: "hsl(var(--ink-1))",
            borderColor: "hsl(var(--line-1))",
          }}
          data-testid="leads-filter-all"
        >
          Show all stages ({total})
        </button>
        <label className="text-xs text-slate-600 flex items-center gap-1">
          Source:
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as FitterLeadSource | "all")}
            className="border rounded px-2 py-1 text-xs"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid="leads-source-filter"
          >
            <option value="all">All</option>
            <option value="consent">Fitter /consent</option>
            <option value="sleep_apnea_quiz">Sleep apnea quiz</option>
            <option value="insurance_quote">Insurance quote</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isPending}
          className="px-3 py-1.5 rounded text-xs font-semibold border bg-white"
          style={{
            color: "hsl(var(--ink-1))",
            borderColor: "hsl(var(--line-1))",
          }}
          data-testid="leads-refresh"
        >
          Refresh
        </button>
        <span className="text-xs text-slate-500">
          Showing {rows.length} lead(s)
        </span>
      </div>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <div
        className="border rounded-lg bg-white overflow-x-auto"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <table className="w-full text-sm min-w-[960px]">
          <thead style={{ backgroundColor: "#f8fafc" }}>
            <tr style={{ color: "#475569" }}>
              <th className="text-left px-3 py-2 font-semibold">Patient</th>
              <th className="text-left px-3 py-2 font-semibold">Source</th>
              <th className="text-left px-3 py-2 font-semibold">
                Recommended mask
              </th>
              <th className="text-left px-3 py-2 font-semibold">Stage</th>
              <th className="text-left px-3 py-2 font-semibold">Touches</th>
              <th className="text-left px-3 py-2 font-semibold">Next touch</th>
              <th className="text-left px-3 py-2 font-semibold">Started</th>
              <th className="text-right px-3 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isPending && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-slate-500"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!isPending && rows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-slate-500"
                >
                  No fitter leads match the current filter.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const stageStyle = STAGE_STYLE[r.journeyStage];
              const canUnsubscribe =
                r.journeyStage === "campaign_active" ||
                r.journeyStage === "completed" ||
                r.journeyStage === "consent";
              return (
                <tr
                  key={r.id}
                  style={{ borderTop: "1px solid hsl(var(--line-1))" }}
                  data-testid={`lead-row-${r.id}`}
                >
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">{r.email}</div>
                    {r.phoneE164 && (
                      <div className="text-xs text-slate-500">
                        {r.phoneE164}
                        {r.smsOptIn && (
                          <span className="ml-1 text-green-700">· SMS ✓</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-slate-600">
                    {SOURCE_LABEL[r.source]}
                  </td>
                  <td className="px-3 py-2 align-top">
                    {r.recommendedMaskName ? (
                      <div>
                        <div className="text-sm">{r.recommendedMaskName}</div>
                        {r.recommendedMaskType && (
                          <div className="text-xs text-slate-500">
                            {r.recommendedMaskType}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span
                      className="inline-block px-2 py-0.5 rounded text-xs font-semibold"
                      style={{
                        backgroundColor: stageStyle.bg,
                        color: stageStyle.fg,
                      }}
                    >
                      {stageStyle.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top text-sm tabular-nums">
                    {r.campaignTouchCount}/6
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-slate-600">
                    {r.nextCampaignTouchAt
                      ? formatFuture(r.nextCampaignTouchAt, nowMs)
                      : r.firstOrderPlacedAt
                        ? `ordered ${formatRelative(r.firstOrderPlacedAt, nowMs)}`
                        : "—"}
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-slate-600">
                    {formatRelative(r.createdAt, nowMs)}
                  </td>
                  <td className="px-3 py-2 align-top text-right">
                    {canUnsubscribe && (
                      <button
                        type="button"
                        onClick={() => unsubscribeMut.mutate(r.id)}
                        disabled={pendingId === r.id}
                        className="px-2 py-1 rounded text-xs font-semibold border bg-white disabled:opacity-50"
                        style={{
                          color: "#7f1d1d",
                          borderColor: "#fecaca",
                        }}
                        data-testid={`lead-unsubscribe-${r.id}`}
                      >
                        {pendingId === r.id ? "…" : "Unsubscribe"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
