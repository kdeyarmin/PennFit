// Patient-detail "Device data" snapshot rendering — extracted from
// patient-detail.tsx.
//
// One IntegrationSourceCard per configured therapy cloud (ResMed
// AirView, Philips Care Orchestrator, React Health): availability /
// link badges, the Refresh action, and the cached snapshot body
// (device settings, compliance, supplies, therapy trend sparklines,
// last-7-nights table).
//
// The data fetching + refresh mutation stay in the page's
// IntegrationsTab; this file is purely presentational. The private
// Sparkline here is the local dependency-free SVG variant (values /
// threshold / color) — distinct from components/admin/Sparkline.

import {
  formatSourceLabel,
  type ComplianceSummary,
  type DeviceSettings,
  type IntegrationSnapshotPayload,
  type IntegrationSourceView,
  type SupplyItem,
  type TherapyNight,
} from "@/lib/admin/patient-integrations-api";
import { Badge, humanizeStatus } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { formatDate, formatDateTime } from "@/lib/admin/format";

export function IntegrationSourceCard({
  view,
  refreshing,
  onRefresh,
}: {
  view: IntegrationSourceView;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { source, availability, link, snapshot } = view;
  const linked = link !== null;
  const canRefresh = linked && !refreshing;

  return (
    <div
      className="rounded-lg border p-4 space-y-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            className="text-base font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {formatSourceLabel(source)}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <Badge
              variant={
                availability.status === "configured"
                  ? "success"
                  : availability.status === "stub"
                    ? "warning"
                    : "danger"
              }
            >
              {availability.status === "configured"
                ? "Configured"
                : availability.status === "stub"
                  ? availability.reason === "stub_mode"
                    ? "Stub mode"
                    : "No credentials"
                  : `Unavailable: ${availability.reason}`}
            </Badge>
            {link && (
              <Badge variant={link.status === "active" ? "info" : "muted"}>
                Link {link.status}
              </Badge>
            )}
            {!link && <Badge variant="muted">No link</Badge>}
            {snapshot && (
              <span style={{ color: "hsl(var(--ink-3))" }}>
                Cached {formatDateTime(snapshot.fetchedAt)}
              </span>
            )}
          </div>
        </div>
        <Button
          intent="secondary"
          onClick={onRefresh}
          disabled={!canRefresh}
          title={
            !linked
              ? "Create an active link before refreshing."
              : refreshing
                ? "Refresh in progress…"
                : "Pull the latest data from the partner."
          }
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {!snapshot ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No data fetched yet. Click Refresh to pull from the partner.
        </p>
      ) : (
        <IntegrationSnapshotBody snapshot={snapshot.payload} />
      )}
    </div>
  );
}

function IntegrationSnapshotBody({
  snapshot,
}: {
  snapshot: IntegrationSnapshotPayload;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <TherapyTrendBlock nights={snapshot.recentNights} />
      <SettingsBlock settings={snapshot.settings} />
      <ComplianceBlock compliance={snapshot.compliance} />
      <SuppliesBlock supplies={snapshot.supplies} />
      <RecentNightsBlock nights={snapshot.recentNights} />
    </div>
  );
}

function SettingsBlock({ settings }: { settings: DeviceSettings | null }) {
  return (
    <div>
      <h4
        className="text-xs uppercase tracking-wider font-semibold mb-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        Device & settings
      </h4>
      {!settings ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Not reported.
        </p>
      ) : (
        <dl className="text-sm grid grid-cols-2 gap-x-3 gap-y-1">
          <Term label="Model" value={settings.deviceModel} />
          <Term label="Serial" value={settings.deviceSerial} />
          <Term label="Mode" value={settings.therapyMode} />
          <Term label="Mask" value={settings.maskType} />
          <Term
            label="Pressure"
            value={
              settings.pressureMinCmh2o !== null &&
              settings.pressureMaxCmh2o !== null
                ? `${settings.pressureMinCmh2o}–${settings.pressureMaxCmh2o} cm H₂O`
                : null
            }
          />
          <Term
            label="Ramp"
            value={
              settings.rampMinutes !== null
                ? `${settings.rampMinutes} min`
                : null
            }
          />
          <Term
            label="Humidifier"
            value={
              settings.humidifierLevel !== null
                ? `Level ${settings.humidifierLevel}`
                : null
            }
          />
        </dl>
      )}
    </div>
  );
}

function ComplianceBlock({
  compliance,
}: {
  compliance: ComplianceSummary | null;
}) {
  return (
    <div>
      <h4
        className="text-xs uppercase tracking-wider font-semibold mb-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        Compliance
      </h4>
      {!compliance ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Not reported.
        </p>
      ) : (
        <dl className="text-sm grid grid-cols-2 gap-x-3 gap-y-1">
          <Term label="Window" value={`${compliance.windowDays} nights`} />
          <Term
            label="Days with data"
            value={String(compliance.daysWithData)}
          />
          <Term
            label="≥ 4 hr nights"
            value={String(compliance.daysOver4Hours)}
          />
          <Term
            label="Avg usage"
            value={
              compliance.averageUsageMinutes !== null
                ? `${(compliance.averageUsageMinutes / 60).toFixed(1)} hr`
                : null
            }
          />
          <Term
            label="Avg AHI"
            value={
              compliance.averageAhi !== null
                ? compliance.averageAhi.toFixed(1)
                : null
            }
          />
          <div className="col-span-2 mt-1">
            <Badge
              variant={compliance.meetsCmsCompliance ? "success" : "warning"}
            >
              {compliance.meetsCmsCompliance
                ? "Meets CMS 90/30"
                : "Does not meet CMS 90/30"}
            </Badge>
          </div>
        </dl>
      )}
    </div>
  );
}

function SuppliesBlock({ supplies }: { supplies: SupplyItem[] }) {
  return (
    <div>
      <h4
        className="text-xs uppercase tracking-wider font-semibold mb-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        Supplies on file
      </h4>
      {supplies.length === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No supplies reported by partner.
        </p>
      ) : (
        <ul className="text-sm space-y-1">
          {supplies.map((s, i) => (
            <li key={i}>
              <div style={{ color: "hsl(var(--ink-1))" }}>{s.description}</div>
              <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                {humanizeStatus(s.category)}
                {s.lastReplacedDate
                  ? ` · last ${formatDate(s.lastReplacedDate)}`
                  : ""}
                {s.nextEligibleDate
                  ? ` · next ${formatDate(s.nextEligibleDate)}`
                  : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Full-width therapy trend over the snapshot's recent nights — usage,
// AHI, and leak sparklines with the clinical threshold drawn in. Gives
// the CSR an at-a-glance "is this patient trending up or down?" read
// that the 7-night table can't. Dependency-free SVG (no chart lib) so
// it renders crisply inside the Device Data grid cell.
function TherapyTrendBlock({ nights }: { nights: TherapyNight[] }) {
  // Snapshot nights arrive newest-first; chart oldest → newest.
  const chrono = [...nights].sort((a, b) =>
    a.nightDate.localeCompare(b.nightDate),
  );
  if (chrono.length < 2) return null;
  const usageHours = chrono.map((n) =>
    n.usageMinutes !== null ? n.usageMinutes / 60 : null,
  );
  const ahi = chrono.map((n) => n.ahi);
  const leak = chrono.map((n) => n.leakRateLMin);
  return (
    <div className="md:col-span-2">
      <h4
        className="text-xs uppercase tracking-wider font-semibold mb-2"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        Trend · last {chrono.length} nights
      </h4>
      <div className="grid gap-4 sm:grid-cols-3">
        <TrendMini
          label="Usage"
          unit="h"
          values={usageHours}
          threshold={4}
          color="hsl(var(--penn-navy))"
          digits={1}
        />
        <TrendMini
          label="AHI"
          values={ahi}
          threshold={5}
          color="hsl(354 75% 50%)"
          digits={1}
        />
        <TrendMini
          label="Leak"
          unit="L/min"
          values={leak}
          threshold={24}
          color="hsl(38 95% 45%)"
          digits={0}
        />
      </div>
    </div>
  );
}

function TrendMini({
  label,
  unit,
  values,
  threshold,
  color,
  digits,
}: {
  label: string;
  unit?: string;
  values: Array<number | null>;
  threshold: number;
  color: string;
  digits: number;
}) {
  const present = values.filter((v): v is number => v !== null);
  const latest = [...values].reverse().find((v): v is number => v !== null);
  const avg =
    present.length > 0
      ? present.reduce((a, b) => a + b, 0) / present.length
      : null;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {label}
        </span>
        <span
          className="text-sm font-semibold tabular-nums"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {latest !== undefined ? latest.toFixed(digits) : "—"}
          {unit ? <span className="text-xs font-normal"> {unit}</span> : null}
        </span>
      </div>
      <Sparkline values={values} threshold={threshold} color={color} />
      <p className="text-[10px] mt-0.5" style={{ color: "hsl(var(--ink-3))" }}>
        avg {avg !== null ? avg.toFixed(digits) : "—"} · threshold {threshold}
      </p>
    </div>
  );
}

// Minimal SVG sparkline. Plots non-null points (connecting across gaps),
// scaled to fit, with a dashed reference line at `threshold`.
// vector-effect keeps strokes crisp despite the responsive viewBox.
function Sparkline({
  values,
  threshold,
  color,
  height = 40,
}: {
  values: Array<number | null>;
  threshold?: number;
  color: string;
  height?: number;
}) {
  const width = 200;
  const pad = 2;
  const pts = values
    .map((v, i) => ({ i, v }))
    .filter((p): p is { i: number; v: number } => p.v !== null);
  if (pts.length === 0) {
    return (
      <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        No data.
      </p>
    );
  }
  const span = values.length - 1 || 1;
  const vals = pts.map((p) => p.v);
  let lo = Math.min(...vals, threshold ?? Infinity);
  let hi = Math.max(...vals, threshold ?? -Infinity);
  if (hi === lo) hi = lo + 1;
  const x = (i: number) => pad + (i / span) * (width - 2 * pad);
  const y = (v: number) =>
    height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);
  const d = pts
    .map(
      (p, k) =>
        `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`,
    )
    .join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      className="w-full"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="therapy trend sparkline"
    >
      {threshold !== undefined && (
        <line
          x1={pad}
          x2={width - pad}
          y1={y(threshold)}
          y2={y(threshold)}
          stroke="hsl(var(--ink-3))"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          opacity={0.5}
        />
      )}
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={x(last.i)} cy={y(last.v)} r={2.5} fill={color} />
    </svg>
  );
}

function RecentNightsBlock({ nights }: { nights: TherapyNight[] }) {
  const last7 = nights.slice(0, 7);
  return (
    <div>
      <h4
        className="text-xs uppercase tracking-wider font-semibold mb-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        Last 7 nights
      </h4>
      {last7.length === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No night data.
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead style={{ color: "hsl(var(--ink-3))" }}>
            <tr>
              <th className="text-left font-normal pb-1">Date</th>
              <th className="text-right font-normal pb-1">Use</th>
              <th className="text-right font-normal pb-1">AHI</th>
              <th className="text-right font-normal pb-1">Leak</th>
              <th className="text-right font-normal pb-1">P95</th>
            </tr>
          </thead>
          <tbody style={{ color: "hsl(var(--ink-1))" }}>
            {last7.map((n) => (
              <tr key={n.nightDate}>
                <td>{formatDate(n.nightDate)}</td>
                <td className="text-right">
                  {n.usageMinutes !== null
                    ? `${(n.usageMinutes / 60).toFixed(1)}h`
                    : "—"}
                </td>
                <td className="text-right">
                  {n.ahi !== null ? n.ahi.toFixed(1) : "—"}
                </td>
                <td className="text-right">
                  {n.leakRateLMin !== null ? n.leakRateLMin.toFixed(0) : "—"}
                </td>
                <td className="text-right">
                  {n.pressureP95Cmh2o !== null
                    ? n.pressureP95Cmh2o.toFixed(1)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Term({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        {label}
      </dt>
      <dd style={{ color: "hsl(var(--ink-1))" }}>{value ?? "—"}</dd>
    </>
  );
}
