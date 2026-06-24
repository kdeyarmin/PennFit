import { Link } from "wouter";
import {
  Activity,
  BellRing,
  CircleDollarSign,
  FileSpreadsheet,
  Gauge,
  LineChart,
  Mailbox,
  PieChart,
  Smile,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Analytics & business intelligence deep-dive.
 *
 * The owner's decision-making cockpit. The platform ships 10+ analytics
 * surfaces but the marketing site only mentions KPIs in passing. This page
 * is the "run the business on live signal, not last month's export" story:
 * the dashboard families, the alerts that page you before a number slips, and
 * the exports. Grounds claims in shipped routes (`routes/admin/analytics.ts`,
 * `analytics-revenue-by-source.ts`, `analytics-margin.ts`,
 * `acquisition-funnel.ts`, `ltv-cac.ts`, `analytics-channel-engagement.ts`,
 * `analytics-outreach-attribution.ts`, `nps-summary.ts`, `kpi-alerts.ts`,
 * `metric-thresholds.ts`, and exports via `lib/quickbooks-export.ts` +
 * `routes/admin/reports/`).
 *
 * Reuses the shared chrome and the namespaced `.bx-*` design system — no new
 * CSS, inherits the apex-gated `noindex`, lazy-loaded off the patient bundle.
 */

/* ── The dashboard families ── */
type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const DASHBOARDS: Cap[] = [
  {
    icon: <CircleDollarSign size={20} />,
    title: "Revenue & payer mix",
    summary: "Where the money comes from — and how it's trending.",
    points: [
      "Revenue by payer and by month, with concentration risk in view",
      "Collections forecast on the same live data",
      "Spot a payer growing or slipping before it shows up in the bank",
    ],
    gold: true,
  },
  {
    icon: <PieChart size={20} />,
    title: "Margin & profitability",
    summary: "Know which products and payers actually make money.",
    points: [
      "Product-level margin from contracted fee schedules vs cost",
      "Payer profitability trended over time",
      "Surface the loss-leaders before they dominate volume",
    ],
  },
  {
    icon: <Activity size={20} />,
    title: "Resupply funnel",
    summary: "See exactly where reorders convert — and where they leak.",
    points: [
      "Connection → confirmation → fulfillment → paid, stage by stage",
      "Configurable windows so you can compare period over period",
      "Pinpoint the step that's costing you capture",
    ],
  },
  {
    icon: <Target size={20} />,
    title: "Acquisition & LTV/CAC",
    summary: "Measure growth, not just activity.",
    points: [
      "New-patient funnel from lead to first and second order",
      "Lifetime value against cost to acquire, with payback period",
      "Cohorts by signup month and source",
    ],
  },
  {
    icon: <Mailbox size={20} />,
    title: "Channel & campaign ROI",
    summary: "Know which outreach actually drives orders.",
    points: [
      "Orders attributed by channel — web, SMS, email, voice, CSR",
      "Campaign ROI: cost to send against revenue lifted",
      "Double down on what converts, cut what doesn't",
    ],
  },
  {
    icon: <Smile size={20} />,
    title: "NPS & satisfaction",
    summary: "A steady read on how patients feel.",
    points: [
      "Post-order NPS aggregated monthly, with verbatim comments",
      "Filter by product and payer to find the friction",
      "Catch detractors early enough to win them back",
    ],
    gold: true,
  },
];

function Dashboards() {
  return (
    <section className="bx-section" id="dashboards">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <LineChart size={13} /> The dashboards
          </span>
          <h2 className="bx-h2">Run the business on live signal</h2>
          <p className="bx-lede">
            Not last month's spreadsheet export. Because every workflow runs on
            one platform, the numbers are live and they connect — revenue,
            margin, the resupply funnel, acquisition, channel ROI, and
            satisfaction, all on the same patient data, no reconciling across
            tools.
          </p>
        </div>
        <div className="bx-caps">
          {DASHBOARDS.map((c) => (
            <article
              className={`bx-cap bx-reveal${c.gold ? " gold" : ""}`}
              key={c.title}
            >
              <div className="bx-cap-head">
                <span className="bx-cap-ic">{c.icon}</span>
                <div>
                  <h3>{c.title}</h3>
                  <p className="bx-cap-summary">{c.summary}</p>
                </div>
              </div>
              <ul className="bx-cap-list">
                {c.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Alerts & digests ── */
const SIGNALS: {
  icon: React.ReactNode;
  metric: string;
  metricSub: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <BellRing size={22} />,
    metric: "Alerts",
    metricSub: "before it slips",
    title: "The number pages you, not the other way around",
    gold: true,
    body: "Set thresholds on the metrics that matter — denial rate, delivery rate, capture, DSO — and Breathe emails your team the moment one crosses the line, instead of you finding out in next month's review.",
  },
  {
    icon: <TrendingUp size={22} />,
    metric: "Weekly",
    metricSub: "owner digest",
    title: "Monday's numbers, in your inbox",
    body: "A weekly digest lands automatically with the week's headline metrics and what moved — so you stay on top of the business without logging in to build a report.",
  },
  {
    icon: <Users size={22} />,
    metric: "Live",
    metricSub: "team load",
    title: "See how the team is actually doing",
    body: "CSR productivity and live staffing load show throughput, response times, and where work is piling up — so you can staff to reality, not to a guess.",
  },
];

function Signals() {
  return (
    <section className="bx-section bx-section-tight" id="signals">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Gauge size={13} /> Alerts & digests
          </span>
          <h2 className="bx-h2">The dashboard watches itself</h2>
          <p className="bx-lede">
            Nobody has time to stare at charts all day. Breathe pages you when a
            number slips, drops a weekly digest in your inbox, and keeps live
            tabs on team load — so the business runs on signal, not vigilance.
          </p>
        </div>
        <div className="bx-pillars">
          {SIGNALS.map((p) => (
            <article
              className={`bx-pillar bx-reveal${p.gold ? " gold" : ""}`}
              key={p.title}
            >
              <div className="bx-pillar-top">
                <span className="bx-pillar-ic">{p.icon}</span>
                <span className="bx-pillar-metric">
                  <b>{p.metric}</b>
                  <small>{p.metricSub}</small>
                </span>
              </div>
              <h3 className="bx-pillar-title">{p.title}</h3>
              <p className="bx-pillar-body">{p.body}</p>
            </article>
          ))}
        </div>
        <p className="bx-stats-note bx-reveal">
          <FileSpreadsheet
            size={14}
            aria-hidden="true"
            style={{ verticalAlign: "-2px", marginRight: 6 }}
          />
          Your data stays yours: export any view to spreadsheet (CSV) or PDF,
          push a GL-coded feed to QuickBooks, and save report presets you reuse
          every week.{" "}
          <Link href="/breathe/roi">Size the upside on your numbers →</Link>
        </p>
      </div>
    </section>
  );
}

export function BreatheAnalytics() {
  useDocumentTitle(
    "Analytics & reporting — Breathe by CareMetric.ai",
    "Breathe runs your DME business on live signal: revenue and payer-mix, margin and profitability, the resupply funnel, acquisition and LTV/CAC, channel and campaign ROI, and NPS — plus KPI alerts, a weekly owner digest, and CSV / PDF / QuickBooks exports.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={LineChart}
        eyebrow="Analytics"
        title={
          <>
            Run the business on <span className="grad-em">live signal.</span>
          </>
        }
        sub="Revenue, margin, the resupply funnel, acquisition, channel ROI, and satisfaction — every workflow on one platform means the numbers are live and they connect. Plus alerts that page you before a metric slips, a weekly owner digest, and exports to the tools you already use."
      />
      <Dashboards />
      <Signals />
      <ClosingCta />
    </BreatheShell>
  );
}
