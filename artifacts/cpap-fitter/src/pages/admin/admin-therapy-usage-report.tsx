// /admin/therapy-usage-report — the provider-facing "Therapy Adherence
// Report". A presentation/print-grade snapshot a marketing or clinical-
// liaison rep hands to a referring physician: how the patients they
// referred are doing on therapy with us, and the technology stack that
// keeps them compliant.
//
// Pulls three ways (by provider / patient / manufacturer) from
// GET /admin/reports/therapy-usage. PHI-safe: the "by patient" axis is
// de-identified server-side (opaque short refs, never names) so the
// printed sheet can be left behind in a clinic.
//
// Aesthetic: refined clinical-editorial — penn-navy field, gold
// hairlines, an editorial serif display face paired with the admin sans
// body. Built to look like a printed prospectus, not a dashboard. A
// scoped @media print block drops the app chrome so "Save as PDF"
// produces a clean leave-behind.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CloudCog,
  HeartPulse,
  Printer,
  ShieldCheck,
  Sparkles,
  Truck,
} from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  fetchTherapyUsageReport,
  type TherapyReportGrouping,
  type TherapyUsageGroup,
  type TherapyUsageReportResponse,
} from "@/lib/admin/therapy-usage-report-api";

const GROUPINGS: Array<{
  value: TherapyReportGrouping;
  label: string;
  noun: string;
}> = [
  { value: "provider", label: "By provider", noun: "referring provider" },
  { value: "patient", label: "By patient", noun: "patient" },
  { value: "manufacturer", label: "By manufacturer", noun: "device manufacturer" },
];

const WINDOWS = [30, 60, 90, 180, 365];

// ── formatting ──────────────────────────────────────────────────────

function pct(rate: number | null): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

function num(value: number | null, unit = ""): string {
  if (value == null) return "—";
  return `${value}${unit}`;
}

function hours(value: number | null): string {
  if (value == null) return "—";
  return `${value}h`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ── page ────────────────────────────────────────────────────────────

export function AdminTherapyUsageReportPage() {
  const [grouping, setGrouping] = useState<TherapyReportGrouping>("provider");
  const [days, setDays] = useState(90);

  const query = useQuery({
    queryKey: ["admin", "therapy-usage-report", grouping, days],
    queryFn: () => fetchTherapyUsageReport(grouping, days),
  });

  const groupingMeta =
    GROUPINGS.find((g) => g.value === grouping) ?? GROUPINGS[0]!;

  return (
    <div className="p-6 max-w-5xl">
      <ReportPrintStyles />

      {/* ── Controls (omitted from print) ── */}
      <div
        data-print-hide
        className="flex flex-wrap items-end justify-between gap-4 mb-6"
      >
        <div>
          <h1
            className="text-2xl font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Therapy Adherence Report
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            A provider-ready snapshot of therapy usage and the technology that
            keeps patients compliant. Choose an axis and window, then print or
            save as PDF for a clean leave-behind.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors"
          style={{
            backgroundColor: "hsl(var(--penn-navy))",
            color: "white",
          }}
        >
          <Printer className="h-4 w-4" />
          Print / Save PDF
        </button>
      </div>

      <div
        data-print-hide
        className="flex flex-wrap items-center gap-6 mb-8"
      >
        <Segmented
          label="Pull"
          value={grouping}
          options={GROUPINGS.map((g) => ({ value: g.value, label: g.label }))}
          onChange={(v) => setGrouping(v as TherapyReportGrouping)}
        />
        <Segmented
          label="Window"
          value={String(days)}
          options={WINDOWS.map((w) => ({ value: String(w), label: `${w}d` }))}
          onChange={(v) => setDays(Number(v))}
        />
      </div>

      {/* ── The report itself ── */}
      {query.isPending ? (
        <Spinner label="Compiling therapy data…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <ReportSheet
          data={query.data}
          groupingNoun={groupingMeta.noun}
          windowDays={days}
        />
      )}
    </div>
  );
}

// ── report sheet ────────────────────────────────────────────────────

function ReportSheet({
  data,
  groupingNoun,
  windowDays,
}: {
  data: TherapyUsageReportResponse;
  groupingNoun: string;
  windowDays: number;
}) {
  const { summary, groups } = data;

  return (
    <article
      id="therapy-report"
      className="surface-card overflow-hidden"
      style={{
        backgroundColor: "hsl(var(--surface-2))",
        animation: "tr-rise 480ms cubic-bezier(0.16,1,0.3,1) both",
      }}
    >
      <CoverBand
        grouping={groupingNoun}
        windowDays={windowDays}
        generatedAt={data.generatedAt}
        groupCount={groups.length}
      />

      <div className="px-8 py-8 space-y-10">
        <HeroStats summary={summary} />
        {groups.length > 0 && (
          <AdherenceChart groups={groups} groupingNoun={groupingNoun} />
        )}
        <DetailTable groups={groups} groupingNoun={groupingNoun} />
        <CapabilitiesSection />
        <ReportFooter />
      </div>
    </article>
  );
}

function CoverBand({
  grouping,
  windowDays,
  generatedAt,
  groupCount,
}: {
  grouping: string;
  windowDays: number;
  generatedAt: string;
  groupCount: number;
}) {
  return (
    <header
      className="relative overflow-hidden px-8 pt-9 pb-8"
      style={{
        background:
          "linear-gradient(135deg, hsl(var(--penn-navy-deep)) 0%, hsl(var(--penn-navy)) 55%, hsl(var(--penn-navy-soft)) 130%)",
        color: "white",
      }}
    >
      {/* atmospheric gold glow, top-right */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full"
        style={{
          background:
            "radial-gradient(circle, hsl(var(--penn-gold) / 0.30) 0%, transparent 70%)",
        }}
      />
      <div
        className="flex items-center gap-2 text-[11px] font-semibold uppercase"
        style={{ letterSpacing: "0.22em", color: "hsl(var(--penn-gold-soft))" }}
      >
        <span>PennFit</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>PennPAPs Therapy Management</span>
      </div>

      <h2
        className="mt-5 leading-[1.05]"
        style={{
          fontFamily: "var(--report-serif)",
          fontSize: "2.7rem",
          fontWeight: 600,
          letterSpacing: "-0.01em",
        }}
      >
        Therapy Adherence Report
      </h2>

      <p
        className="mt-3 max-w-xl text-sm leading-relaxed"
        style={{ color: "hsl(214 30% 86%)" }}
      >
        Objective, device-sourced therapy data for every{" "}
        <strong style={{ color: "white" }}>{grouping}</strong> we serve —
        compiled over the trailing {windowDays} days across {groupCount}{" "}
        {groupCount === 1 ? "cohort" : "cohorts"}.
      </p>

      {/* gold hairline */}
      <div
        className="mt-6 h-px w-full"
        style={{
          background:
            "linear-gradient(90deg, hsl(var(--penn-gold)) 0%, transparent 90%)",
        }}
      />

      <div
        className="mt-4 flex flex-wrap gap-x-8 gap-y-1 text-[11px]"
        style={{ color: "hsl(214 24% 78%)" }}
      >
        <span>
          Reporting window:{" "}
          <strong style={{ color: "white" }}>{windowDays} days</strong>
        </span>
        <span>
          Prepared:{" "}
          <strong style={{ color: "white" }}>{formatDate(generatedAt)}</strong>
        </span>
        <span>
          Adherence basis:{" "}
          <strong style={{ color: "white" }}>CMS ≥4h on ≥70% of nights</strong>
        </span>
      </div>
    </header>
  );
}

function HeroStats({
  summary,
}: {
  summary: TherapyUsageReportResponse["summary"];
}) {
  const stats = [
    {
      label: "Patients monitored",
      value: summary.patientCount.toLocaleString(),
      foot: `${summary.nightsWithData.toLocaleString()} nights of device data`,
    },
    {
      label: "CMS-compliant share",
      value: pct(summary.cmsComplianceRate),
      foot: `${summary.cmsCompliantPatients.toLocaleString()} patients meet threshold`,
      accent: true,
    },
    {
      label: "Avg nightly use",
      value: hours(summary.avgUsageHours),
      foot: `${pct(summary.adherentNightRate)} of nights ≥ 4 hours`,
    },
    {
      label: "Avg AHI",
      value: num(summary.avgAhi),
      foot:
        summary.avgLeakRateLMin != null
          ? `Avg leak ${summary.avgLeakRateLMin} L/min`
          : "Events per hour of therapy",
    },
  ];

  return (
    <section className="grid grid-cols-2 gap-px sm:grid-cols-4 rounded-xl overflow-hidden"
      style={{ backgroundColor: "hsl(var(--line-1))" }}
    >
      {stats.map((s, i) => (
        <div
          key={s.label}
          className="px-5 py-5"
          style={{
            backgroundColor: s.accent
              ? "hsl(var(--penn-gold-soft) / 0.45)"
              : "hsl(var(--surface-2))",
            animation: `tr-rise 520ms cubic-bezier(0.16,1,0.3,1) ${i * 70}ms both`,
          }}
        >
          <div
            className="text-[10.5px] font-semibold uppercase"
            style={{ letterSpacing: "0.14em", color: "hsl(var(--ink-3))" }}
          >
            {s.label}
          </div>
          <div
            className="mt-2 tabular-nums"
            style={{
              fontFamily: "var(--report-serif)",
              fontSize: "2.2rem",
              fontWeight: 600,
              lineHeight: 1,
              color: s.accent
                ? "hsl(var(--penn-gold-deep))"
                : "hsl(var(--penn-navy))",
            }}
          >
            {s.value}
          </div>
          <div
            className="mt-2 text-[11px] leading-snug"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {s.foot}
          </div>
        </div>
      ))}
    </section>
  );
}

const CHART_TOP_N = 8;

function AdherenceChart({
  groups,
  groupingNoun,
}: {
  groups: TherapyUsageGroup[];
  groupingNoun: string;
}) {
  const chartData = useMemo(() => {
    return [...groups]
      .filter((g) => g.cmsComplianceRate != null)
      .sort((a, b) => (b.cmsComplianceRate ?? 0) - (a.cmsComplianceRate ?? 0))
      .slice(0, CHART_TOP_N)
      .map((g) => ({
        label: g.label.length > 22 ? `${g.label.slice(0, 21)}…` : g.label,
        rate: Math.round((g.cmsComplianceRate ?? 0) * 1000) / 10,
      }));
  }, [groups]);

  if (chartData.length === 0) return null;

  return (
    <section>
      <SectionTitle
        eyebrow="Compliance at a glance"
        title={`CMS-compliant patient share by ${groupingNoun}`}
      />
      <div style={{ width: "100%", height: Math.max(chartData.length * 46, 140) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            layout="vertical"
            data={chartData}
            margin={{ top: 4, right: 56, bottom: 4, left: 8 }}
            barCategoryGap={14}
          >
            <XAxis type="number" domain={[0, 100]} hide />
            <YAxis
              type="category"
              dataKey="label"
              width={170}
              tickLine={false}
              axisLine={false}
              tick={{
                fontSize: 12,
                fill: "hsl(220, 22%, 28%)",
              }}
            />
            <Bar dataKey="rate" radius={[0, 5, 5, 0]} isAnimationActive={false}>
              {chartData.map((d, i) => (
                <Cell
                  key={i}
                  fill={
                    d.rate >= 70
                      ? "hsl(152, 48%, 34%)"
                      : d.rate >= 50
                        ? "hsl(34, 46%, 50%)"
                        : "hsl(354, 64%, 46%)"
                  }
                />
              ))}
              <LabelList
                dataKey="rate"
                position="right"
                formatter={(v: number) => `${v}%`}
                style={{ fontSize: 12, fontWeight: 600, fill: "hsl(222, 50%, 10%)" }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[11px]" style={{ color: "hsl(var(--ink-muted))" }}>
        Green ≥ 70% (meeting CMS threshold) · gold 50–69% · rose &lt; 50%. Top{" "}
        {CHART_TOP_N} cohorts shown.
      </p>
    </section>
  );
}

function DetailTable({
  groups,
  groupingNoun,
}: {
  groups: TherapyUsageGroup[];
  groupingNoun: string;
}) {
  return (
    <section>
      <SectionTitle
        eyebrow="Cohort detail"
        title={`Therapy metrics by ${groupingNoun}`}
      />
      {groups.length === 0 ? (
        <p
          className="rounded-lg border border-dashed px-4 py-8 text-center text-sm"
          style={{ borderColor: "hsl(var(--line-2))", color: "hsl(var(--ink-3))" }}
        >
          No device-sourced therapy data in this window yet. As connected
          devices report, cohorts populate automatically.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  color: "hsl(var(--ink-3))",
                  borderBottom: "1.5px solid hsl(var(--penn-navy))",
                }}
              >
                <Th align="left">{titleCase(groupingNoun)}</Th>
                <Th>Patients</Th>
                <Th>CMS compliant</Th>
                <Th>Adherent nights</Th>
                <Th>Avg use</Th>
                <Th>Avg AHI</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr
                  key={g.key}
                  style={{
                    borderBottom: "1px solid hsl(var(--line-1))",
                    backgroundColor:
                      i % 2 === 1 ? "hsl(var(--surface-3) / 0.5)" : undefined,
                  }}
                >
                  <td className="py-2.5 pr-3">
                    <div
                      className="font-semibold"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {g.label}
                    </div>
                    {g.sublabel && (
                      <div
                        className="text-[11px]"
                        style={{ color: "hsl(var(--ink-muted))" }}
                      >
                        {g.sublabel}
                      </div>
                    )}
                  </td>
                  <Td>{g.patientCount.toLocaleString()}</Td>
                  <Td>
                    <ComplianceCell
                      rate={g.cmsComplianceRate}
                      count={g.cmsCompliantPatients}
                    />
                  </Td>
                  <Td>{pct(g.adherentNightRate)}</Td>
                  <Td>{hours(g.avgUsageHours)}</Td>
                  <Td>{num(g.avgAhi)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ComplianceCell({
  rate,
  count,
}: {
  rate: number | null;
  count: number;
}) {
  const color =
    rate == null
      ? "hsl(var(--ink-muted))"
      : rate >= 0.7
        ? "hsl(var(--tone-emerald))"
        : rate >= 0.5
          ? "hsl(var(--tone-amber))"
          : "hsl(var(--tone-rose))";
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-semibold tabular-nums" style={{ color }}>
        {pct(rate)}
      </span>
      <span className="text-[11px]" style={{ color: "hsl(var(--ink-muted))" }}>
        ({count})
      </span>
    </span>
  );
}

// ── capabilities (the "high-tech" marketing narrative) ──────────────

const CAPABILITIES = [
  {
    icon: CloudCog,
    title: "Connected therapy data, not guesswork",
    body: "We pull objective nightly data directly from the cloud platforms behind every major device — ResMed AirView, Philips Care Orchestrator, and 3B Medical. Usage, AHI, leak, and pressure are sourced from the machine itself, never self-reported.",
  },
  {
    icon: Activity,
    title: "Always-on adherence monitoring",
    body: "Every patient is scored against the CMS 4-hour / 70-percent standard the moment new data lands. A nightly sync surfaces anyone drifting out of compliance while there is still time to intervene.",
  },
  {
    icon: ShieldCheck,
    title: "Documentation that's audit-ready",
    body: "Compliance windows, adherence attestations, and prescription records are stitched together automatically — so the paperwork your billing depends on is complete and defensible without a scramble.",
  },
  {
    icon: HeartPulse,
    title: "Clinical eyes on the numbers that matter",
    body: "Rising AHI, high mask leak, or a sudden drop in usage are triaged to our respiratory team, who reach out before a struggling patient quietly abandons therapy.",
  },
  {
    icon: Truck,
    title: "Proactive, on-cadence resupply",
    body: "Replacement masks, cushions, and filters are timed to each patient's prescription cadence and confirmed by SMS — keeping equipment fresh, which is the single biggest driver of long-term adherence.",
  },
  {
    icon: Sparkles,
    title: "AI-assisted patient outreach",
    body: "A HIPAA-eligible AI layer handles routine check-ins and after-hours questions by voice and text, escalating anything clinical to a human — so patients always feel supported and never wait.",
  },
];

function CapabilitiesSection() {
  return (
    <section
      className="rounded-xl px-7 py-7"
      style={{ backgroundColor: "hsl(var(--surface-3) / 0.6)" }}
    >
      <SectionTitle
        eyebrow="How we deliver these results"
        title="A technology-first approach to compliance and patient care"
      />
      <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        {CAPABILITIES.map((c, i) => {
          const Icon = c.icon;
          return (
            <div key={c.title} className="flex gap-3.5">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                style={{
                  backgroundColor: "hsl(var(--penn-navy))",
                  color: "hsl(var(--penn-gold-soft))",
                }}
              >
                <Icon className="h-[18px] w-[18px]" />
              </div>
              <div>
                <div className="flex items-baseline gap-2">
                  <span
                    className="text-[11px] font-semibold tabular-nums"
                    style={{ color: "hsl(var(--penn-gold-deep))" }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h4
                    className="text-sm font-semibold leading-tight"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {c.title}
                  </h4>
                </div>
                <p
                  className="mt-1.5 text-[12.5px] leading-relaxed"
                  style={{ color: "hsl(var(--ink-2))" }}
                >
                  {c.body}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ReportFooter() {
  return (
    <footer
      className="flex flex-col gap-1 border-t pt-5 text-[11px]"
      style={{ borderColor: "hsl(var(--line-1))", color: "hsl(var(--ink-muted))" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span style={{ fontFamily: "var(--report-serif)", fontSize: "13px", color: "hsl(var(--penn-navy))" }}>
          PennFit · PennPAPs
        </span>
        <span>info@pennpaps.com</span>
      </div>
      <p>
        Confidential — prepared for the named referring practice. Metrics are
        derived from device-reported therapy data over the stated window;
        patient-level figures are de-identified. CMS compliance reflects ≥4
        hours of use on ≥70% of nights within a qualifying 30-day window.
      </p>
    </footer>
  );
}

// ── small primitives ────────────────────────────────────────────────

function SectionTitle({
  eyebrow,
  title,
}: {
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="mb-4">
      <div
        className="text-[10.5px] font-semibold uppercase"
        style={{ letterSpacing: "0.18em", color: "hsl(var(--penn-gold-deep))" }}
      >
        {eyebrow}
      </div>
      <h3
        className="mt-1"
        style={{
          fontFamily: "var(--report-serif)",
          fontSize: "1.3rem",
          fontWeight: 600,
          color: "hsl(var(--penn-navy))",
        }}
      >
        {title}
      </h3>
    </div>
  );
}

function Th({
  children,
  align = "right",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className="py-2 text-[11px] font-semibold uppercase"
      style={{
        letterSpacing: "0.06em",
        textAlign: align,
        paddingRight: align === "right" ? "0.75rem" : undefined,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      className="py-2.5 pr-3 text-right tabular-nums"
      style={{ color: "hsl(var(--ink-2))" }}
    >
      {children}
    </td>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-[11px] font-semibold uppercase"
        style={{ letterSpacing: "0.1em", color: "hsl(var(--ink-3))" }}
      >
        {label}
      </span>
      <div
        className="inline-flex rounded-full p-0.5"
        style={{ backgroundColor: "hsl(var(--surface-3))" }}
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
              style={{
                backgroundColor: active ? "hsl(var(--penn-navy))" : "transparent",
                color: active ? "white" : "hsl(var(--ink-2))",
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Scoped print rules + the editorial serif face and entrance keyframe.
 *  The visibility trick isolates the report from the admin shell so a
 *  browser "Save as PDF" yields a clean leave-behind. */
function ReportPrintStyles() {
  return (
    <style>{`
      #therapy-report {
        --report-serif: "Hoefler Text", "Iowan Old Style", "Palatino Linotype",
          "Palatino", "Georgia", "Times New Roman", serif;
      }
      @keyframes tr-rise {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media print {
        body * { visibility: hidden !important; }
        #therapy-report, #therapy-report * { visibility: visible !important; }
        #therapy-report {
          position: absolute !important;
          left: 0; top: 0; width: 100% !important;
          box-shadow: none !important;
          border: none !important;
          animation: none !important;
        }
        [data-print-hide] { display: none !important; }
        @page { margin: 0.5in; }
      }
    `}</style>
  );
}
