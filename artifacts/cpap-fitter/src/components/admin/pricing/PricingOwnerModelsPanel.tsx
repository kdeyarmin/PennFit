import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import {
  getPricingOwnerModels,
  getPricingQuote,
  getPricingQuotes,
  refreshPricingPortfolioScenario,
  pricingKey,
  type OwnerProfitAssumptions,
  type OwnerProfitModels,
  type PricingOwnerModelsResponse,
  type Scenario,
} from "@/lib/admin/pricing-api";
import { formatPricingMoney } from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingMetric,
  PricingSection,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";

type ModelKey = Exclude<keyof OwnerProfitAssumptions, "selectedLineId">;
type Field = {
  key: string;
  label: string;
  kind: "money" | "count" | "percent";
  max?: number;
  min?: number;
  hint?: string;
};
type CaseDraft = { id: string; label: string; values: Record<string, string> };
export type OwnerModelSource = {
  scenario: Scenario;
  label: string;
  revision: number;
};
type Calculation = {
  signature: string;
  assumptions: OwnerProfitAssumptions;
  response: PricingOwnerModelsResponse;
  session: () => boolean;
};
const money = (key: string, label: string, hint?: string): Field => ({
  key,
  label,
  kind: "money",
  hint,
});
const count = (
  key: string,
  label: string,
  max = 1_000_000,
  min = 0,
): Field => ({ key, label, kind: "count", max, min });
const percent = (key: string, label: string, max = 1000, min = 0): Field => ({
  key,
  label,
  kind: "percent",
  max,
  min,
});
const MODELS: Array<{
  key: ModelKey;
  title: string;
  description: string;
  fields: Field[];
  caseFields?: Field[];
}> = [
  {
    key: "strategies",
    title: "Pricing strategies",
    description:
      "Compare target margin, cost markup, fixed contribution and a reference price. These are internal self-pay alternatives; insurance collections are not changed.",
    fields: [
      percent("targetMarginBps", "Target contribution margin (%)", 99.99),
      percent("markupBps", "Markup on variable cost (%)"),
      money("targetContributionCents", "Target contribution per order ($)"),
      money("referenceUnitPriceCents", "Reference unit price ($)"),
    ],
  },
  {
    key: "monthly",
    title: "Monthly break-even & profit",
    description:
      "Find the order count needed to cover monthly fixed costs and reach your profit target. Each order uses the full selected scenario.",
    fields: [
      money("fixedCostCents", "Monthly fixed costs ($)"),
      count("orders", "Assumed monthly orders"),
      money("targetProfitCents", "Monthly profit target ($)"),
    ],
  },
  {
    key: "sensitivity",
    title: "Cost & collection stress",
    description:
      "Test changes to goods costs, freight or expected insurance collections. Enter a negative percentage for a decrease and 0 for an explicit unchanged assumption.",
    fields: [],
    caseFields: [
      percent("goodsChangeBps", "Goods cost change (%)", 1000, -100),
      percent("freightChangeBps", "Freight cost change (%)", 1000, -100),
      percent(
        "collectibleChangeBps",
        "Insurance collections change (%)",
        1000,
        -100,
      ),
    ],
  },
  {
    key: "priceVolume",
    title: "Price versus volume",
    description:
      "Compare internal self-pay prices with order volumes you choose. No demand response is predicted; each row is your own assumption.",
    fields: [
      money("fixedCostCents", "Monthly fixed costs for price comparison ($)"),
    ],
    caseFields: [
      money("unitPriceCents", "Scenario unit price ($)"),
      count("orders", "Assumed monthly orders at this price"),
    ],
  },
  {
    key: "acquisition",
    title: "Repeat orders & acquisition",
    description:
      "Compare expected repeat-order contribution with customer acquisition and retention spending over an explicit planning period.",
    fields: [
      count("horizonMonths", "Planning period (months)", 120, 1),
      count("customers", "Assumed customers"),
      count(
        "ordersPerCustomer",
        "Orders per customer over the full period",
        10_000,
      ),
      money(
        "acquisitionCostPerCustomerCents",
        "Acquisition cost per customer ($)",
      ),
      money("retentionCostPerOrderCents", "Retention cost per order ($)"),
      money(
        "fixedCostCents",
        "Fixed costs for the full planning period ($)",
        "Enter the total for the whole period, not a monthly amount.",
      ),
    ],
  },
  {
    key: "workingCapital",
    title: "Working capital",
    description:
      "Estimate cash tied up between inventory, vendor payments and collections. Enter actual cash timing assumptions; this is a simple funding estimate, not a cash-flow forecast.",
    fields: [
      count("periodDays", "Planning period (days)", 366, 1),
      count("orders", "Assumed orders during this period"),
      money(
        "cashOutlayPerOrderCents",
        "Cash paid out per order ($)",
        "Enter your cash outlay explicitly; accounting contribution is not cash flow.",
      ),
      count("inventoryDays", "Days held in inventory", 3650),
      count("daysToCollect", "Days until customer / insurer collection", 3650),
      count("daysToPayVendor", "Days until vendor payment", 3650),
    ],
  },
];
const freshCases = (): CaseDraft[] => [
  { id: crypto.randomUUID(), label: "", values: {} },
];
const statusLabels: Record<string, string> = {
  calculated: "Calculated",
  estimated: "Uses estimated inputs",
  needs_inputs: "More information needed",
  unattainable: "Not attainable with these assumptions",
  not_applicable: "Not available for this scenario",
  blocked: "Review required",
};
const strategyLabels: Record<string, string> = {
  target_margin: "Target margin",
  cost_markup: "Cost markup",
  fixed_contribution: "Fixed contribution",
  reference_price: "Reference price",
};

function parseField(value: string, field: Field): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const pattern = field.kind === "count" ? /^\d+$/ : /^-?\d+(?:\.\d{1,2})?$/;
  if (!pattern.test(text))
    throw new Error(
      `${field.label}: enter ${field.kind === "count" ? "a whole number" : "a number with at most two decimal places"}.`,
    );
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const valueNumber =
    field.kind === "count"
      ? Number(whole)
      : Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  const result = negative ? -valueNumber : valueNumber;
  const scale = field.kind === "percent" ? 100 : 1;
  const maximum =
    field.kind === "money" ? 100_000_000_000 : (field.max ?? 1_000_000) * scale;
  if (
    !Number.isSafeInteger(result) ||
    result < (field.min ?? 0) * scale ||
    result > maximum
  )
    throw new Error(
      `${field.label}: enter a value from ${field.min ?? 0} to ${field.kind === "money" ? formatPricingMoney(maximum) : (field.max ?? 1_000_000)}.`,
    );
  return result;
}
function fieldValues(fields: Field[], values: Record<string, string>) {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = parseField(values[field.key] ?? "", field);
      return value === undefined ? [] : [[field.key, value]];
    }),
  );
}
function shown(value: number | null): string {
  return value === null ? "Not available" : value.toLocaleString("en-US");
}
function margin(value: number | null): string {
  return value === null ? "Not available" : `${(value / 100).toFixed(2)}%`;
}
type ReportMetric = { label: string; value: string };
function metrics(key: ModelKey, models: OwnerProfitModels): ReportMetric[] {
  const list: ReportMetric[] = [];
  const add = (label: string, value: string) => list.push({ label, value });
  if (key === "monthly") {
    const result = models.monthly;
    add(
      "Contribution per order",
      formatPricingMoney(result.contributionPerOrderCents),
    );
    add("Break-even orders per month", shown(result.breakEvenOrders));
    add("Orders to reach profit target", shown(result.targetProfitOrders));
    add(
      "Projected monthly revenue",
      formatPricingMoney(result.projectedRevenueCents),
    );
    add(
      "Projected monthly contribution",
      formatPricingMoney(result.projectedContributionCents),
    );
    add(
      "Projected monthly profit",
      formatPricingMoney(result.projectedProfitCents),
    );
  } else if (key === "acquisition") {
    const result = models.acquisition;
    add("Planning period (months)", shown(result.horizonMonths));
    add("Total assumed orders", shown(result.totalOrders));
    add(
      "Contribution per customer",
      formatPricingMoney(result.contributionPerCustomerCents),
    );
    add(
      "Net per customer after acquisition and retention",
      formatPricingMoney(result.netPerCustomerCents),
    );
    add(
      "Total acquisition spend",
      formatPricingMoney(result.totalAcquisitionCostCents),
    );
    add(
      "Projected profit over full period",
      formatPricingMoney(result.projectedProfitCents),
    );
    add(
      "Orders to recover acquisition cost",
      shown(result.acquisitionPaybackOrders),
    );
    add(
      "Payback within planning period",
      result.paybackWithinHorizon === null
        ? "Not available"
        : result.paybackWithinHorizon
          ? "Yes, under these assumptions"
          : "No, under these assumptions",
    );
  } else if (key === "workingCapital") {
    const result = models.workingCapital;
    add("Funding gap (days)", shown(result.fundingGapDays));
    add(
      "Cash outlay during period",
      formatPricingMoney(result.periodCashOutlayCents),
    );
    add(
      "Estimated funding required",
      formatPricingMoney(result.estimatedFundingCents),
    );
  }
  return list;
}
function resultRows(key: ModelKey, models: OwnerProfitModels) {
  if (key === "strategies")
    return models.strategies.items.map((item) => ({
      label: strategyLabels[item.strategy],
      status: item.status,
      issues: item.issues,
      metrics: [
        {
          label: "Compared unit price",
          value: formatPricingMoney(item.unitPriceCents),
        },
        {
          label: "Contribution per order",
          value: formatPricingMoney(item.evaluation?.contributionCents),
        },
        {
          label: "Contribution margin",
          value: margin(item.evaluation?.contributionMarginBps ?? null),
        },
      ],
    }));
  if (key === "sensitivity")
    return models.sensitivity.items.map((item) => ({
      label: item.label,
      status: item.status,
      issues: item.issues,
      metrics: [
        {
          label: "Contribution per order",
          value: formatPricingMoney(item.evaluation?.contributionCents),
        },
        {
          label: "Contribution change",
          value: formatPricingMoney(item.contributionDeltaCents),
        },
        {
          label: "Contribution margin",
          value: margin(item.evaluation?.contributionMarginBps ?? null),
        },
      ],
    }));
  if (key === "priceVolume")
    return models.priceVolume.items.map((item) => ({
      label: item.label,
      status: item.status,
      issues: item.issues,
      metrics: [
        { label: "Assumed monthly orders", value: shown(item.orders) },
        {
          label: "Contribution per order",
          value: formatPricingMoney(item.evaluation?.contributionCents),
        },
        {
          label: "Projected monthly revenue",
          value: formatPricingMoney(item.projectedRevenueCents),
        },
        {
          label: "Projected monthly contribution",
          value: formatPricingMoney(item.projectedContributionCents),
        },
        {
          label: "Projected monthly profit",
          value: formatPricingMoney(item.projectedProfitCents),
        },
      ],
    }));
  return [
    {
      label: MODELS.find((model) => model.key === key)!.title,
      status: models[key].status,
      issues: [],
      metrics: metrics(key, models),
    },
  ];
}
function csvCell(value: string) {
  const firstSignificant = Array.from(value).find(
    (character) => character.charCodeAt(0) > 32 && !/\s/.test(character),
  );
  const safe = ["=", "+", "-", "@"].includes(firstSignificant ?? "")
    ? `'${value}`
    : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function PricingOwnerModelsPanel(props: {
  canManage: boolean;
  active: boolean;
  incomingSource: OwnerModelSource | null;
  onItemReview: () => void;
}) {
  if (!props.canManage)
    return <p role="alert">Owner models require pricing manager access.</p>;
  return <OwnerModelsWorkspace {...props} />;
}
function OwnerModelsWorkspace({
  active,
  incomingSource,
  onItemReview,
}: {
  active: boolean;
  incomingSource: OwnerModelSource | null;
  onItemReview: () => void;
}) {
  const qc = useQueryClient();
  const [source, setSource] = useState<OwnerModelSource | null>(incomingSource);
  const [selectedLineId, setSelectedLineId] = useState("");
  const [offset, setOffset] = useState(0);
  const [forms, setForms] = useState<
    Partial<Record<ModelKey, Record<string, string>>>
  >({});
  const [cases, setCases] = useState({
    sensitivity: freshCases(),
    priceVolume: freshCases(),
  });
  const [calculations, setCalculations] = useState<
    Partial<Record<ModelKey, Calculation>>
  >({});
  const [errors, setErrors] = useState<
    Partial<Record<ModelKey, { signature: string; error: unknown }>>
  >({});
  const sourceVersion = useRef(0);
  const signatures = useRef<Partial<Record<ModelKey, string>>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const lastIncoming = useRef(incomingSource);
  for (const model of MODELS)
    signatures.current[model.key] = JSON.stringify({
      source: source?.scenario,
      sourceVersion: sourceVersion.current,
      selectedLineId,
      form: forms[model.key],
      cases: model.caseFields
        ? cases[model.key as "sensitivity" | "priceVolume"]
        : undefined,
    });
  const quotes = useQuery({
    queryKey: [...pricingKey, "owner-models", "quotes", offset],
    queryFn: () => getPricingQuotes(offset),
    enabled: active,
  });
  const loadQuote = useMutation({
    mutationFn: ({
      id,
      session,
    }: {
      id: string;
      version: number;
      session: () => boolean;
    }) => {
      if (!session()) throw new Error("Session changed. Reopen owner models.");
      return getPricingQuote(id);
    },
    onSuccess: (quote, request) => {
      if (
        !mounted.current ||
        !request.session() ||
        request.version !== sourceVersion.current
      )
        return;
      selectSource({
        scenario: quote.scenario,
        label: `Saved review ${quote.id.slice(0, 8)} · revision ${quote.revision}`,
        revision: request.version,
      });
    },
  });
  const refresh = useMutation({
    mutationFn: ({
      scenario,
      session,
    }: {
      scenario: Scenario;
      version: number;
      session: () => boolean;
    }) => {
      if (!session()) throw new Error("Session changed. Reopen owner models.");
      return refreshPricingPortfolioScenario(scenario);
    },
    onSuccess: (resolved, request) => {
      if (
        !mounted.current ||
        !request.session() ||
        request.version !== sourceVersion.current
      )
        return;
      selectSource({
        scenario: resolved.scenario,
        label: "Refreshed catalog scenario",
        revision: request.version,
      });
    },
  });
  const resetLoadQuote = loadQuote.reset;
  const resetRefresh = refresh.reset;
  const selectSource = useCallback(
    (next: OwnerModelSource | null) => {
      sourceVersion.current++;
      setSource(next);
      setSelectedLineId("");
      setCalculations({});
      setErrors({});
      resetLoadQuote();
      resetRefresh();
    },
    [resetLoadQuote, resetRefresh],
  );
  useEffect(() => {
    if (incomingSource !== lastIncoming.current) {
      lastIncoming.current = incomingSource;
      selectSource(incomingSource);
    }
  }, [incomingSource, selectSource]);
  const calculate = useMutation({
    mutationFn: async (request: {
      key: ModelKey;
      signature: string;
      scenario: Scenario;
      assumptions: OwnerProfitAssumptions;
      session: () => boolean;
    }) => {
      if (!request.session())
        throw new Error("Session changed. Reopen owner models.");
      return getPricingOwnerModels(request.scenario, request.assumptions);
    },
    onSuccess: (response, request) => {
      if (
        !mounted.current ||
        !request.session() ||
        signatures.current[request.key] !== request.signature
      )
        return;
      setCalculations((old) => ({
        ...old,
        [request.key]: {
          signature: request.signature,
          assumptions: request.assumptions,
          response,
          session: request.session,
        },
      }));
    },
    onError: (error, request) => {
      if (
        !mounted.current ||
        !request.session() ||
        signatures.current[request.key] !== request.signature
      )
        return;
      setErrors((old) => ({
        ...old,
        [request.key]: { signature: request.signature, error },
      }));
    },
  });
  const edit = (key: ModelKey, field: string, value: string) => {
    setForms((old) => ({ ...old, [key]: { ...old[key], [field]: value } }));
    setErrors((old) => ({ ...old, [key]: undefined }));
  };
  const run = (key: ModelKey) => {
    if (
      !source ||
      calculate.isPending ||
      loadQuote.isPending ||
      refresh.isPending
    )
      return;
    try {
      const model = MODELS.find((item) => item.key === key)!;
      const values: Record<string, unknown> = fieldValues(
        model.fields,
        forms[key] ?? {},
      );
      if (model.caseFields)
        values.cases = cases[key as "sensitivity" | "priceVolume"].map(
          (row, index) => {
            const parsed = fieldValues(model.caseFields!, row.values);
            if (
              key === "priceVolume" &&
              (parsed.unitPriceCents === undefined ||
                parsed.orders === undefined)
            )
              throw new Error(
                `Price case ${index + 1}: enter both a unit price and a whole-number order volume.`,
              );
            return {
              id: row.id,
              label: row.label.trim() || `Case ${index + 1}`,
              ...parsed,
            };
          },
        );
      const assumptions: OwnerProfitAssumptions = { [key]: values };
      if (key === "strategies" || key === "priceVolume") {
        const lineId =
          selectedLineId ||
          (source.scenario.lines.length === 1
            ? source.scenario.lines[0].id
            : "");
        if (!lineId)
          throw new Error(
            "Choose the item whose unit price you want to compare.",
          );
        assumptions.selectedLineId = lineId;
      }
      setErrors((old) => ({ ...old, [key]: undefined }));
      setCalculations((old) => ({ ...old, [key]: undefined }));
      calculate.mutate({
        key,
        signature: signatures.current[key]!,
        scenario: source.scenario,
        assumptions,
        session: captureSessionCacheGuard(qc),
      });
    } catch (error) {
      setErrors((old) => ({
        ...old,
        [key]: { signature: signatures.current[key]!, error },
      }));
    }
  };
  const currentCalculations = MODELS.flatMap((model) => {
    const calculation = calculations[model.key];
    return calculation &&
      calculation.session() &&
      calculation.signature === signatures.current[model.key]
      ? [{ model, calculation }]
      : [];
  });
  const download = () => {
    if (!source || !currentCalculations.length) return;
    const rows: string[][] = [
      ["CareMetric Breathe — owner planning scenarios"],
      [
        "Planning assumptions only. These results do not approve orders, change published prices or predict demand.",
      ],
      ["Source", source.label],
      [
        "Items",
        source.scenario.lines
          .map((line) => `${line.quantity} × ${line.description} (${line.sku})`)
          .join("; "),
      ],
      [
        "Revenue mode",
        source.scenario.revenue.mode === "insurance"
          ? "Expected insurance collections"
          : "Internal self-pay",
      ],
      [
        "Overhead",
        "Explicit fixed costs replace allocated overhead; fixed costs are subtracted once.",
      ],
      ["Model", "Section", "Metric", "Value"],
    ];
    for (const { model, calculation } of currentCalculations) {
      rows.push([
        model.title,
        "Result",
        "Calculated at",
        calculation.response.models.evaluatedAt,
      ]);
      rows.push([
        model.title,
        "Result",
        "Status",
        statusLabels[calculation.response.models[model.key].status],
      ]);
      for (const issue of calculation.response.resolved.evaluation.issues)
        rows.push([model.title, "Source review", issue.path, issue.message]);
      for (const field of model.fields)
        rows.push([
          model.title,
          "Assumption",
          field.label,
          forms[model.key]?.[field.key] || "Not supplied",
        ]);
      if (model.caseFields)
        for (const [index, row] of cases[
          model.key as "sensitivity" | "priceVolume"
        ].entries()) {
          for (const field of model.caseFields)
            rows.push([
              model.title,
              row.label || `Case ${index + 1}`,
              field.label,
              row.values[field.key] || "Not supplied",
            ]);
        }
      for (const row of resultRows(model.key, calculation.response.models)) {
        rows.push([model.title, row.label, "Status", statusLabels[row.status]]);
        for (const metric of row.metrics)
          rows.push([model.title, row.label, metric.label, metric.value]);
        for (const issue of row.issues)
          rows.push([model.title, row.label, "Review note", issue.message]);
      }
      for (const issue of calculation.response.models[model.key].issues)
        rows.push([model.title, "Review note", issue.path, issue.message]);
    }
    const url = URL.createObjectURL(
      new Blob(
        ["\ufeff", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "owner-planning-scenarios.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="min-w-0 space-y-5">
      <PricingSection
        title="Owner models"
        description="Explore pricing and profit with explicit assumptions. These comparisons do not predict demand, change prices or replace order review."
        action={
          <Button
            intent="secondary"
            disabled={!currentCalculations.length}
            onClick={download}
          >
            Download scenario report
          </Button>
        }
      >
        <p className="mb-4 text-sm text-slate-600">
          Each model can be calculated separately. Blank means not supplied.
          Contribution is before allocated overhead; your explicit fixed costs
          replace that allocation and are subtracted once.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <PricingField
              label="Saved review for owner models"
              hint="Choose a saved scenario, or use the action in Item review after evaluating it."
            >
              <select
                className={pricingControl}
                value=""
                disabled={quotes.isFetching || loadQuote.isPending}
                onChange={(event) => {
                  if (!event.target.value) return;
                  selectSource(null);
                  loadQuote.reset();
                  refresh.reset();
                  loadQuote.mutate({
                    id: event.target.value,
                    version: sourceVersion.current,
                    session: captureSessionCacheGuard(qc),
                  });
                }}
              >
                <option value="">Choose a saved review</option>
                {quotes.data?.quotes.map((quote) => (
                  <option
                    key={`${quote.id}:${quote.revision}`}
                    value={quote.id}
                  >
                    {quote.lines
                      .map((line) => `${line.quantity} × ${line.description}`)
                      .join(", ")}{" "}
                    ·{" "}
                    {quote.scenario.revenue.mode === "insurance"
                      ? "Insurance"
                      : "Self-pay"}{" "}
                    · v{quote.revision} · {quote.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </PricingField>
          </div>
          <Button intent="secondary" onClick={onItemReview}>
            Open item review
          </Button>
        </div>
        {quotes.isPending && active && (
          <p role="status" className="mt-3 text-sm">
            Loading saved scenarios…
          </p>
        )}
        {quotes.error && (
          <ErrorPanel
            error={quotes.error}
            onRetry={() => void quotes.refetch()}
          />
        )}
        {quotes.data?.quotes.length === 0 && (
          <p className="mt-3 text-sm text-slate-600">
            No saved reviews on this page. Evaluate an item to begin.
          </p>
        )}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            intent="ghost"
            disabled={!offset || quotes.isFetching}
            onClick={() => setOffset((value) => Math.max(0, value - 50))}
          >
            Previous saved scenarios
          </Button>
          <Button
            intent="ghost"
            disabled={!quotes.data?.hasMore || quotes.isFetching}
            onClick={() => setOffset((value) => value + 50)}
          >
            Next saved scenarios
          </Button>
        </div>
        {loadQuote.isPending && <p role="status">Loading selected scenario…</p>}
        {loadQuote.error && (
          <ErrorPanel
            error={loadQuote.error}
            onRetry={() => {
              const request = loadQuote.variables;
              if (request)
                loadQuote.mutate({
                  ...request,
                  version: sourceVersion.current,
                  session: captureSessionCacheGuard(qc),
                });
            }}
          />
        )}
        {source ? (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="font-medium text-slate-900">{source.label}</p>
            <p className="mt-1 break-words text-sm">
              {source.scenario.lines
                .map(
                  (line) =>
                    `${line.quantity} × ${line.description} (${line.sku})`,
                )
                .join(" · ")}
            </p>
            <p className="mt-2 text-sm text-slate-600">
              {source.scenario.revenue.mode === "insurance"
                ? "Insurance: models use expected collections; pricing alternatives do not change insurer reimbursement."
                : "Internal self-pay scenario: no patient payment is created."}
            </p>
            <p className="mt-2 text-xs text-slate-600">
              Evidence deadline:{" "}
              {new Date(source.scenario.validUntil).toLocaleString()}.
              Calculations recheck the source evidence.
            </p>
            {Date.parse(source.scenario.validUntil) <= Date.now() && (
              <p role="status" className="mt-2 text-sm text-amber-900">
                This review has expired. Refresh catalog assumptions where
                available, or complete a fresh item review with current
                evidence.
              </p>
            )}
            {!source.scenario.patientId && (
              <Button
                className="mt-3"
                intent="secondary"
                isLoading={refresh.isPending}
                onClick={() => {
                  setCalculations({});
                  setErrors({});
                  refresh.mutate({
                    scenario: source.scenario,
                    version: sourceVersion.current,
                    session: captureSessionCacheGuard(qc),
                  });
                }}
              >
                Refresh catalog assumptions
              </Button>
            )}
            {source.scenario.lines.length > 1 && (
              <div className="mt-3">
                <PricingField
                  label="Item to reprice in strategy and volume models"
                  hint="Other item prices and quantities stay as reviewed."
                >
                  <select
                    className={pricingControl}
                    value={selectedLineId}
                    onChange={(event) => setSelectedLineId(event.target.value)}
                  >
                    <option value="">Choose an item</option>
                    {source.scenario.lines.map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.description} · {line.sku} · quantity{" "}
                        {line.quantity}
                      </option>
                    ))}
                  </select>
                </PricingField>
              </div>
            )}
          </div>
        ) : (
          <p role="status" className="mt-4 text-sm text-slate-600">
            Select a source scenario before calculating. Your model assumptions
            stay here while you switch workspace tabs.
          </p>
        )}
        {refresh.error && (
          <ErrorPanel
            error={refresh.error}
            onRetry={() => {
              if (source)
                refresh.mutate({
                  scenario: source.scenario,
                  version: sourceVersion.current,
                  session: captureSessionCacheGuard(qc),
                });
            }}
          />
        )}
      </PricingSection>
      {MODELS.map((model) => {
        const calculation = calculations[model.key];
        const result =
          calculation?.session() &&
          calculation.signature === signatures.current[model.key]
            ? calculation.response.models[model.key]
            : null;
        const sourceIssueKeys = new Set(
          calculation?.response.resolved.evaluation.issues.map((issue) =>
            JSON.stringify([issue.code, issue.path, issue.message]),
          ),
        );
        const modelIssues =
          result?.issues.filter(
            (issue) =>
              !sourceIssueKeys.has(
                JSON.stringify([issue.code, issue.path, issue.message]),
              ),
          ) ?? [];
        const error =
          errors[model.key]?.signature === signatures.current[model.key]
            ? errors[model.key]?.error
            : undefined;
        return (
          <PricingSection
            key={model.key}
            title={model.title}
            description={model.description}
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {model.fields.map((field) => (
                <OwnerField
                  key={field.key}
                  field={field}
                  value={forms[model.key]?.[field.key] ?? ""}
                  onChange={(value) => edit(model.key, field.key, value)}
                />
              ))}
            </div>
            {model.caseFields && (
              <div className="mt-3 space-y-3">
                {cases[model.key as "sensitivity" | "priceVolume"].map(
                  (row, index) => (
                    <fieldset
                      key={row.id}
                      className="min-w-0 rounded-lg border border-slate-200 p-3"
                    >
                      <legend className="px-1 text-sm font-semibold">
                        {model.key === "sensitivity" ? "Stress" : "Price"} case{" "}
                        {index + 1}
                      </legend>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <PricingField label={`Case ${index + 1} name`}>
                          <input
                            className={pricingControl}
                            value={row.label}
                            maxLength={120}
                            placeholder="Optional description"
                            onChange={(event) =>
                              setCases((old) => ({
                                ...old,
                                [model.key]: old[
                                  model.key as "sensitivity" | "priceVolume"
                                ].map((item) =>
                                  item.id === row.id
                                    ? { ...item, label: event.target.value }
                                    : item,
                                ),
                              }))
                            }
                          />
                        </PricingField>
                        {model.caseFields!.map((field) => (
                          <OwnerField
                            key={field.key}
                            field={field}
                            value={row.values[field.key] ?? ""}
                            onChange={(value) =>
                              setCases((old) => ({
                                ...old,
                                [model.key]: old[
                                  model.key as "sensitivity" | "priceVolume"
                                ].map((item) =>
                                  item.id === row.id
                                    ? {
                                        ...item,
                                        values: {
                                          ...item.values,
                                          [field.key]: value,
                                        },
                                      }
                                    : item,
                                ),
                              }))
                            }
                          />
                        ))}
                      </div>
                      {cases[model.key as "sensitivity" | "priceVolume"]
                        .length > 1 && (
                        <Button
                          intent="ghost"
                          className="mt-2"
                          onClick={() =>
                            setCases((old) => ({
                              ...old,
                              [model.key]: old[
                                model.key as "sensitivity" | "priceVolume"
                              ].filter((item) => item.id !== row.id),
                            }))
                          }
                        >
                          Remove case {index + 1}
                        </Button>
                      )}
                    </fieldset>
                  ),
                )}
                <Button
                  intent="secondary"
                  disabled={
                    cases[model.key as "sensitivity" | "priceVolume"].length >=
                    12
                  }
                  onClick={() =>
                    setCases((old) => ({
                      ...old,
                      [model.key]: [
                        ...old[model.key as "sensitivity" | "priceVolume"],
                        ...freshCases(),
                      ],
                    }))
                  }
                >
                  Add {model.key === "sensitivity" ? "stress" : "price"} case
                </Button>
              </div>
            )}
            <Button
              className="mt-4"
              intent="secondary"
              disabled={
                !source ||
                calculate.isPending ||
                loadQuote.isPending ||
                refresh.isPending
              }
              isLoading={
                calculate.isPending && calculate.variables?.key === model.key
              }
              onClick={() => run(model.key)}
            >
              Calculate {model.title.toLowerCase()}
            </Button>
            {error != null && (
              <div className="mt-3">
                <ErrorPanel
                  title="Couldn't calculate this model"
                  error={error}
                  onRetry={() => run(model.key)}
                />
                <p className="mt-2 text-sm text-slate-600">
                  If the source review or evidence expired, refresh its catalog
                  assumptions or return to Item review. Patient-linked evidence
                  needs a fresh review; expiry is never extended automatically.
                </p>
              </div>
            )}
            {result && calculation && (
              <div className="mt-4 space-y-3" aria-live="polite">
                <p className="text-sm font-semibold text-slate-900">
                  {statusLabels[result.status]}
                </p>
                <p className="text-xs text-slate-600">
                  Calculated{" "}
                  {new Date(
                    calculation.response.models.evaluatedAt,
                  ).toLocaleString()}{" "}
                  · planning assumptions only
                </p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Source review:</span>
                  <PricingStatus
                    state={calculation.response.resolved.evaluation.state}
                  />
                </div>
                {calculation.response.resolved.evaluation.issues.length > 0 && (
                  <ul
                    aria-label="Source review issues"
                    className="list-disc space-y-1 pl-5 text-sm text-amber-900"
                  >
                    {calculation.response.resolved.evaluation.issues.map(
                      (issue, index) => (
                        <li key={`${issue.code}:${index}`}>{issue.message}</li>
                      ),
                    )}
                  </ul>
                )}
                {modelIssues.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
                    {modelIssues.map((issue, index) => (
                      <li key={`${issue.code}:${index}`}>{issue.message}</li>
                    ))}
                  </ul>
                )}
                {resultRows(model.key, calculation.response.models).map(
                  (row, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-slate-200 p-3"
                    >
                      {(model.caseFields || model.key === "strategies") && (
                        <p className="mb-3 text-sm font-semibold">
                          {row.label} · {statusLabels[row.status]}
                        </p>
                      )}
                      {row.issues.length > 0 && (
                        <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-amber-900">
                          {row.issues.map((issue, issueIndex) => (
                            <li key={`${issue.code}:${issueIndex}`}>
                              {issue.message}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {row.metrics.map((metric) => (
                          <PricingMetric
                            key={metric.label}
                            label={metric.label}
                            value={metric.value}
                          />
                        ))}
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
          </PricingSection>
        );
      })}
    </div>
  );
}
function OwnerField({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <PricingField label={field.label} hint={field.hint}>
      <input
        className={pricingControl}
        inputMode={field.kind === "count" ? "numeric" : "decimal"}
        value={value}
        placeholder="Enter an assumption"
        onChange={(event) => onChange(event.target.value)}
      />
    </PricingField>
  );
}
