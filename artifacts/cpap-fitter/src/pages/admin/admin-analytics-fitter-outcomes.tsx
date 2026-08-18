// /admin/analytics/fitter-outcomes — is the mask fitter actually working?
//
// Four questions, in the order a DME owner asks them:
//   1. How often does a mask we fitted come back as a bad fit?
//   2. Do our clinicians agree with what the engine picked?
//   3. Are the scans good enough for the engine to be confident?
//   4. Which specific masks are causing the refits?
//
// EVERY RATE HERE CAN BE NULL, and null is not zero. "No fitting came
// back as a bad fit" and "nobody has reported anything yet" are different
// facts, and an empty dashboard rendering as 0% would read as a perfect
// score. Null renders as "—" with a "no data yet" caption.
//
// clinical.read-gated server-side; nav gated to match.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Label, Select } from "@/components/admin/Input";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchFitterOutcomes,
  type FitSessionOutcome,
  type FitterOutcomesReport,
} from "@/lib/admin/analytics-fitter-outcomes-api";

const QUERY_KEY = ["admin", "analytics", "fitter-outcomes"] as const;

const WINDOWS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last 12 months" },
];

const OUTCOME_LABEL: Record<FitSessionOutcome, string> = {
  high_confidence: "High confidence",
  moderate_confidence: "Moderate confidence",
  low_confidence: "Low confidence",
  contraindicated: "Contraindicated",
  outside_validated_range: "Outside validated range",
};

const ENTRY_LABEL: Record<string, string> = {
  remote_link: "Remote link",
  in_office: "In office",
  kiosk_qr: "Kiosk QR",
};

/** A percentage, or an em dash when there is no denominator yet. */
function pct(rate: number | null): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function hours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export function AdminAnalyticsFitterOutcomesPage() {
  const [days, setDays] = useState("90");

  const q = useQuery({
    queryKey: [...QUERY_KEY, days],
    queryFn: () => fetchFitterOutcomes(Number(days)),
  });

  const report: FitterOutcomesReport | undefined = q.data?.report;
  const truncated = q.data?.truncated;

  return (
    <div className="admin-root space-y-4">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Activity size={20} aria-hidden="true" />
          Fitter outcomes
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          How the mask fitter is performing: how often a fitted mask comes back
          as a bad fit, whether clinicians accept the engine&apos;s pick, and
          whether scans are good enough for it to be confident. These are your
          own measured numbers — use them rather than a vendor&apos;s claim.
        </p>
      </header>

      <Card>
        <div className="p-4 flex flex-wrap gap-3 items-end">
          <div className="min-w-[200px]">
            <Label htmlFor="fitter-outcomes-window">Period</Label>
            <Select
              id="fitter-outcomes-window"
              options={WINDOWS}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
        </div>
      </Card>

      {q.isLoading ? <Spinner /> : null}
      {q.isError ? <ErrorPanel error={q.error} /> : null}

      {report ? (
        <>
          {truncated?.sessions || truncated?.outcomes ? (
            <Card>
              <p className="p-4 text-sm">
                <strong>Partial period.</strong> This period has more records
                than a single read returns, so the rates below cover only the
                most recent slice of it. Narrow the period for an exact figure.
              </p>
            </Card>
          ) : null}

          {/* 1. The headline numbers. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Refit rate"
              value={pct(report.refit.refitRate)}
              caption={
                report.refit.responses === 0
                  ? "No fit surveys returned yet"
                  : `${report.refit.leaking + report.refit.uncomfortable} of ${report.refit.responses} reported a problem`
              }
            />
            <Stat
              label="Recommendation accepted"
              value={pct(report.acceptance.acceptanceRate)}
              caption={
                report.acceptance.decided === 0
                  ? "Nothing dispensed or overridden yet"
                  : `${report.acceptance.accepted} of ${report.acceptance.decided} decided · ${report.acceptance.undecided} still open`
              }
            />
            <Stat
              label="High confidence"
              value={pct(report.sessions.highConfidenceRate)}
              caption={
                report.sessions.total === 0
                  ? "No fittings in this period"
                  : `${report.sessions.total} fittings`
              }
            />
            <Stat
              label="Median time to review"
              value={hours(report.dispensing.medianHoursToReview)}
              caption={
                report.dispensing.medianHoursToReview == null
                  ? "Nothing reviewed yet"
                  : "Fitting to clinician sign-off"
              }
            />
          </div>

          {/* 4. Which masks are causing it. */}
          <Card>
            <div className="p-4">
              <h2 className="text-sm font-semibold mb-1">Refit rate by mask</h2>
              <p className="text-xs text-muted-foreground mb-3">
                Worst first. A mask needs at least 10 returned surveys before it
                appears — below that a rate is noise, and acting on it would be
                a stocking decision the data can&apos;t support.
              </p>
              {report.refit.byMask.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No mask has enough returned surveys yet.
                  {report.refit.belowSampleFloor > 0
                    ? ` ${report.refit.belowSampleFloor} response${report.refit.belowSampleFloor === 1 ? "" : "s"} sit below the threshold.`
                    : ""}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left border-b">
                        <th className="py-1 pr-3">Mask</th>
                        <th className="py-1 pr-3">Refit rate</th>
                        <th className="py-1 pr-3">Leaking</th>
                        <th className="py-1 pr-3">Uncomfortable</th>
                        <th className="py-1 pr-3">Good</th>
                        <th className="py-1">Surveys</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.refit.byMask.map((m) => (
                        <tr key={m.maskId} className="border-b last:border-0">
                          <td className="py-1.5 pr-3 font-medium">
                            {m.maskLabel ?? m.maskId}
                          </td>
                          <td className="py-1.5 pr-3">{pct(m.refitRate)}</td>
                          <td className="py-1.5 pr-3">{m.leaking}</td>
                          <td className="py-1.5 pr-3">{m.uncomfortable}</td>
                          <td className="py-1.5 pr-3">{m.good}</td>
                          <td className="py-1.5">{m.outcomes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {report.refit.unattributed > 0 ? (
                <p className="text-xs text-muted-foreground mt-2">
                  {report.refit.unattributed} response
                  {report.refit.unattributed === 1 ? "" : "s"} could not be tied
                  to a specific mask. They still count in the overall rate.
                </p>
              ) : null}
            </div>
          </Card>

          <div className="grid gap-3 lg:grid-cols-2">
            {/* 2. Where clinicians disagreed, and why. */}
            <Card>
              <div className="p-4">
                <h2 className="text-sm font-semibold mb-1">
                  Why clinicians overrode
                </h2>
                <p className="text-xs text-muted-foreground mb-3">
                  {report.acceptance.overridden} override
                  {report.acceptance.overridden === 1 ? "" : "s"} in this
                  period. An override with no reason recorded is the most
                  actionable row here — it means the review queue is losing the
                  &ldquo;why&rdquo;.
                </p>
                {report.acceptance.topOverrideReasons.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No overrides recorded.
                  </p>
                ) : (
                  <ul className="text-xs space-y-1">
                    {report.acceptance.topOverrideReasons.map((r) => (
                      <li key={r.reason} className="flex justify-between gap-3">
                        <span>{r.reason}</span>
                        <span className="font-medium">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            {/* 3. Scan quality + how fittings started. */}
            <Card>
              <div className="p-4">
                <h2 className="text-sm font-semibold mb-3">
                  Scans and confidence
                </h2>
                <dl className="text-xs space-y-1">
                  <Row
                    label="Good scans"
                    value={String(report.sessions.byScanQuality.good)}
                  />
                  <Row
                    label="Marginal scans"
                    value={String(report.sessions.byScanQuality.marginal)}
                  />
                  <Row
                    label="Poor scans"
                    value={String(report.sessions.byScanQuality.poor)}
                  />
                  {report.sessions.scanQualityUnknown > 0 ? (
                    <Row
                      label="Scan quality not recorded"
                      value={String(report.sessions.scanQualityUnknown)}
                    />
                  ) : null}
                </dl>

                <div className="flex flex-wrap gap-1.5 mt-3">
                  {(
                    Object.entries(report.sessions.byOutcome) as Array<
                      [FitSessionOutcome, number]
                    >
                  )
                    .filter(([, n]) => n > 0)
                    .map(([outcome, n]) => (
                      <Badge key={outcome} variant="muted">
                        {OUTCOME_LABEL[outcome]}: {n}
                      </Badge>
                    ))}
                  {report.sessions.outcomeUnknown > 0 ? (
                    <Badge variant="muted">
                      No outcome recorded: {report.sessions.outcomeUnknown}
                    </Badge>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-1.5 mt-2">
                  {Object.entries(report.sessions.byEntryPoint)
                    .filter(([, n]) => n > 0)
                    .map(([entry, n]) => (
                      <Badge key={entry} variant="info">
                        {ENTRY_LABEL[entry] ?? entry}: {n}
                      </Badge>
                    ))}
                </div>

                {report.sessions.degraded > 0 ? (
                  <p className="text-xs text-muted-foreground mt-3">
                    {report.sessions.degraded} fitting
                    {report.sessions.degraded === 1 ? "" : "s"} ran degraded
                    (catalog or formulary unavailable at the time).
                  </p>
                ) : null}
              </div>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <Card>
      <div className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{caption}</p>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

export default AdminAnalyticsFitterOutcomesPage;
