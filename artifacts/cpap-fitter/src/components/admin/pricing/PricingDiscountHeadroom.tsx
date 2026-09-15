import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import {
  getPricingDiscountHeadroom,
  type Scenario,
} from "@/lib/admin/pricing-api";
import {
  formatPricingMoney,
  parsePricingMoney,
} from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingMetric,
  pricingControl,
} from "./PricingPrimitives";

export function PricingDiscountHeadroom({ scenario }: { scenario: Scenario }) {
  const [limit, setLimit] = useState("");
  const [error, setError] = useState("");
  const search = useMutation({
    mutationFn: (cents: number) => getPricingDiscountHeadroom(scenario, cents),
  });
  if (scenario.revenue.mode !== "self_pay") return null;
  const check = () => {
    const cents = parsePricingMoney(limit);
    if (cents === null || cents > 100000) {
      setError("Enter an additional discount limit from $0 to $1,000.");
      return;
    }
    setError("");
    search.mutate(cents);
  };
  const result = search.data?.discountHeadroom;
  const message =
    result &&
    {
      cost_information_needed:
        "Complete the missing cost information before checking discounts.",
      self_pay_required:
        "Discount comparison is available only for an internal self-pay scenario.",
      fixed_capture_amounts:
        "Revise the fixed payment capture amounts before comparing a different discount.",
      blocked_policy:
        "The current unit amounts exceed the pricing policy ceiling. Revise them before comparing discounts.",
      calculated: null,
      search_limit: null,
    }[result.status];
  return (
    <details className="mt-5 rounded-lg border border-slate-200 p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        How much discount can this scenario support?
      </summary>
      <p className="my-3 text-sm text-slate-600">
        Check an additional fixed discount while preserving the existing
        discount, quantities, costs and fees. This comparison does not change
        the working amount or create a patient payment.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <PricingField
          label="Search up to additional discount ($)"
          hint="Choose a limit up to $1,000. The result states the range actually checked."
        >
          <input
            className={pricingControl}
            inputMode="decimal"
            value={limit}
            placeholder="Enter a limit"
            onChange={(event) => {
              setLimit(event.target.value);
              setError("");
              search.reset();
            }}
          />
        </PricingField>
        <Button intent="secondary" isLoading={search.isPending} onClick={check}>
          Check discount room
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {search.error && (
        <div className="mt-3">
          <ErrorPanel error={search.error} onRetry={check} />
        </div>
      )}
      {result && (
        <div className="mt-4 space-y-3" aria-live="polite">
          {message ? (
            <p className="text-sm text-amber-900">{message}</p>
          ) : (
            <>
              <p className="text-sm text-slate-600">
                Checked additional discounts from $0.00 through{" "}
                {formatPricingMoney(result.searchUpperBoundCents)}.
                {result.wholeDomainSearched
                  ? " This covers all remaining merchandise value."
                  : " Larger discounts were not checked; these are the largest qualifying amounts only within this range."}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ["target", "Preserves target"],
                    ["floor", "Preserves minimum margin"],
                  ] as const
                ).map(([key, label]) => {
                  const match = result[key];
                  return (
                    <PricingMetric
                      key={key}
                      label={`${label} · additional discount`}
                      value={
                        match
                          ? formatPricingMoney(match.additionalDiscountCents)
                          : "None found in checked range"
                      }
                      detail={
                        match
                          ? `Contribution ${formatPricingMoney(match.evaluation.contributionCents)} · Margin ${match.evaluation.selectedBasisMarginBps === null ? "not available" : (match.evaluation.selectedBasisMarginBps / 100).toFixed(2) + "%"}`
                          : undefined
                      }
                    />
                  );
                })}
              </div>
              <p className="text-xs text-slate-500">
                Review approval rules still apply. Enter any chosen discount in
                the scenario and evaluate again before saving.
              </p>
            </>
          )}
        </div>
      )}
    </details>
  );
}
