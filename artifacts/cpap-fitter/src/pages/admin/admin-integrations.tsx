// /admin/integrations — therapy-cloud vendor health dashboard.
//
// Shows each adapter (ResMed AirView, Philips Care Orchestrator,
// React Health) with:
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
import { useRef, useState } from "react";
import { Link } from "wouter";
import {
  CheckCircle2,
  HeartPulse,
  RefreshCw,
  ServerCog,
  TriangleAlert,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  getIntegrationErrors,
  getIntegrationsStatus,
  reconcileIntegration,
  triggerNightlySync,
  validateIntegrationConnection,
  type DiscrepancyKind,
  type IntegrationAdapterStatus,
  type PortalRow,
  type ReconcileResult,
  type ValidateConnectionResult,
  type ValidationStepName,
} from "@/lib/admin/integrations-status-api";
import { formatAppDateTime } from "@/lib/utils";

const queryKey = ["admin", "integrations", "status"] as const;

const SOURCE_LABELS: Record<IntegrationAdapterStatus["source"], string> = {
  resmed_airview: "ResMed AirView",
  philips_care: "Philips Care Orchestrator",
  react_health: "React Health (3B iCode)",
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
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            ResMed AirView, Philips Care Orchestrator, and React Health adapter
            health over the last 7 days.
          </p>
          <Link
            href="/admin/therapy-fleet"
            className="inline-flex items-center gap-1.5 text-sm mt-2 hover:underline"
            style={{ color: "hsl(var(--penn-navy))" }}
          >
            <HeartPulse className="h-4 w-4" /> View therapy fleet — compliance
            cohorts &amp; outreach worklist
          </Link>
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

      <ValidateConnectionCard />
      <ReconcileCard />
      <SyncErrorsCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validate a connection.
//
// Every endpoint path in these clients was written from published docs
// and has never been exercised against a live instance. Without this, the
// first real call happens inside the nightly sync at 04:30 across every
// linked patient — and there a wrong path shape is indistinguishable from
// "the vendor has no data for these patients": availability says
// configured, the fetch returns not_found, the job logs a count, and the
// practice believes it is monitoring people it is not.
// ---------------------------------------------------------------------------
function ValidateConnectionCard() {
  const [source, setSource] =
    useState<IntegrationAdapterStatus["source"]>("resmed_airview");
  const [patientId, setPatientId] = useState("");
  const [result, setResult] = useState<ValidateConnectionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await validateIntegrationConnection(source, patientId.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not run the check.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-1">Check a connection</h2>
      <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        Run one patient end to end — credentials, then a fetch, then the
        response shape — and see exactly which step fails. Use a patient you can
        see in the manufacturer&rsquo;s own portal, so a failure means
        something. Nothing is saved: this proves the connection, it does not
        import data.
      </p>

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <label className="text-sm">
          <span className="block text-xs mb-1">Vendor</span>
          <select
            value={source}
            onChange={(e) =>
              setSource(e.target.value as IntegrationAdapterStatus["source"])
            }
            className="px-2 py-1 rounded border text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {Object.entries(SOURCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm flex-1 min-w-[220px]">
          <span className="block text-xs mb-1">
            Their patient ID (from the portal)
          </span>
          <input
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            className="w-full px-2 py-1 rounded border text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
            placeholder="e.g. 4821-77"
          />
        </label>
        <Button
          intent="primary"
          isLoading={busy}
          disabled={patientId.trim() === ""}
          onClick={() => void run()}
          data-testid="integrations-validate-run"
        >
          Run check
        </Button>
      </div>

      {err && <ErrorPanel error={err} />}

      {result && (
        <div data-testid="integrations-validate-result" className="space-y-2">
          <ol className="text-sm space-y-1">
            {result.steps.map((step) => (
              <li key={step.name} className="flex items-start gap-2">
                <span
                  style={{
                    color:
                      step.status === "pass"
                        ? "#166534"
                        : step.status === "fail"
                          ? "#991b1b"
                          : "hsl(var(--ink-3))",
                  }}
                >
                  {step.status === "pass"
                    ? "✓"
                    : step.status === "fail"
                      ? "✕"
                      : "·"}
                </span>
                <span>
                  <strong>{STEP_LABELS[step.name]}</strong> — {step.detail}
                </span>
              </li>
            ))}
          </ol>
          {result.received && (
            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Came back:{" "}
              {result.received.settings
                ? "device settings"
                : "no device settings"}
              , {result.received.recentNights} night
              {result.received.recentNights === 1 ? "" : "s"},{" "}
              {result.received.supplies} supply item
              {result.received.supplies === 1 ? "" : "s"}. A connection that
              answers but returns nothing looks healthy on the dashboard — this
              is where you would see it.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

const STEP_LABELS: Record<ValidationStepName, string> = {
  configured: "Credentials set",
  authenticated: "Vendor accepted them",
  fetched: "Patient record returned",
  schema: "Response matches what we map",
};

// ---------------------------------------------------------------------------
// Reconcile against the manufacturer's portal.
//
// The only check in the system that is not a check against ourselves.
// diff-settings.ts compares our new snapshot to our own PREVIOUS snapshot,
// which by construction cannot notice a patient we never linked, nights we
// never received, or a device the portal swapped out.
// ---------------------------------------------------------------------------
function ReconcileCard() {
  const [source, setSource] =
    useState<IntegrationAdapterStatus["source"]>("resmed_airview");
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Left empty on purpose rather than defaulting to "the last 30 days":
  // guessing the window silently compares our nights against a period the
  // export may not cover, which is the failure this whole card exists to
  // catch. Empty means the comparison is skipped and says so.
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPick(file: File) {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const rows = parsePortalCsv(await file.text());
      if (rows.length === 0) {
        setErr(
          "No usable rows. The export needs a column of the vendor's patient IDs — anything named patient id, member id, or similar.",
        );
        return;
      }
      setResult(
        await reconcileIntegration(
          source,
          rows,
          windowStart && windowEnd
            ? { start: windowStart, end: windowEnd }
            : undefined,
        ),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-1">Reconcile against portal</h2>
      <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        Export the patient / compliance report from the manufacturer&rsquo;s
        portal and upload it here. Everything else we check compares our data to
        our own earlier data, which cannot tell you about a patient we never
        linked or nights we never received. This can.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={source}
          onChange={(e) =>
            setSource(e.target.value as IntegrationAdapterStatus["source"])
          }
          className="px-2 py-1 rounded border text-sm"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {Object.entries(SOURCE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          className="text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
          }}
          data-testid="integrations-reconcile-file"
        />
      </div>

      {/* The window the export covers. Without it the night and usage
          columns cannot be compared at all — our rolling history against
          their unstated period would flag the whole practice. */}
      <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
        <label className="flex items-center gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Export covers</span>
          <input
            type="date"
            value={windowStart}
            onChange={(e) => setWindowStart(e.target.value)}
            className="px-2 py-1 rounded border text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
            aria-label="Export window start"
          />
        </label>
        <label className="flex items-center gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>to</span>
          <input
            type="date"
            value={windowEnd}
            onChange={(e) => setWindowEnd(e.target.value)}
            className="px-2 py-1 rounded border text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
            aria-label="Export window end"
          />
        </label>
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Needed only to compare night counts and usage.
        </span>
      </div>

      {busy && <Spinner />}
      {err && <ErrorPanel error={err} />}

      {result && (
        <div data-testid="integrations-reconcile-result" className="space-y-2">
          {result.therapyComparison === "skipped_no_window" && (
            <p
              className="text-sm"
              role="status"
              style={{ color: "#92400e" }}
              data-testid="reconcile-therapy-skipped"
            >
              Night counts and usage were <strong>not</strong> compared: the
              export carries them but no date range was given. Set the window
              above and run it again — until then the zero below is only about
              patients and devices.
            </p>
          )}
          {result.therapyComparison === "unavailable" && (
            <p className="text-sm" role="status" style={{ color: "#92400e" }}>
              Night counts and usage were <strong>not</strong> compared: our own
              therapy data could not be read. Everything else below still
              stands.
            </p>
          )}
          <p className="text-sm">
            <strong>{result.portalRows}</strong> in the portal,{" "}
            <strong>{result.localRows}</strong> here,{" "}
            <strong>{result.matchedCount}</strong> matched.
          </p>
          <ul className="text-sm space-y-1">
            <li
              style={{
                color: result.missingLocallyCount > 0 ? "#991b1b" : undefined,
              }}
            >
              <strong>{result.missingLocallyCount}</strong> in the portal that
              we are not tracking
              {result.missingLocallyCount > 0 &&
                " — these patients are not being monitored here. Start with these."}
            </li>
            <li>
              <strong>{result.missingInPortalCount}</strong> we hold that the
              portal no longer lists
            </li>
            <li>
              <strong>{result.mismatchedCount}</strong> where the data disagrees
            </li>
          </ul>

          {DISCREPANCY_ORDER.map((kind) => {
            const bucket = result.discrepancies[kind];
            if (!bucket || bucket.count === 0) return null;
            return (
              <details key={kind} className="text-xs">
                <summary className="cursor-pointer">
                  {DISCREPANCY_LABELS[kind]} ({bucket.count})
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {bucket.sample.map((d, i) => (
                    <li key={i}>
                      {d.partnerPatientId}
                      {d.portal !== undefined || d.local !== undefined
                        ? ` — portal: ${d.portal ?? "—"}, here: ${d.local ?? "—"}`
                        : ""}
                    </li>
                  ))}
                  {bucket.count > bucket.sample.length && (
                    <li style={{ color: "hsl(var(--ink-3))" }}>
                      …and {bucket.count - bucket.sample.length} more
                    </li>
                  )}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </Card>
  );
}

const DISCREPANCY_ORDER: DiscrepancyKind[] = [
  "missing_locally",
  "night_count_mismatch",
  "usage_mismatch",
  "device_serial_mismatch",
  "missing_in_portal",
];

const DISCREPANCY_LABELS: Record<DiscrepancyKind, string> = {
  missing_locally: "Not tracked here",
  missing_in_portal: "No longer in the portal",
  device_serial_mismatch: "Different device",
  night_count_mismatch: "Different night count",
  usage_mismatch: "Different average usage",
};

/**
 * Pull the columns we need out of whatever the vendor's export looks
 * like. Header matching is deliberately loose — every portal names these
 * differently, and asking an operator to rename columns before they can
 * run a health check is how a health check goes unrun.
 *
 * Rows with no recognisable patient id are skipped rather than sent: the
 * server would have nothing to match them on.
 */
function parsePortalCsv(text: string): PortalRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!).map((h) =>
    h.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  const find = (...names: string[]) =>
    headers.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const idIdx = find(
    "patientid",
    "memberid",
    "partnerpatientid",
    "patientnumber",
    "serialnumberpatient",
  );
  if (idIdx < 0) return [];
  const serialIdx = find("deviceserial", "serialnumber", "devicesn", "serial");
  const nightsIdx = find(
    "nightswithusage",
    "daysused",
    "nightsused",
    "usagedays",
  );
  const usageIdx = find(
    "averageusage",
    "avgusage",
    "meanusage",
    "usageminutes",
  );

  const rows: PortalRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const id = (cells[idIdx] ?? "").trim();
    if (!id) continue;
    rows.push({
      partnerPatientId: id,
      deviceSerial:
        serialIdx >= 0 ? (cells[serialIdx] ?? "").trim() || null : null,
      nightsWithUsage: nightsIdx >= 0 ? toNumber(cells[nightsIdx]) : null,
      avgUsageMinutes: usageIdx >= 0 ? toUsageMinutes(cells[usageIdx]) : null,
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  // Enough CSV for a portal export: quoted fields with embedded commas.
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toNumber(raw: string | undefined): number | null {
  const n = Number.parseFloat((raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Portals report average usage as either minutes or "7:24"-style
 * hours:minutes. Reading "7:24" as 7 minutes would flag every compliant
 * patient in the practice as a discrepancy.
 */
function toUsageMinutes(raw: string | undefined): number | null {
  const v = (raw ?? "").trim();
  const hm = /^(\d+):(\d{1,2})$/.exec(v);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const n = toNumber(v);
  if (n == null) return null;
  // A bare decimal under 24 is hours, not minutes: nobody averages 7
  // minutes a night and a portal reporting 7.4 means 7h24.
  return n > 0 && n < 24 ? Math.round(n * 60) : n;
}

// ---------------------------------------------------------------------------
// Recent sync failures. The route has existed for a while with no page
// behind it, so these were only visible in the logs.
// ---------------------------------------------------------------------------
function SyncErrorsCard() {
  const query = useQuery({
    queryKey: ["admin", "integrations", "errors"],
    queryFn: getIntegrationErrors,
    staleTime: 60_000,
  });

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-1">Recent sync failures</h2>
      <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        Patients whose last refresh failed, over the past 30 days.
      </p>
      {query.isPending && <Spinner />}
      {query.error && <ErrorPanel error={query.error} />}
      {query.data &&
        (query.data.errors.length === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            None — every active link refreshed cleanly.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left border-b"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <th className="py-2 font-semibold">Vendor</th>
                  <th className="py-2 font-semibold">Their patient ID</th>
                  <th className="py-2 font-semibold">Error</th>
                  <th className="py-2 font-semibold">When</th>
                </tr>
              </thead>
              <tbody>
                {query.data.errors.slice(0, 50).map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="py-1.5">{SOURCE_LABELS[row.source]}</td>
                    <td className="py-1.5">{row.partnerPatientId ?? "—"}</td>
                    <td className="py-1.5">{row.fetchError ?? "—"}</td>
                    <td className="py-1.5">
                      {row.fetchedAt
                        ? new Date(row.fetchedAt).toLocaleDateString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Card>
  );
}

function AdapterTable({ adapters }: { adapters: IntegrationAdapterStatus[] }) {
  if (adapters.length === 0) {
    return (
      <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
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
          <th scope="col" className="py-2 font-semibold">
            Vendor
          </th>
          <th scope="col" className="py-2 font-semibold">
            Availability
          </th>
          <th scope="col" className="py-2 font-semibold">
            Last 7d
          </th>
          <th scope="col" className="py-2 font-semibold">
            Top errors
          </th>
          <th scope="col" className="py-2 font-semibold">
            Last refresh
          </th>
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
      <td className="py-2 font-medium">{SOURCE_LABELS[adapter.source]}</td>
      <td className="py-2">
        <AvailabilityBadge status={availStatus} />
        {availStatus !== "configured" && (
          <span className="ml-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
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
          ? formatAppDateTime(adapter.lastFetchedAt)
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
      {status === "configured" && <CheckCircle2 className="h-3 w-3 mr-1" />}
      {s.label}
    </span>
  );
}
