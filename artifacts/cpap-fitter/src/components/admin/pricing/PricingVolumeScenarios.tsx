import { useState } from "react";
import type { ResolvedScenario } from "@/lib/admin/pricing-api";
import { formatPricingMoney } from "@/lib/admin/pricing-input";
import { pricingControl } from "./PricingPrimitives";

/** Explicit volume assumptions never become observed sales or an optimal price. */
export function PricingVolumeScenarios({
  entries,
}: {
  entries: ResolvedScenario[];
}) {
  const [volumes, setVolumes] = useState<Record<number, string>>({});
  const rows = entries.map((entry, index) => {
    const raw = volumes[index] ?? "";
    const orders = /^\d{1,6}$/.test(raw) ? Number(raw) : null;
    const evaluation = entry.evaluation;
    const revenue =
      orders !== null && evaluation.netRevenueCents !== null
        ? orders * evaluation.netRevenueCents
        : null;
    const contribution =
      orders !== null && evaluation.contributionCents !== null
        ? orders * evaluation.contributionCents
        : null;
    const known =
      evaluation.calculationComplete &&
      revenue !== null &&
      contribution !== null &&
      Number.isSafeInteger(revenue) &&
      Number.isSafeInteger(contribution);
    return {
      entry,
      index,
      raw,
      orders,
      revenue: known ? revenue : null,
      contribution: known ? contribution : null,
    };
  });
  const complete =
    rows.length > 0 &&
    rows.every((r) => r.revenue !== null && r.contribution !== null);
  const revenue = rows.reduce((sum, r) => sum + (r.revenue ?? 0), 0);
  const contribution = rows.reduce((sum, r) => sum + (r.contribution ?? 0), 0);
  const safe =
    complete &&
    Number.isSafeInteger(revenue) &&
    Number.isSafeInteger(contribution);
  return (
    <details className="mt-4 rounded-lg border border-slate-200 p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        Compare monthly profit using volume assumptions
      </summary>
      <p className="my-3 text-sm text-slate-600">
        Enter assumed monthly order counts for each scenario. These are planning
        assumptions, not predicted demand. The projection uses each scenario's
        current costs and quantities; overhead is shown separately in item
        review.
      </p>
      <div className="space-y-3">
        {rows.map((r) => (
          <div
            key={r.index}
            className="grid items-end gap-3 rounded-lg bg-slate-50 p-3 md:grid-cols-3"
          >
            <label className="text-sm">
              Assumed orders per month — scenario {r.index + 1}
              <span className="block text-xs text-slate-500">
                {r.entry.scenario.lines
                  .map((l) => `${l.quantity} × ${l.sku}`)
                  .join(", ")}
              </span>
              <input
                className={pricingControl}
                inputMode="numeric"
                value={r.raw}
                placeholder="Enter an assumption"
                onChange={(event) =>
                  setVolumes((v) => ({ ...v, [r.index]: event.target.value }))
                }
              />
            </label>
            <p className="text-sm">
              Projected revenue
              <br />
              <strong>{formatPricingMoney(r.revenue)}</strong>
            </p>
            <p className="text-sm">
              Projected contribution
              <br />
              <strong>{formatPricingMoney(r.contribution)}</strong>
            </p>
          </div>
        ))}
        <p className="text-sm" aria-live="polite">
          {safe
            ? `Combined monthly revenue ${formatPricingMoney(revenue)} · Contribution ${formatPricingMoney(contribution)} · Weighted margin ${revenue > 0 ? `${((contribution / revenue) * 100).toFixed(2)}%` : "undefined at zero revenue"}`
            : "Enter a whole-number volume for every complete scenario to see combined results."}
        </p>
      </div>
    </details>
  );
}
