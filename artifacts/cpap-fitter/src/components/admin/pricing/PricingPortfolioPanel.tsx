import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import {
  getPricingPortfolio,
  refreshPricingPortfolioScenario,
  pricingKey,
  type PricingPortfolioEntry,
  type PricingPortfolioItem,
  type Scenario,
} from "@/lib/admin/pricing-api";
import { formatPricingMoney } from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingSection,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";

const entryKey = (entry: PricingPortfolioEntry) =>
  `${entry.batchId}:${entry.entryIndex}`;
const entryLabel = (entry: PricingPortfolioEntry) =>
  entry.entry.scenario.lines
    .map((line) => `${line.description} (${line.sku}) × ${line.quantity}`)
    .join(", ");

export function PricingPortfolioPanel({
  onAdd,
  onReviewItem,
  remainingCapacity = 100,
}: {
  onAdd: (scenarios: Scenario[]) => void;
  onReviewItem?: (item: { sku: string; name: string }) => void;
  remainingCapacity?: number;
}) {
  const qc = useQueryClient();
  const version = useRef(0);
  const [q, setQ] = useState(""),
    [category, setCategory] = useState(""),
    [supplier, setSupplier] = useState("");
  const [mode, setMode] = useState(""),
    [status, setStatus] = useState(""),
    [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<
    Record<string, PricingPortfolioEntry>
  >({});
  const [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [selectingAll, setSelectingAll] = useState(false);
  const [addedEntries, setAddedEntries] = useState<Record<string, true>>({});
  const filters = {
    q: q.trim(),
    category: category.trim(),
    supplier: supplier.trim(),
  };
  const portfolio = useQuery({
    queryKey: [...pricingKey, "portfolio", filters, offset],
    queryFn: () => getPricingPortfolio({ ...filters, offset, limit: 50 }),
  });
  const matchingEntries = (item: PricingPortfolioItem) =>
    item.activeEntries.filter(
      ({ entry, suppliers }) =>
        (!mode || entry.scenario.revenue.mode === mode) &&
        (!status || entry.evaluation.state === status) &&
        (!filters.supplier ||
          !suppliers ||
          suppliers.some(
            (source) =>
              source.sku === item.sku &&
              source.supplierName
                .toLowerCase()
                .includes(filters.supplier.toLowerCase()),
          )),
    );
  const changeFilter = (set: (value: string) => void, value: string) => {
    version.current += 1;
    set(value);
    setOffset(0);
    setSelected({});
    setNotice(
      "Portfolio selection cleared because the filters changed. Scenarios already added to the working selection are preserved.",
    );
    setError("");
    add.reset();
  };
  const selectEntries = (entries: PricingPortfolioEntry[]) => {
    const next = { ...selected };
    for (const entry of entries)
      if (!addedEntries[entryKey(entry)]) next[entryKey(entry)] = entry;
    if (Object.keys(next).length > 100) {
      setError(
        "A bulk preview supports up to 100 scenarios. Narrow the filters or clear part of the selection.",
      );
      return;
    }
    version.current += 1;
    setSelected(next);
    setError("");
  };
  const selectFiltered = async () => {
    const current = captureSessionCacheGuard(qc),
      requestVersion = ++version.current;
    setSelectingAll(true);
    setError("");
    const next: Record<string, PricingPortfolioEntry> = {};
    let missing = 0;
    try {
      for (let page = 0; page < 10; page += 1) {
        const data = await getPricingPortfolio({
          ...filters,
          offset: page * 100,
          limit: 100,
        });
        if (!current() || requestVersion !== version.current) return;
        for (const item of data.items) {
          const entries = matchingEntries(item);
          if (entries.length === 0) missing += 1;
          for (const entry of entries)
            if (!addedEntries[entryKey(entry)]) next[entryKey(entry)] = entry;
        }
        if (Object.keys(next).length > 100 || (page === 9 && data.hasMore))
          throw new Error(
            "The filtered set is too large for one preview. Narrow the filters; no partial selection was added.",
          );
        if (!data.hasMore) {
          setSelected(next);
          setNotice(
            `${Object.keys(next).length} distinct published scenarios selected across the filtered results. ${missing} item(s) have no matching published scenario and need individual review.`,
          );
          return;
        }
      }
    } catch (cause) {
      if (current() && requestVersion === version.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not select the filtered results. Retry the lookup.",
        );
    } finally {
      if (current()) setSelectingAll(false);
    }
  };
  const add = useMutation({
    mutationFn: async ({
      entries,
    }: {
      entries: PricingPortfolioEntry[];
      version: number;
    }) => {
      const current = captureSessionCacheGuard(qc);
      const scenarios: Scenario[] = [],
        failures: string[] = [];
      for (let index = 0; index < entries.length; index += 4) {
        if (!current())
          throw new Error(
            "The session changed. Select the portfolio scenarios again.",
          );
        const group = entries.slice(index, index + 4);
        const results = await Promise.allSettled(
          group.map((entry) =>
            refreshPricingPortfolioScenario(entry.entry.scenario),
          ),
        );
        if (!current())
          throw new Error(
            "The session changed. Select the portfolio scenarios again.",
          );
        results.forEach((result, offset) => {
          if (result.status === "fulfilled")
            scenarios.push(result.value.scenario);
          else
            failures.push(
              `${entryLabel(group[offset])}: ${result.reason instanceof Error ? result.reason.message : "Current assumptions could not be checked"}`,
            );
        });
      }
      if (failures.length)
        throw new Error(
          `No scenarios were added. Resolve these sources or deselect their scenarios: ${failures.join("; ")}`,
        );
      return scenarios;
    },
    onSuccess: (scenarios, request) => {
      if (request.version !== version.current) return;
      onAdd(scenarios);
      setAddedEntries((old) => ({
        ...old,
        ...Object.fromEntries(
          request.entries.map((entry) => [entryKey(entry), true as const]),
        ),
      }));
      setSelected({});
      setNotice(
        `${scenarios.length} scenarios copied to the working selection using current versions of the same suppliers. Edit their prices and create a frozen preview below.`,
      );
    },
  });
  const selectedCount = Object.keys(selected).length;
  return (
    <PricingSection
      title="Pricing portfolio"
      description="Find items by name, SKU, category or supplier. Select published scenarios with their complete delivery and collection assumptions; new items need their first review."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <PricingField label="Find item or SKU">
          <input
            className={pricingControl}
            value={q}
            onChange={(e) => changeFilter(setQ, e.target.value)}
          />
        </PricingField>
        <PricingField label="Category (exact)">
          <input
            className={pricingControl}
            value={category}
            onChange={(e) => changeFilter(setCategory, e.target.value)}
          />
        </PricingField>
        <PricingField label="Supplier">
          <input
            className={pricingControl}
            value={supplier}
            onChange={(e) => changeFilter(setSupplier, e.target.value)}
          />
        </PricingField>
        <PricingField label="Revenue mode">
          <select
            className={pricingControl}
            value={mode}
            onChange={(e) => changeFilter(setMode, e.target.value)}
          >
            <option value="">All revenue modes</option>
            <option value="insurance">Insurance</option>
            <option value="self_pay">Self-pay scenario</option>
          </select>
        </PricingField>
        <PricingField label="Published review status">
          <select
            className={pricingControl}
            value={status}
            onChange={(e) => changeFilter(setStatus, e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="meets_target">Meets target</option>
            <option value="approval_needed">Approval needed</option>
            <option value="blocked">Blocked</option>
            <option value="cost_information_needed">
              Cost information needed
            </option>
          </select>
        </PricingField>
      </div>
      <div className="my-4 flex flex-wrap gap-2">
        <Button
          intent="secondary"
          disabled={
            !portfolio.data ||
            portfolio.isFetching ||
            !!portfolio.error ||
            selectingAll ||
            add.isPending
          }
          onClick={() =>
            selectEntries(portfolio.data!.items.flatMap(matchingEntries))
          }
        >
          Select available scenarios on this page
        </Button>
        <Button
          intent="secondary"
          isLoading={selectingAll}
          disabled={portfolio.isFetching || !!portfolio.error || add.isPending}
          onClick={() => void selectFiltered()}
        >
          Select all filtered scenarios
        </Button>
        <Button
          intent="ghost"
          disabled={!selectedCount || add.isPending}
          onClick={() => {
            version.current += 1;
            setSelected({});
          }}
        >
          Clear portfolio selection
        </Button>
      </div>
      {portfolio.isPending ? (
        <p role="status">Loading portfolio…</p>
      ) : portfolio.error ? (
        <ErrorPanel
          error={portfolio.error}
          onRetry={() => void portfolio.refetch()}
        />
      ) : (
        <>
          {!portfolio.data?.items.length && (
            <p className="py-4 text-sm text-slate-500">
              No items match these filters.
            </p>
          )}
          <div className="space-y-3">
            {portfolio.data?.items.map((item) => (
              <article
                key={item.sku}
                className="rounded-lg border border-slate-200 p-4"
                aria-label={`${item.name} (${item.sku})`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {item.name}{" "}
                      <span className="text-sm font-normal text-slate-500">
                        · {item.sku}
                      </span>
                    </h3>
                    <p className="text-xs text-slate-500">
                      {item.category || "Uncategorized"}
                    </p>
                  </div>
                  {onReviewItem && (
                    <Button
                      intent="secondary"
                      size="sm"
                      onClick={() => onReviewItem(item)}
                    >
                      Review {item.sku}
                    </Button>
                  )}
                </div>
                <ul className="mt-3 space-y-1 text-xs text-slate-600">
                  {item.offers.map((offer) => (
                    <li key={`${offer.id}:${offer.version}`}>
                      {offer.supplierName} · goods cost/unit{" "}
                      {formatPricingMoney(offer.unitCostCents)} · {offer.status}{" "}
                      · version {offer.version}
                    </li>
                  ))}
                </ul>
                {!item.offers.length && (
                  <p className="mt-2 text-sm text-amber-800">
                    No current supplier cost is available.
                  </p>
                )}
                {item.hasMoreOffers && (
                  <p className="mt-1 text-xs text-slate-500">
                    Additional supplier offers are available in Item review.
                  </p>
                )}
                <div className="mt-3 space-y-2">
                  {matchingEntries(item).map((entry) => (
                    <label
                      key={entryKey(entry)}
                      className="flex items-start gap-3 rounded border border-slate-100 bg-slate-50 p-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={`Select ${item.sku} scenario ${entry.entryIndex + 1}`}
                        checked={!!selected[entryKey(entry)]}
                        disabled={
                          !!addedEntries[entryKey(entry)] ||
                          add.isPending ||
                          selectingAll ||
                          portfolio.isFetching
                        }
                        onChange={(event) => {
                          if (event.target.checked) selectEntries([entry]);
                          else {
                            version.current += 1;
                            setSelected((old) => {
                              const next = { ...old };
                              delete next[entryKey(entry)];
                              return next;
                            });
                          }
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block">{entryLabel(entry)}</span>
                        <span className="mt-1 block text-xs text-slate-500">
                          {entry.entry.scenario.revenue.mode === "insurance"
                            ? "Insurance"
                            : "Self-pay scenario"}{" "}
                          ·{" "}
                          {entry.entry.scenario.delivery?.service ||
                            "Delivery service not recorded"}{" "}
                          · published amounts{" "}
                          {entry.entry.scenario.lines
                            .map(
                              (line) =>
                                `${line.sku} ${formatPricingMoney(line.unitAmountCents)}`,
                            )
                            .join(", ")}
                        </span>
                        <span className="mt-2 block">
                          {addedEntries[entryKey(entry)] && (
                            <span className="mb-2 block text-xs font-medium text-emerald-800">
                              Already in the working selection
                            </span>
                          )}
                          <span className="mb-2 block text-xs text-slate-600">
                            Supplier for this item:{" "}
                            {entry.suppliers
                              ?.filter((source) => source.sku === item.sku)
                              .map((source) => source.supplierName)
                              .join(", ") ||
                              item.offers
                                .filter((offer) =>
                                  entry.entry.scenario.lines.some(
                                    (line) =>
                                      line.sku === item.sku &&
                                      line.offerId === offer.id,
                                  ),
                                )
                                .map((offer) => offer.supplierName)
                                .join(", ") ||
                              "See supplier details in Item review"}
                          </span>
                          <PricingStatus state={entry.entry.evaluation.state} />
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                {!matchingEntries(item).length && (
                  <p className="mt-3 text-sm text-amber-800">
                    {item.activeEntries.length
                      ? "No published scenario matches the selected supplier, revenue mode or status."
                      : filters.supplier
                        ? "No published scenario uses this supplier for this item. Review the item to create one with explicit assumptions."
                        : "First scenario needed. Review this item to enter its price, destination, service and collection assumptions."}
                  </p>
                )}
              </article>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              intent="ghost"
              disabled={!offset || portfolio.isFetching}
              onClick={() => setOffset((old) => Math.max(0, old - 50))}
            >
              Previous portfolio page
            </Button>
            <Button
              intent="ghost"
              disabled={!portfolio.data?.hasMore || portfolio.isFetching}
              onClick={() => setOffset((old) => old + 50)}
            >
              Next portfolio page
            </Button>
          </div>
        </>
      )}
      <p className="mt-3 text-xs text-slate-600">
        {selectedCount} distinct scenarios selected. A bundle shown under
        multiple items is included once, with every bundle item preserved.
        Published status is historical; current sources are checked before
        adding.
      </p>
      <Button
        className="mt-3"
        disabled={
          !selectedCount || selectedCount > remainingCapacity || selectingAll
        }
        isLoading={add.isPending}
        onClick={() =>
          add.mutate({
            entries: Object.values(selected),
            version: version.current,
          })
        }
      >
        Add selected scenarios to working selection ({selectedCount})
      </Button>
      {selectedCount > remainingCapacity && (
        <p role="alert" className="mt-2 text-sm text-amber-800">
          Only {remainingCapacity} scenario slots remain in this working
          selection. Deselect scenarios or clear the working selection below.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {add.error && (
        <ErrorPanel error={add.error} onRetry={() => add.reset()} />
      )}
    </PricingSection>
  );
}
