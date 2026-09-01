// "Lifecycle health" — is the resupply loop actually working?
//
// The expensive failures in this platform are the quiet ones: product
// shipped and never billed, cycles advanced with no evidence anything
// left the warehouse, a sweep that stopped and errored nowhere. None of
// them raises an exception, and none of them belongs to a single
// subsystem, so none of them appears on any other screen.
//
// FOUR ANSWERS THAT ARE NOT "FINE"
// --------------------------------
// The panel's whole job is to keep these apart:
//
//   ok              measured, inside threshold
//   disabled        this tenant does not use the feature — nothing to
//                   measure, nothing wrong
//   not configured  the feature exists but nothing is set up, so the
//                   true value is UNKNOWN. Rendering zero would be a
//                   claim we cannot support.
//   unknown         the read failed. An outage in the monitor, not a
//                   quiet day in the business.
//
// Collapsing any of them into a green zero is the single change that
// would make this panel lie, so each gets its own badge and its own
// sentence.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Activity, AlertTriangle, HelpCircle } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchLifecycleHealth,
  type LifecycleSignalRow,
  type SignalStatus,
} from "@/lib/admin/lifecycle-health-api";

const STATUS_STYLE: Record<
  SignalStatus,
  { label: string; colour: string; background: string }
> = {
  failure: { label: "Failing", colour: "#991b1b", background: "#fee2e2" },
  warning: { label: "Warning", colour: "#92400e", background: "#fef3c7" },
  ok: { label: "OK", colour: "#166534", background: "#dcfce7" },
  disabled: { label: "Not used", colour: "#475569", background: "#f1f5f9" },
  not_configured: {
    label: "Not set up",
    colour: "#475569",
    background: "#f1f5f9",
  },
  unknown: { label: "Unreadable", colour: "#5b21b6", background: "#ede9fe" },
};

/** Why a row is not showing a number. One sentence, per state. */
function quietExplanation(row: LifecycleSignalRow): string | null {
  if (row.status === "disabled")
    return row.reason ?? "This practice does not use the feature this watches.";
  if (row.status === "not_configured")
    return (
      row.reason ??
      "Nothing is set up for this yet, so the real number is unknown — not zero."
    );
  if (row.status === "unknown")
    return (
      row.reason ??
      "We could not read this just now. This is an outage in the monitor, not an empty queue."
    );
  return null;
}

function ageLabel(hours: number | null): string {
  if (hours === null) return "";
  if (hours < 1) return "just now";
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function LifecycleHealthPanel() {
  const query = useQuery({
    queryKey: ["admin", "lifecycle-health"],
    queryFn: fetchLifecycleHealth,
    staleTime: 60_000,
  });

  const data = query.data;
  // Only the rows that need attention, plus the ones that cannot answer.
  // The healthy majority is counted in the footer rather than listed —
  // twenty green rows is how the two red ones get missed.
  const interesting =
    data?.signals.filter((s) => s.status !== "ok" && s.status !== "disabled") ??
    [];

  return (
    <Card
      title={
        <span className="flex items-center gap-2 font-semibold">
          <Activity className="h-4 w-4" /> Lifecycle health
        </span>
      }
    >
      <p className="text-xs mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        The quiet failures — product shipped and never billed, cycles advanced
        with no shipment evidence, a sweep that stopped without erroring.
        Nothing here changes anything.
      </p>

      {query.isPending && <Spinner />}
      {query.error && <ErrorPanel error={query.error} />}

      {data && (
        <>
          {data.lastScanAgeHours !== null && data.lastScanAgeHours > 6 && (
            // A panel that renders perfectly while nothing has scanned
            // for a day is the exact false comfort this exists to remove.
            <p
              className="text-xs mb-3 flex items-start gap-1.5"
              style={{ color: "#92400e" }}
            >
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              The background scan last reported{" "}
              {ageLabel(data.lastScanAgeHours)}. Rows below are measured live,
              but anything marked &ldquo;from last scan&rdquo; is that old.
            </p>
          )}

          {interesting.length === 0 ? (
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              Nothing needs attention. {data.totals.ok} signals measured and
              inside threshold
              {data.totals.disabled > 0
                ? `, ${data.totals.disabled} not used by this practice`
                : ""}
              .
            </p>
          ) : (
            <ul className="space-y-2">
              {interesting.map((row) => {
                const style = STATUS_STYLE[row.status];
                const quiet = quietExplanation(row);
                return (
                  <li
                    key={row.key}
                    className="flex items-start justify-between gap-3 border-t pt-2 first:border-t-0 first:pt-0"
                  >
                    <div className="min-w-0">
                      <Link
                        href={row.href}
                        className="text-sm font-medium hover:underline"
                        style={{ color: "hsl(var(--penn-navy))" }}
                      >
                        {row.label}
                      </Link>
                      <p
                        className="text-xs mt-0.5"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {quiet ?? row.why}
                      </p>
                      {row.truncated && (
                        // An understated backlog that looks precise is
                        // worse than one that admits it is partial.
                        <p
                          className="text-xs mt-0.5 italic"
                          style={{ color: "#92400e" }}
                        >
                          This read hit its row cap, so the number is a floor —
                          the real one is larger.
                        </p>
                      )}
                      {row.withheld === "insufficient_sample" && (
                        <p
                          className="text-xs mt-0.5 italic"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          Too small a population to judge yet, so nothing is
                          being raised on it.
                        </p>
                      )}
                      {row.fromLastScan && (
                        <p
                          className="text-xs mt-0.5 italic"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          From the last background scan (
                          {ageLabel(row.lastScanAgeHours)}), not measured just
                          now.
                        </p>
                      )}
                      {row.alertOpen && row.alertOpenHours !== null && (
                        <p
                          className="text-xs mt-0.5"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          Alerting for{" "}
                          {ageLabel(row.alertOpenHours)
                            .replace(" ago", "")
                            .trim()}
                          {row.alertPeakStatus === "failure" &&
                          row.status === "warning"
                            ? " — improving, but it was a failure"
                            : ""}
                          .
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <span
                        className="text-sm font-semibold tabular-nums"
                        style={{ color: style.colour }}
                        // Both a quiet row and a healthy row can show a
                        // dash. They are not the same dash, and only some
                        // of them are a reason to do anything.
                        title={quiet ?? undefined}
                      >
                        {row.display}
                      </span>
                      <div
                        className="mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{
                          color: style.colour,
                          backgroundColor: style.background,
                        }}
                      >
                        {style.label}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p
            className="text-xs mt-3 flex items-start gap-1.5"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            <HelpCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              {data.totals.signalCount} signals watched.{" "}
              {data.totals.notConfigured > 0 && (
                <>
                  {data.totals.notConfigured} have nothing set up (their real
                  value is unknown, not zero).{" "}
                </>
              )}
              {data.totals.unknown > 0 && (
                <>{data.totals.unknown} could not be read just now. </>
              )}
              Two further signals cover events that belong to no practice and
              are reported to the platform operator instead.
            </span>
          </p>
        </>
      )}
    </Card>
  );
}
