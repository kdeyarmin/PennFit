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

import { type CSSProperties, Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type FitterLeadJourneyStage,
  type FitterLeadRow,
  type FitterLeadSource,
  type FitterTimelineEvent,
  type FitterTouchVariantMetric,
  getFitterLeadTimeline,
  listFitterLeads,
  listFitterTouchMetrics,
  listFitterTouchVariantMetrics,
  markContactedFitterLead,
  setFitterLeadNotes,
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
    label: "Pre-purchase",
    description: "T1–T6 nurture (60d)",
  },
  reorder_active: {
    bg: "#cffafe",
    fg: "#155e75",
    label: "Re-order nurture",
    description: "T7–T10 supply touches (180d)",
  },
  final_call_pending: {
    bg: "#ffe4e6",
    fg: "#9f1239",
    label: "Final call queued",
    description: "T11 cold-lead reactivation due",
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
  "reorder_active",
  "final_call_pending",
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
  const [hotOnly, setHotOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const queryKey = ["admin", "fitter-leads", stage, source, hotOnly] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listFitterLeads(stage, source, hotOnly),
  });
  // Per-touch metrics are an independent query — they don't change
  // with stage/source filters and update on a slower clock than
  // the row list.
  const metricsQuery = useQuery({
    queryKey: ["admin", "fitter-leads", "metrics"] as const,
    queryFn: listFitterTouchMetrics,
    // Per-touch numbers shift more slowly than the row list — a
    // fresh refetch on every interaction would be wasted bandwidth.
    staleTime: 60_000,
  });
  // Per-(touch, subject-variant) breakdown for the A/B-testing
  // expand-row affordance (mig 0157). Only the touches with > 1
  // variant render a child row; the metrics card hides the
  // affordance otherwise.
  const variantMetricsQuery = useQuery({
    queryKey: ["admin", "fitter-leads", "metrics", "variants"] as const,
    queryFn: listFitterTouchVariantMetrics,
    staleTime: 60_000,
  });
  // Group variant rows by touch_index for the inline expand. A
  // touch with only the default 'A' variant isn't worth the extra
  // row — same numbers as the rollup.
  const variantsByTouch = useMemo(() => {
    const map = new Map<number, FitterTouchVariantMetric[]>();
    for (const v of variantMetricsQuery.data?.variants ?? []) {
      const existing = map.get(v.touchIndex);
      if (existing) {
        existing.push(v);
      } else {
        map.set(v.touchIndex, [v]);
      }
    }
    return map;
  }, [variantMetricsQuery.data]);

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    "unsubscribe" | "contacted" | null
  >(null);
  const unsubscribeMut = useMutation({
    mutationFn: (id: string) => unsubscribeFitterLead(id),
    onMutate: (id) => {
      setPendingId(id);
      setPendingAction("unsubscribe");
    },
    onSettled: () => {
      setPendingId(null);
      setPendingAction(null);
      void queryClient.invalidateQueries({
        queryKey: ["admin", "fitter-leads"],
      });
    },
  });
  const markContactedMut = useMutation({
    mutationFn: (id: string) => markContactedFitterLead(id),
    onMutate: (id) => {
      setPendingId(id);
      setPendingAction("contacted");
    },
    onSettled: () => {
      setPendingId(null);
      setPendingAction(null);
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
        reorder_active: 0,
        final_call_pending: 0,
        converted: 0,
        unsubscribed: 0,
        expired: 0,
      },
    [data?.counts],
  );
  const hotLeadsActive = data?.hotLeadsActive ?? 0;
  const hotLeadsNeedingContact = data?.hotLeadsNeedingContact ?? 0;
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
          Completing the fitter enrolls a lead into a <strong>6-touch
          pre-purchase nurture</strong> over 60 days. Placing an order
          flips them into the <strong>4-touch post-purchase re-order
          nurture</strong> (cushion at 30d, filter at 60d, headgear at
          90d, full refresh at 180d) so first-time buyers turn into
          recurring supply orders.
        </p>
      </header>

      {/* Headline KPIs — conversion rate + hot-leads CSR queue. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            {counts.converted + counts.reorder_active} converted (incl.{" "}
            {counts.reorder_active} in active re-order nurture) out of{" "}
            {counts.completed +
              counts.campaign_active +
              counts.reorder_active +
              counts.final_call_pending +
              counts.converted +
              counts.expired}{" "}
            completed-fitter leads.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setHotOnly((v) => !v)}
          className="border rounded-lg p-4 flex items-baseline gap-4 text-left hover:shadow transition-shadow"
          style={{
            borderColor: hotOnly ? "#9f1239" : "hsl(var(--line-1))",
            outline: hotOnly ? "2px solid #9f1239" : "none",
            outlineOffset: "-2px",
            background: hotOnly ? "#fef2f4" : "#fff",
          }}
          data-testid="leads-hot-tile"
        >
          <div>
            <div
              className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: "#9f1239" }}
            >
              Hot leads · call now
            </div>
            <div
              className="text-3xl font-semibold tabular-nums"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {hotLeadsNeedingContact}
            </div>
          </div>
          <div className="text-xs text-slate-500 leading-snug">
            {hotLeadsNeedingContact} need a CSR call now ·{" "}
            {hotLeadsActive - hotLeadsNeedingContact} already contacted.
            <br />
            Hot = 3+ opens or any click without ordering.
            <br />
            {hotOnly
              ? "Filter is ON — click to show all leads."
              : "Click to filter the list to just these."}
          </div>
        </button>
      </div>

      {/* Per-touch send / open / click metrics. Single horizontal
          table so ops can scan across the 11 touchpoints and see
          which ones earn engagement. */}
      <div
        className="border rounded-lg bg-white overflow-x-auto"
        style={{ borderColor: "hsl(var(--line-1))" }}
        data-testid="leads-touch-metrics"
      >
        <div className="px-4 py-3 border-b" style={{ borderColor: "hsl(var(--line-1))" }}>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Per-touch metrics
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            T1–T6 pre-purchase · T7–T10 re-order · T11 final-call. Open + click rates are against email_sends.
          </div>
        </div>
        <table className="w-full text-xs min-w-[720px]">
          <thead style={{ backgroundColor: "#f8fafc", color: "#475569" }}>
            <tr>
              <th className="text-left px-3 py-2 font-semibold">Touch</th>
              <th className="text-right px-3 py-2 font-semibold">Email sends</th>
              <th className="text-right px-3 py-2 font-semibold">Opens</th>
              <th className="text-right px-3 py-2 font-semibold">Open %</th>
              <th className="text-right px-3 py-2 font-semibold">Clicks</th>
              <th className="text-right px-3 py-2 font-semibold">Click %</th>
              <th className="text-right px-3 py-2 font-semibold">SMS sends</th>
              <th className="text-right px-3 py-2 font-semibold">Failures</th>
            </tr>
          </thead>
          <tbody>
            {metricsQuery.isPending && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-slate-500">
                  Loading metrics…
                </td>
              </tr>
            )}
            {!metricsQuery.isPending && (metricsQuery.data?.touches ?? []).map((m) => {
              const variants = variantsByTouch.get(m.touchIndex) ?? [];
              const showVariants = variants.length > 1;
              return (
                <Fragment key={m.touchIndex}>
                  <tr
                    style={{ borderTop: "1px solid hsl(var(--line-1))" }}
                    data-testid={`touch-metric-T${m.touchIndex}`}
                  >
                    <td className="px-3 py-1.5 font-medium">
                      T{m.touchIndex}
                      {showVariants && (
                        <span
                          className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                          style={{ background: "#ede9fe", color: "#6b21a8" }}
                          title={`Running A/B test across ${variants.length} subject variants`}
                        >
                          A/B
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {m.emailSends}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {m.opens}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right tabular-nums"
                      style={{
                        color:
                          m.openRate >= 0.5
                            ? "#14532d"
                            : m.openRate >= 0.25
                              ? "#854d0e"
                              : "#475569",
                      }}
                    >
                      {m.emailSends > 0 ? `${(m.openRate * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {m.clicks}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right tabular-nums"
                      style={{
                        color:
                          m.clickRate >= 0.1
                            ? "#14532d"
                            : m.clickRate >= 0.05
                              ? "#854d0e"
                              : "#475569",
                      }}
                    >
                      {m.emailSends > 0 ? `${(m.clickRate * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                      {m.smsSends}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right tabular-nums"
                      style={{
                        color: m.emailFailures + m.smsFailures > 0 ? "#9f1239" : "#9ca3af",
                      }}
                    >
                      {m.emailFailures + m.smsFailures}
                    </td>
                  </tr>
                  {showVariants && variants.map((v) => (
                    <tr
                      key={`${m.touchIndex}-${v.subjectVariantKey}`}
                      style={{ background: "#faf5ff", color: "#475569" }}
                      data-testid={`touch-metric-variant-T${m.touchIndex}-${v.subjectVariantKey}`}
                    >
                      <td className="px-3 py-1 pl-8 text-[11px]">
                        variant {v.subjectVariantKey}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-[11px]">
                        {v.emailSends}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-[11px]">
                        {v.opens}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-[11px]">
                        {v.emailSends > 0
                          ? `${(v.openRate * 100).toFixed(0)}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-[11px]">
                        {v.clicks}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-[11px]">
                        {v.emailSends > 0
                          ? `${(v.clickRate * 100).toFixed(1)}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-[11px] text-slate-400">
                        —
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-[11px] text-slate-400">
                        {v.emailFailures}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div
        className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3"
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
              <th className="text-left px-3 py-2 font-semibold">Engaged</th>
              <th className="text-left px-3 py-2 font-semibold">Last engaged</th>
              <th className="text-left px-3 py-2 font-semibold">Next touch</th>
              <th className="text-left px-3 py-2 font-semibold">Started</th>
              <th className="text-right px-3 py-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isPending && (
              <tr>
                <td
                  colSpan={10}
                  className="px-3 py-6 text-center text-slate-500"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!isPending && rows.length === 0 && (
              <tr>
                <td
                  colSpan={10}
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
                r.journeyStage === "reorder_active" ||
                r.journeyStage === "final_call_pending" ||
                r.journeyStage === "completed" ||
                r.journeyStage === "consent";
              const isHot = r.hotLeadAt !== null;
              const isExpanded = expandedId === r.id;
              return (
                <Fragment key={r.id}>
                <tr
                  style={{ borderTop: "1px solid hsl(var(--line-1))" }}
                  data-testid={`lead-row-${r.id}`}
                >
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">
                      {r.firstName && (
                        <span className="text-slate-900">
                          {r.firstName}{" "}
                        </span>
                      )}
                      <span className="text-slate-600 font-normal">
                        {r.email}
                      </span>
                    </div>
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
                    {r.campaignTouchCount}/11
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="tabular-nums font-medium"
                        title={`${r.engagementScore} engagement points (1 per open, 5 per click)`}
                        style={{ color: r.engagementScore > 0 ? "#155e75" : "#9ca3af" }}
                      >
                        {r.engagementScore}
                      </span>
                      {r.clickCount > 0 && (
                        <span
                          className="tabular-nums text-[11px] px-1 rounded"
                          title={`${r.clickCount} CTA click${r.clickCount === 1 ? "" : "s"}`}
                          style={{ background: "#e0f2fe", color: "#075985" }}
                        >
                          {r.clickCount}🖱
                        </span>
                      )}
                      {isHot && !r.csrContactedAt && (
                        <span
                          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                          style={{ background: "#fee2e2", color: "#9f1239" }}
                          data-testid={`lead-hot-badge-${r.id}`}
                        >
                          Hot
                        </span>
                      )}
                      {isHot && r.csrContactedAt && (
                        <span
                          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                          style={{ background: "#dcfce7", color: "#14532d" }}
                          title={`Contacted ${formatRelative(r.csrContactedAt, nowMs)} by ${r.csrContactedBy ?? "—"}`}
                          data-testid={`lead-contacted-badge-${r.id}`}
                        >
                          Contacted
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-slate-600">
                    {(() => {
                      // Show the most recent of opens / clicks /
                      // CSR-contact, with a label so a CSR
                      // scanning the queue can triage at a glance.
                      const opens = r.lastOpenAt
                        ? new Date(r.lastOpenAt).getTime()
                        : 0;
                      const clicks = r.lastClickAt
                        ? new Date(r.lastClickAt).getTime()
                        : 0;
                      if (clicks > 0 && clicks >= opens) {
                        return (
                          <span style={{ color: "#075985" }}>
                            clicked {formatRelative(r.lastClickAt as string, nowMs)}
                          </span>
                        );
                      }
                      if (opens > 0) {
                        return (
                          <span style={{ color: "#155e75" }}>
                            opened {formatRelative(r.lastOpenAt as string, nowMs)}
                          </span>
                        );
                      }
                      return <span className="text-slate-400">—</span>;
                    })()}
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
                    <div className="flex gap-1.5 justify-end flex-wrap">
                      {isHot && !r.csrContactedAt && (
                        <button
                          type="button"
                          onClick={() => markContactedMut.mutate(r.id)}
                          disabled={pendingId === r.id}
                          className="px-2 py-1 rounded text-xs font-semibold border bg-white disabled:opacity-50"
                          style={{
                            color: "#14532d",
                            borderColor: "#86efac",
                            background: "#f0fdf4",
                          }}
                          data-testid={`lead-mark-contacted-${r.id}`}
                          title="Stamp this lead as CSR-contacted so it drops out of the call-now queue."
                        >
                          {pendingId === r.id && pendingAction === "contacted"
                            ? "…"
                            : "Mark contacted"}
                        </button>
                      )}
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
                          {pendingId === r.id && pendingAction === "unsubscribe"
                            ? "…"
                            : "Unsubscribe"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId(isExpanded ? null : r.id)
                        }
                        className="px-2 py-1 rounded text-xs font-semibold border bg-white"
                        style={{
                          color: "#1e3a8a",
                          borderColor: "#bfdbfe",
                        }}
                        data-testid={`lead-toggle-details-${r.id}`}
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? "Hide" : "Details"}
                      </button>
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr style={{ background: "#f8fafc" }}>
                    <td colSpan={10} className="px-3 py-3">
                      <LeadDetailsPanel lead={r} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// LeadDetailsPanel — lazy-loads the per-lead activity timeline +
// hosts the CSR notes editor. Mounted inline under the row when
// the patient clicks "Details."
// ---------------------------------------------------------------
function LeadDetailsPanel({ lead }: { lead: FitterLeadRow }) {
  const queryClient = useQueryClient();
  const timelineQuery = useQuery({
    queryKey: ["admin", "fitter-leads", lead.id, "timeline"] as const,
    queryFn: () => getFitterLeadTimeline(lead.id),
  });
  const [notesDraft, setNotesDraft] = useState(lead.csrNotes ?? "");
  const [notesPending, setNotesPending] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const notesMut = useMutation({
    mutationFn: (notes: string | null) => setFitterLeadNotes(lead.id, notes),
    onMutate: () => {
      setNotesPending(true);
      setNotesSaved(false);
    },
    onSettled: () => {
      setNotesPending(false);
      void queryClient.invalidateQueries({
        queryKey: ["admin", "fitter-leads"],
      });
    },
    onSuccess: () => setNotesSaved(true),
  });
  const nowMs = Date.now();
  return (
    <div
      className="grid grid-cols-1 lg:grid-cols-2 gap-4"
      data-testid={`lead-details-panel-${lead.id}`}
    >
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">
          Activity timeline
        </div>
        {timelineQuery.isPending && (
          <div className="text-xs text-slate-500">Loading timeline…</div>
        )}
        {timelineQuery.isError && (
          <div className="text-xs text-rose-700">
            Couldn&apos;t load timeline. Try refreshing.
          </div>
        )}
        {timelineQuery.data && timelineQuery.data.events.length === 0 && (
          <div className="text-xs text-slate-500">No events recorded yet.</div>
        )}
        {timelineQuery.data && timelineQuery.data.events.length > 0 && (
          <ol className="space-y-1.5 text-xs">
            {timelineQuery.data.events.map((e: FitterTimelineEvent, i) => (
              <li
                key={`${e.ts}-${i}`}
                className="flex items-start gap-2"
                data-testid={`lead-timeline-event-${i}`}
              >
                <span
                  className="tabular-nums text-slate-500 shrink-0"
                  style={{ minWidth: "5.5rem" }}
                >
                  {formatRelative(e.ts, nowMs)}
                </span>
                <span
                  className="inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
                  style={timelineEventStyle(e.kind)}
                >
                  {timelineEventBadge(e.kind)}
                </span>
                <span className="text-slate-700">
                  {e.label}
                  {e.detail && (
                    <span className="text-slate-500"> · {e.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">
          CSR notes
        </div>
        <textarea
          value={notesDraft}
          onChange={(e) => {
            setNotesDraft(e.target.value);
            setNotesSaved(false);
          }}
          rows={6}
          maxLength={2000}
          placeholder="What did the patient say? What's the next step? Operator scratchpad — visible to every CSR who opens this row."
          aria-label="CSR notes"
          className="w-full border rounded p-2 text-xs"
          style={{ borderColor: "hsl(var(--line-1))" }}
          data-testid={`lead-notes-textarea-${lead.id}`}
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() =>
              notesMut.mutate(notesDraft.trim().length === 0 ? null : notesDraft)
            }
            disabled={notesPending || notesDraft === (lead.csrNotes ?? "")}
            className="px-3 py-1.5 rounded text-xs font-semibold border bg-white disabled:opacity-50"
            style={{
              color: "#0f1d3a",
              borderColor: "#bfdbfe",
              background: "#eff6ff",
            }}
            data-testid={`lead-notes-save-${lead.id}`}
          >
            {notesPending ? "Saving…" : "Save notes"}
          </button>
          {notesSaved && !notesPending && (
            <span className="text-xs text-emerald-700">Saved.</span>
          )}
          {lead.coldSkippedAt && (
            <span
              className="ml-auto text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: "#e0e7ff", color: "#3730a3" }}
              title={`Cold-skipped at ${lead.coldSkippedAt} — T5+T6 auto-suppressed because lead showed zero engagement through T4.`}
            >
              cold-skipped
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Per-kind badge styling for the activity timeline. */
function timelineEventStyle(kind: string): CSSProperties {
  if (kind.startsWith("touch_sent")) return { background: "#e0e7ff", color: "#3730a3" };
  if (kind === "touch_opened") return { background: "#cffafe", color: "#155e75" };
  if (kind === "click") return { background: "#dbeafe", color: "#1e40af" };
  if (kind === "hot_flipped") return { background: "#fee2e2", color: "#9f1239" };
  if (kind === "cold_skipped") return { background: "#e0e7ff", color: "#3730a3" };
  if (kind === "csr_contacted") return { background: "#dcfce7", color: "#14532d" };
  if (kind === "order_placed") return { background: "#dcfce7", color: "#14532d" };
  if (kind === "unsubscribed") return { background: "#fee2e2", color: "#7f1d1d" };
  if (kind === "fitter_completed") return { background: "#fef3c7", color: "#854d0e" };
  if (kind === "lead_created") return { background: "#f1f5f9", color: "#475569" };
  return { background: "#f1f5f9", color: "#475569" };
}

function timelineEventBadge(kind: string): string {
  if (kind === "touch_sent_email") return "email";
  if (kind === "touch_sent_sms") return "sms";
  if (kind === "touch_opened") return "open";
  if (kind === "touch_failed_email") return "fail";
  if (kind === "touch_failed_sms") return "fail";
  if (kind === "click") return "click";
  if (kind === "hot_flipped") return "hot";
  if (kind === "cold_skipped") return "cold";
  if (kind === "csr_contacted") return "csr";
  if (kind === "order_placed") return "order";
  if (kind === "unsubscribed") return "unsub";
  if (kind === "fitter_completed") return "fit";
  if (kind === "lead_created") return "start";
  return kind;
}
