// /admin/analytics/order-outcomes — from "this patient is due" to "we got
// paid", in one place.
//
// Everything before a claim was measured on the resupply pages and
// everything after it on the billing pages, with nothing joining them. So
// the question the business actually asks — of the patients who were due,
// how many turned into money, and where did the rest go — had no answer,
// and neither did its follow-up: which step to fix first.
//
// reports.read-gated server-side; aggregates and reason codes only, no
// per-patient PHI.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingDown } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchOrderOutcomes,
  type OrderOutcomesResponse,
} from "@/lib/admin/analytics-order-outcomes-api";

const WINDOWS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
];

/** Each stage, with what it means in the operator's own terms. The labels
 *  matter: "claimed" is not a word a CSR uses, "we billed it" is. */
const STAGES: Array<{
  key: keyof OrderOutcomesResponse["stages"];
  label: string;
  hint: string;
}> = [
  {
    key: "eligible",
    label: "Due",
    hint: "Refills that came due in this window",
  },
  { key: "confirmed", label: "Confirmed", hint: "The patient said yes" },
  { key: "fulfilled", label: "Shipped", hint: "The supplies went out" },
  { key: "claimed", label: "Billed", hint: "A claim was created" },
  { key: "accepted", label: "Accepted", hint: "The payer accepted it" },
  { key: "paid", label: "Paid", hint: "Money actually arrived" },
];

/** Close-out reason codes, in plain language. Anything not listed falls
 *  back to the raw code rather than being hidden. */
const REASON_LABELS: Record<string, string> = {
  patient_declined: "Patient declined this cycle",
  patient_opted_out: "Patient opted out of reminders",
  no_response: "No response after every reminder",
  never_contacted: "We never reached them",
  csr_canceled: "Cancelled by staff",
  prescription_ended: "Prescription ended",
  patient_inactive: "Patient no longer active",
  duplicate: "Duplicate",
  coverage_lost: "Coverage lost",
  legacy_unknown: "Closed before we recorded reasons",
};

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(ratio: number | null): string {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

export function AdminAnalyticsOrderOutcomesPage() {
  const [days, setDays] = useState(30);

  const query = useQuery({
    queryKey: ["admin", "analytics", "order-outcomes", days],
    queryFn: () => fetchOrderOutcomes(days),
    staleTime: 60_000,
  });

  const data = query.data;

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-analytics-order-outcomes-page"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1 flex items-center gap-2"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          <TrendingDown className="h-6 w-6" /> Order outcomes
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Every refill that came due in this window, followed all the way to
          payment — and, for the ones that did not get there, where they
          stopped.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {WINDOWS.map((w) => (
          <button
            key={w.value}
            type="button"
            onClick={() => setDays(w.value)}
            className={`px-3 py-1.5 rounded-full text-sm border ${
              days === w.value
                ? "bg-slate-700 text-white border-slate-800"
                : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {query.isPending && <Spinner />}
      {query.error && <ErrorPanel error={query.error} />}

      {data && (
        <>
          <Card>
            <h2 className="text-lg font-semibold mb-3">The chain</h2>
            <div className="space-y-2">
              {STAGES.map((stage, i) => {
                const count = data.stages[stage.key];
                const top = data.stages.eligible;
                // Bar width relative to the top of the funnel, so the drop
                // between steps is the thing you see first.
                const width = top > 0 ? Math.round((count / top) * 100) : 0;
                const rateKey = [
                  null,
                  "confirmedOfEligible",
                  "fulfilledOfConfirmed",
                  "claimedOfFulfilled",
                  "acceptedOfClaimed",
                  "paidOfAccepted",
                ][i] as keyof OrderOutcomesResponse["rates"] | null;
                return (
                  <div key={stage.key}>
                    <div className="flex items-baseline justify-between text-sm">
                      <span style={{ color: "hsl(var(--ink-1))" }}>
                        <strong>{stage.label}</strong>{" "}
                        <span
                          className="text-xs"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          {stage.hint}
                        </span>
                      </span>
                      <span style={{ color: "hsl(var(--ink-2))" }}>
                        {num(count)}
                        {rateKey && (
                          <span
                            className="ml-2 text-xs"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            {pct(data.rates[rateKey])} of previous
                          </span>
                        )}
                      </span>
                    </div>
                    <div
                      className="h-2 rounded mt-1"
                      style={{ backgroundColor: "hsl(var(--surface-2))" }}
                    >
                      <div
                        className="h-2 rounded"
                        style={{
                          width: `${width}%`,
                          backgroundColor: "#0a1f44",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold mb-1">Still moving</h2>
            <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
              Not losses — these have not finished yet. They are shown
              separately so the drop-offs below are only the ones that actually
              stopped.
            </p>
            <ul className="text-sm space-y-1">
              <li>
                Waiting on the patient: {num(data.inFlight.awaitingResponse)}
              </li>
              <li>
                Waiting on an address confirmation:{" "}
                {num(data.inFlight.addressHold)}
              </li>
              <li>
                <strong>
                  Confirmed but not shipped:{" "}
                  {num(data.inFlight.confirmedUnshipped)}
                </strong>{" "}
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  — the patient said yes and nothing has gone out. If this is
                  climbing, orders are not reaching the warehouse.
                </span>
              </li>
              <li>With the payer: {num(data.inFlight.claimOpen)}</li>
            </ul>
          </Card>

          {data.unverified.assumedShipped > 0 && (
            <Card>
              <h2 className="text-lg font-semibold mb-1">
                Advanced without a shipment record
              </h2>
              <p
                className="text-sm mb-3"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                <strong>{num(data.unverified.assumedShipped)}</strong> cycles
                moved on because the grace window ran out, not because anything
                was recorded as shipped. They are counted here rather than under
                &ldquo;Shipped&rdquo; because nobody knows whether the product
                left the warehouse — calling them shipped would also report them
                as unbilled product loss below.
              </p>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                This number is the case for connecting a shipment feed: it is
                exactly the population this page cannot account for. Import
                PacWare shipment confirmations, or mark orders shipped as they
                go out, and it falls to zero.
              </p>
            </Card>
          )}

          <Card>
            <h2 className="text-lg font-semibold mb-1">
              Stopped before anything shipped
            </h2>
            <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
              Why each cycle ended.
            </p>
            {Object.keys(data.preShipLoss).length === 0 ? (
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                None in this window.
              </p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(data.preShipLoss)
                    .sort((a, b) => b[1] - a[1])
                    .map(([reason, count]) => (
                      <tr key={reason} className="border-t">
                        <td className="py-1.5">
                          {REASON_LABELS[reason] ?? reason}
                        </td>
                        <td className="py-1.5 text-right">{num(count)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card>
            <h2 className="text-lg font-semibold mb-1">Shipped, then lost</h2>
            <p className="text-sm mb-3" style={{ color: "hsl(var(--ink-3))" }}>
              Supplies went out and the money did not come back. These cost
              twice — the product and the revenue.
            </p>
            <ul className="text-sm space-y-1 mb-4">
              <li>
                <strong>Never billed: {num(data.postShipLoss.unbilled)}</strong>{" "}
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  — shipped with no claim created at all.
                </span>
              </li>
              <li>Denied by the payer: {num(data.postShipLoss.denied)}</li>
              <li>
                Rejected before adjudication: {num(data.postShipLoss.rejected)}{" "}
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  — a clearinghouse rejection, usually fixable and
                  resubmittable.
                </span>
              </li>
              <li>Closed unpaid: {num(data.postShipLoss.closedUnpaid)}</li>
            </ul>

            {data.deniedByCarc.length > 0 && (
              <>
                <h3 className="text-sm font-semibold mb-2">Denial reasons</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr
                        className="text-left"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        <th className="py-1 font-medium">Code</th>
                        <th className="py-1 font-medium">Reason</th>
                        <th className="py-1 font-medium text-right">Claims</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.deniedByCarc.map((d) => (
                        <tr key={d.code} className="border-t">
                          <td className="py-1.5 whitespace-nowrap">
                            {d.code === "uncoded" ? "—" : `CARC ${d.code}`}
                          </td>
                          <td className="py-1.5">
                            {d.description ||
                              (d.code === "uncoded"
                                ? "No reason code recorded"
                                : "Not in the denial-code catalog")}
                          </td>
                          <td className="py-1.5 text-right">{num(d.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export default AdminAnalyticsOrderOutcomesPage;
