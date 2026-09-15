import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { Button } from "../Button";
import {
  evaluatePricingScenario,
  getPricingOffers,
  type OfferVersion,
  type ResolvedScenario,
  type Scenario,
} from "@/lib/admin/pricing-api";
import { formatPricingMoney } from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";
export function PricingSupplierComparison({
  scenario,
  onChoose,
}: {
  scenario: Scenario;
  onChoose: (lineId: string, offer: OfferVersion) => void;
}) {
  const qc = useQueryClient(),
    [lineId, setLineId] = useState(scenario.lines[0].id),
    [pending, setPending] = useState(false),
    [rows, setRows] = useState<
      Array<{ offer: OfferVersion; result?: ResolvedScenario; error?: string }>
    >([]),
    [error, setError] = useState("");
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const compare = async () => {
    const current = captureSessionCacheGuard(qc),
      version = ++request.current;
    setPending(true);
    setRows([]);
    setError("");
    const line = scenario.lines.find((l) => l.id === lineId)!;
    try {
      const offers = await getPricingOffers(0, line.sku);
      if (!current() || request.current !== version) return;
      const results: Array<{
        offer: OfferVersion;
        result?: ResolvedScenario;
        error?: string;
      }> = [];
      for (const offer of offers.offers) {
        try {
          const result = await evaluatePricingScenario({
            ...scenario,
            lines: scenario.lines.map((l) =>
              l.id === line.id
                ? { ...l, offerId: offer.id, offerVersion: offer.version }
                : l,
            ),
          });
          if (!current() || request.current !== version) return;
          results.push({ offer, result });
        } catch (e) {
          if (!current() || request.current !== version) return;
          results.push({
            offer,
            error:
              e instanceof Error ? e.message : "Could not evaluate this offer",
          });
        }
        setRows([...results]);
      }
      if (!offers.offers.length)
        setError("No supplier offers were found for this item.");
      if (offers.hasMore)
        setError(
          "Showing the first 100 supplier offers. Narrow the item sourcing list before comparing more.",
        );
    } catch (e) {
      if (current() && request.current === version)
        setError(
          e instanceof Error ? e.message : "Supplier comparison unavailable.",
        );
    } finally {
      if (current() && request.current === version) setPending(false);
    }
  };
  return (
    <div className="mt-5 space-y-3 border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold">
        Compare delivered cost by supplier
      </h3>
      <p className="text-xs text-slate-600">
        Each alternative uses the same order and quantities. The server rechecks
        pack sizes, shared fees, shipping and contribution.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <PricingField label="Item to compare">
          <select
            className={pricingControl}
            value={lineId}
            disabled={pending}
            onChange={(e) => {
              setLineId(e.target.value);
              setRows([]);
            }}
          >
            {scenario.lines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.description}
              </option>
            ))}
          </select>
        </PricingField>
        <Button
          intent="secondary"
          isLoading={pending}
          onClick={() => void compare()}
        >
          Compare supplier offers
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-amber-800">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3">Supplier</th>
                <th className="p-2">Goods / unit</th>
                <th className="p-2">Order delivered cost</th>
                <th className="p-2">Order contribution</th>
                <th className="p-2">Status</th>
                <th className="p-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.offer.id} className="border-b border-slate-100">
                  <td className="py-3 pr-3 font-medium">
                    {row.offer.supplierName}
                  </td>
                  <td className="p-2">
                    {formatPricingMoney(row.offer.unitCostCents)}
                  </td>
                  <td className="p-2">
                    {formatPricingMoney(
                      row.result?.evaluation.deliveredCostCents,
                    )}
                  </td>
                  <td className="p-2">
                    {formatPricingMoney(
                      row.result?.evaluation.contributionCents,
                    )}
                  </td>
                  <td className="p-2">
                    {row.result ? (
                      <PricingStatus state={row.result.evaluation.state} />
                    ) : (
                      <span className="text-red-700">{row.error}</span>
                    )}
                  </td>
                  <td className="p-2">
                    <Button
                      intent="secondary"
                      size="sm"
                      disabled={pending || !row.result}
                      onClick={() => onChoose(lineId, row.offer)}
                    >
                      Use supplier
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
