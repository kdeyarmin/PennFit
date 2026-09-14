import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { ApiError } from "@workspace/api-client-react/admin";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  activatePricingBatch,
  cancelPricingBatchSchedule,
  schedulePricingBatch,
  approvePricingQuote,
  closePricingActuals,
  getPricingActuals,
  getPricingBatches,
  getPricingQuotes,
  getPricingSummary,
  previewPricingBatch,
  recommendPricingScenario,
  pricingKey,
  savePricingActual,
  type ActualEvent,
  type PriceBatch,
  type PricingState,
  type Quote,
  type Scenario,
} from "@/lib/admin/pricing-api";
import {
  formatPricingMoney,
  parsePricingMoney,
  pricingMoneyInput,
} from "@/lib/admin/pricing-input";
import { PricingEvaluationResult } from "./PricingItemReview";
import { PricingVolumeScenarios } from "./PricingVolumeScenarios";
import { PricingPortfolioPanel } from "./PricingPortfolioPanel";
import {
  PricingField,
  PricingMetric,
  PricingNotice,
  PricingSection,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";

export function PricingQuotesPanel({
  canApprove,
  canManage,
}: {
  canApprove: boolean;
  canManage: boolean;
}) {
  const qc = useQueryClient(),
    [offset, setOffset] = useState(0),
    [pendingOnly, setPendingOnly] = useState(false),
    [selected, setSelected] = useState<Quote | null>(null),
    [reason, setReason] = useState(""),
    [exception, setException] = useState(false);
  const summary = useQuery({
    queryKey: [...pricingKey, "summary"],
    queryFn: getPricingSummary,
    enabled: canManage,
  });
  const quotes = useQuery({
    queryKey: [...pricingKey, "quotes", offset, pendingOnly],
    queryFn: () =>
      getPricingQuotes(
        offset,
        pendingOnly ? { status: "pending_approval" } : {},
      ),
  });
  const approve = useMutation({
    mutationFn: () =>
      approvePricingQuote(selected!.id, {
        expectedRevision: selected!.revision,
        reason: reason.trim(),
        allowException: exception,
      }),
    onSuccess: (data) => {
      setSelected(data);
      setReason("");
      setException(false);
      void qc.invalidateQueries({ queryKey: [...pricingKey, "quotes"] });
    },
  });
  return (
    <div className="space-y-5">
      {canManage && (
        <PricingSection
          title="Portfolio profitability"
          description="Margins use total contribution divided by total revenue; individual order percentages are never averaged. Incomplete orders are reported separately."
        >
          {summary.isPending ? (
            <p role="status">Loading profitability totals…</p>
          ) : summary.error ? (
            <ErrorPanel
              error={summary.error}
              onRetry={() => void summary.refetch()}
            />
          ) : (
            <div className="space-y-4">
              {summary.data?.groups.map((group) => (
                <div key={group.status}>
                  <p className="mb-2 text-sm font-semibold">
                    {group.status === "settled"
                      ? "Settled orders"
                      : "Incomplete / provisional orders"}{" "}
                    · {group.quoteCount}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-4">
                    <PricingMetric
                      label="Recorded revenue"
                      value={formatPricingMoney(group.revenueCents)}
                    />
                    <PricingMetric
                      label="Recorded costs"
                      value={formatPricingMoney(group.costCents)}
                    />
                    <PricingMetric
                      label="Contribution"
                      value={formatPricingMoney(group.contributionCents)}
                    />
                    <PricingMetric
                      label="Weighted margin"
                      value={
                        group.marginBps === null
                          ? "Not available"
                          : `${(group.marginBps / 100).toFixed(2)}%`
                      }
                    />
                  </div>
                  {group.incompleteQuotedCount > 0 && (
                    <p className="mt-2 text-xs text-amber-800">
                      {group.incompleteQuotedCount} reviews have incomplete
                      original cost or revenue assumptions.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </PricingSection>
      )}
      <PricingSection
        title="Saved reviews and approvals"
        description="An approved review locks the assumptions and line amounts for an order. Expired or changed dependencies are checked again before an order can use it."
      >
        <label className="mb-4 flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => {
              setPendingOnly(e.target.checked);
              setOffset(0);
              setSelected(null);
            }}
          />
          Show pending approvals
        </label>
        {quotes.isPending ? (
          <p role="status">Loading saved reviews…</p>
        ) : quotes.error ? (
          <ErrorPanel
            error={quotes.error}
            onRetry={() => void quotes.refetch()}
          />
        ) : (
          <div className="space-y-2">
            {quotes.data?.quotes
              .filter((q) => !pendingOnly || q.status === "pending_approval")
              .map((q) => (
                <button
                  type="button"
                  key={q.id}
                  className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-left focus:ring-2 focus:ring-slate-500 ${selected?.id === q.id ? "border-slate-800 bg-slate-50" : "border-slate-200"}`}
                  onClick={() => {
                    setSelected(q);
                    setReason("");
                    setException(false);
                    approve.reset();
                  }}
                >
                  <div>
                    <p className="font-medium">
                      {q.lines.map((l) => l.description).join(", ")}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {q.scenario.revenue.mode === "insurance"
                        ? "Insurance review"
                        : "Internal self-pay scenario"}{" "}
                      · Revision {q.revision} · Expires{" "}
                      {q.validUntil.slice(0, 10)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <PricingStatus state={q.status} />
                    <PricingStatus state={q.evaluation.state} />
                  </div>
                </button>
              ))}
            {quotes.data?.quotes.filter(
              (q) => !pendingOnly || q.status === "pending_approval",
            ).length === 0 && (
              <p className="text-sm text-slate-500">
                No matching reviews on this page.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                intent="ghost"
                disabled={!offset || quotes.isFetching}
                onClick={() => {
                  setOffset((n) => n - 50);
                  setSelected(null);
                }}
              >
                Previous reviews
              </Button>
              <Button
                intent="ghost"
                disabled={!quotes.data?.hasMore || quotes.isFetching}
                onClick={() => {
                  setOffset((n) => n + 50);
                  setSelected(null);
                }}
              >
                Next reviews
              </Button>
            </div>
          </div>
        )}
      </PricingSection>
      {selected && (
        <PricingSection
          title={`Review revision ${selected.revision}`}
          action={<PricingStatus state={selected.status} />}
        >
          <PricingEvaluationResult result={selected} />
          {canApprove &&
            selected.status !== "bound" &&
            selected.status !== "approved" && (
              <div className="mt-5 space-y-3 border-t border-slate-100 pt-4">
                <PricingField
                  label="Approval evidence and reason"
                  hint="At least 10 characters. Verify collection assumptions and supplier evidence before approving."
                >
                  <textarea
                    className={pricingControl}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                  />
                </PricingField>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={exception}
                    onChange={(e) => setException(e.target.checked)}
                  />
                  <span>
                    Approve a permitted exception after reviewing the recorded
                    evidence
                  </span>
                </label>
                <Button
                  disabled={
                    reason.trim().length < 10 ||
                    Date.parse(selected.validUntil) <= Date.now()
                  }
                  isLoading={approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  Approve review
                </Button>
                {approve.error && (
                  <ErrorPanel
                    error={approve.error}
                    onRetry={() => void quotes.refetch()}
                  />
                )}
              </div>
            )}
          {selected.approvedAt && (
            <p className="mt-3 text-xs text-emerald-800">
              Approval recorded {new Date(selected.approvedAt).toLocaleString()}
              .
            </p>
          )}
        </PricingSection>
      )}
      {selected && (
        <PricingActualsPanel
          key={selected.id}
          quoteId={selected.id}
          canManage={canManage}
        />
      )}
    </div>
  );
}

function PricingActualsPanel({
  quoteId,
  canManage,
}: {
  quoteId: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [eventOffset, setEventOffset] = useState(0);
  const actuals = useQuery({
    queryKey: [...pricingKey, "actuals", quoteId, eventOffset],
    queryFn: () => getPricingActuals(quoteId, eventOffset),
  });
  const [source, setSource] =
      useState<ActualEvent["source"]>("supplier_invoice"),
    [sourceRef, setSourceRef] = useState(""),
    [eventId, setEventId] = useState(""),
    [amount, setAmount] = useState(""),
    [kind, setKind] = useState<ActualEvent["kind"]>("cost"),
    [notes, setNotes] = useState(""),
    [lineId, setLineId] = useState(""),
    [error, setError] = useState<string | null>(null);
  const [completenessDraft, setCompletenessDraft] = useState<{
    revision: number;
    costsComplete: boolean;
    revenueComplete: boolean;
  } | null>(null);
  const [closeReason, setCloseReason] = useState("");
  const costsComplete =
    completenessDraft?.costsComplete ?? actuals.data?.costsComplete ?? false;
  const revenueComplete =
    completenessDraft?.revenueComplete ??
    actuals.data?.revenueComplete ??
    false;
  const completenessChanged =
    completenessDraft !== null &&
    actuals.data !== undefined &&
    completenessDraft.revision !== actuals.data.revision;
  const editCompleteness = (
    patch: Partial<{ costsComplete: boolean; revenueComplete: boolean }> = {},
  ) => {
    if (!actuals.data) return;
    setCompletenessDraft((draft) => ({
      revision: draft?.revision ?? actuals.data!.revision,
      costsComplete: draft?.costsComplete ?? actuals.data!.costsComplete,
      revenueComplete: draft?.revenueComplete ?? actuals.data!.revenueComplete,
      ...patch,
    }));
  };
  const save = useMutation({
    mutationFn: (body: Omit<ActualEvent, "id" | "createdAt">) =>
      savePricingActual(quoteId, body),
    onSuccess: () => {
      setEventId("");
      setAmount("");
      setNotes("");
      void qc.invalidateQueries({
        queryKey: [...pricingKey, "actuals", quoteId],
      });
    },
  });
  const close = useMutation({
    mutationFn: () => {
      if (!actuals.data || completenessChanged)
        throw new Error("Review the latest completeness status before saving.");
      return closePricingActuals(quoteId, {
        expectedRevision: completenessDraft?.revision ?? actuals.data.revision,
        costsComplete,
        revenueComplete,
        reason: closeReason.trim(),
      });
    },
    onSuccess: () => {
      setCompletenessDraft(null);
      setCloseReason("");
      void qc.invalidateQueries({
        queryKey: [...pricingKey, "actuals", quoteId],
      });
      void qc.invalidateQueries({ queryKey: [...pricingKey, "summary"] });
    },
  });
  const submit = () => {
    setError(null);
    const amountCents = parsePricingMoney(amount);
    if (amountCents === null || !sourceRef.trim() || !eventId.trim()) {
      setError(
        "Enter a dollar amount, source document reference, and unique economic event reference.",
      );
      return;
    }
    save.mutate({
      source,
      sourceRef: sourceRef.trim(),
      economicEventId: eventId.trim(),
      kind,
      amountCents,
      occurredAt: new Date().toISOString(),
      ...(lineId ? { lineId } : {}),
      notes: notes.trim() || undefined,
    });
  };
  return (
    <PricingSection
      title="Quoted vs. actual profitability"
      description="Record invoices, collections, refunds and supplier credits once. A settlement remains provisional until both cost and collection evidence are complete."
    >
      {actuals.isPending ? (
        <p role="status">Loading actual results…</p>
      ) : actuals.error ? (
        <div className="space-y-3">
          <ErrorPanel
            error={actuals.error}
            onRetry={() => void actuals.refetch()}
          />
          {eventOffset > 0 && (
            <Button intent="secondary" onClick={() => setEventOffset(0)}>
              Return to first actual events
            </Button>
          )}
        </div>
      ) : (
        actuals.data && (
          <div className="space-y-5">
            <PricingStatus
              state={actuals.data.settled ? "settled" : "provisional"}
            />
            {actuals.data.forecast && (
              <div className="rounded-lg border border-slate-200 p-4">
                <h3 className="text-sm font-semibold">Current forecast</h3>
                {actuals.data.forecast.evaluation ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <PricingMetric
                      label="Forecast collections"
                      value={formatPricingMoney(
                        actuals.data.forecast.evaluation.netRevenueCents,
                      )}
                    />
                    <PricingMetric
                      label="Forecast variable costs"
                      value={formatPricingMoney(
                        actuals.data.forecast.evaluation.totalVariableCostCents,
                      )}
                    />
                    <PricingMetric
                      label="Forecast contribution"
                      value={formatPricingMoney(
                        actuals.data.forecast.evaluation.contributionCents,
                      )}
                    />
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-amber-800">
                    Forecast unavailable:{" "}
                    {actuals.data.forecast.reason?.replaceAll("_", " ") ??
                      "Current costs need review"}
                    .
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-500">
                  Rechecked{" "}
                  {new Date(actuals.data.forecast.evaluatedAt).toLocaleString()}
                  . Original quoted terms remain unchanged.
                </p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <PricingMetric
                label="Actual collections"
                value={formatPricingMoney(actuals.data.actualRevenueCents)}
                detail={
                  actuals.data.revenueComplete
                    ? "Complete"
                    : "Provisional — collections incomplete"
                }
              />
              <PricingMetric
                label="Actual costs"
                value={formatPricingMoney(actuals.data.actualCostCents)}
                detail={
                  actuals.data.costsComplete
                    ? "Complete"
                    : "Provisional — costs incomplete"
                }
              />
              <PricingMetric
                label="Actual contribution"
                value={formatPricingMoney(actuals.data.actualContributionCents)}
              />
              <PricingMetric
                label="Actual margin"
                value={
                  actuals.data.actualMarginBps === null
                    ? "Not available"
                    : `${(actuals.data.actualMarginBps / 100).toFixed(2)}%`
                }
              />
            </div>
            <p className="text-sm text-slate-600">
              Cost variance:{" "}
              {formatPricingMoney(actuals.data.costVarianceCents)} · Collection
              variance: {formatPricingMoney(actuals.data.revenueVarianceCents)}
            </p>
            <div className="space-y-2">
              {actuals.data.events.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No actual costs or collections recorded.
                </p>
              ) : (
                actuals.data.events.map((event) => (
                  <div
                    key={event.id}
                    className="flex flex-wrap justify-between gap-2 rounded border border-slate-200 p-3 text-sm"
                  >
                    <span>
                      {event.source.replaceAll("_", " ")} · {event.sourceRef} ·{" "}
                      {event.economicEventId}
                    </span>
                    <strong>
                      {event.kind.replaceAll("_", " ")}{" "}
                      {formatPricingMoney(event.amountCents)}
                    </strong>
                  </div>
                ))
              )}
            </div>
            {actuals.data.eventPage && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-600">
                  Showing{" "}
                  {actuals.data.events.length
                    ? actuals.data.eventPage.offset + 1
                    : 0}
                  –{actuals.data.eventPage.offset + actuals.data.events.length}{" "}
                  of {actuals.data.eventPage.total} events. Profitability totals
                  include all events.
                </p>
                <div className="flex gap-2">
                  <Button
                    intent="ghost"
                    disabled={eventOffset === 0 || actuals.isFetching}
                    onClick={() =>
                      setEventOffset(
                        Math.max(
                          0,
                          eventOffset - actuals.data!.eventPage.limit,
                        ),
                      )
                    }
                  >
                    Previous actual events
                  </Button>
                  <Button
                    intent="ghost"
                    disabled={
                      !actuals.data.eventPage.hasMore || actuals.isFetching
                    }
                    onClick={() =>
                      setEventOffset(
                        eventOffset + actuals.data!.eventPage.limit,
                      )
                    }
                  >
                    Next actual events
                  </Button>
                </div>
              </div>
            )}
            {canManage && (
              <>
                <div className="grid gap-3 md:grid-cols-3">
                  <PricingField label="Actual event source">
                    <select
                      className={pricingControl}
                      value={source}
                      onChange={(e) => {
                        const s = e.target.value as ActualEvent["source"];
                        setSource(s);
                        setKind(
                          s === "collection"
                            ? "revenue"
                            : s === "refund"
                              ? "refund"
                              : s === "supplier_credit"
                                ? "cost_credit"
                                : "cost",
                        );
                      }}
                    >
                      {[
                        "supplier_invoice",
                        "freight_invoice",
                        "payment_fee",
                        "collection",
                        "refund",
                        "supplier_credit",
                        "adjustment",
                      ].map((s) => (
                        <option key={s} value={s}>
                          {s.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </PricingField>
                  <PricingField label="Economic effect">
                    <select
                      className={pricingControl}
                      value={kind}
                      disabled={source !== "adjustment"}
                      onChange={(e) =>
                        setKind(e.target.value as ActualEvent["kind"])
                      }
                    >
                      {["cost", "revenue", "refund", "cost_credit"].map((s) => (
                        <option key={s} value={s}>
                          {s.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </PricingField>
                  <PricingField label="Actual amount ($)">
                    <input
                      className={pricingControl}
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </PricingField>
                  <PricingField label="Source document reference">
                    <input
                      className={pricingControl}
                      value={sourceRef}
                      onChange={(e) => setSourceRef(e.target.value)}
                      placeholder="Invoice or remittance reference"
                    />
                  </PricingField>
                  <PricingField
                    label="Unique economic event reference"
                    hint="Use the same reference for the same expense across imports."
                  >
                    <input
                      className={pricingControl}
                      value={eventId}
                      onChange={(e) => setEventId(e.target.value)}
                    />
                  </PricingField>
                  <PricingField label="Allocate to item">
                    <select
                      className={pricingControl}
                      value={lineId}
                      onChange={(e) => setLineId(e.target.value)}
                    >
                      <option value="">Whole order</option>
                      {actuals.data.quote.lines.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.description}
                        </option>
                      ))}
                    </select>
                  </PricingField>
                  <PricingField label="Actual event notes">
                    <input
                      className={pricingControl}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </PricingField>
                </div>
                {error && (
                  <p role="alert" className="text-sm text-red-700">
                    {error}
                  </p>
                )}
                <Button isLoading={save.isPending} onClick={submit}>
                  Record actual event
                </Button>
                {save.error && (
                  <ErrorPanel error={save.error} onRetry={submit} />
                )}
                <div className="space-y-3 border-t border-slate-200 pt-4">
                  <h3 className="text-sm font-semibold">
                    Confirm completeness
                  </h3>
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={costsComplete}
                      disabled={close.isPending}
                      onChange={(e) =>
                        editCompleteness({ costsComplete: e.target.checked })
                      }
                    />
                    All supplier and fulfillment costs are recorded
                  </label>
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={revenueComplete}
                      disabled={close.isPending}
                      onChange={(e) =>
                        editCompleteness({ revenueComplete: e.target.checked })
                      }
                    />
                    All collections, refunds and credits are recorded
                  </label>
                  <PricingField label="Completeness evidence / reason">
                    <textarea
                      className={pricingControl}
                      value={closeReason}
                      disabled={close.isPending}
                      onChange={(e) => {
                        editCompleteness();
                        setCloseReason(e.target.value);
                      }}
                      rows={2}
                    />
                  </PricingField>
                  <Button
                    intent="secondary"
                    isLoading={close.isPending}
                    disabled={
                      closeReason.trim().length < 10 ||
                      actuals.isFetching ||
                      completenessChanged
                    }
                    onClick={() => close.mutate()}
                  >
                    Save reconciliation status
                  </Button>
                  {completenessChanged && (
                    <div
                      role="status"
                      className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
                    >
                      Recorded actuals changed while you were editing. Your
                      choices are preserved; reload and review the latest
                      completeness status before saving.
                      <Button
                        className="mt-2"
                        intent="secondary"
                        onClick={() => {
                          setCompletenessDraft(null);
                          close.reset();
                        }}
                      >
                        Reload completeness status
                      </Button>
                    </div>
                  )}
                  {close.error && (
                    <ErrorPanel
                      error={close.error}
                      onRetry={() => void actuals.refetch()}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        )
      )}
    </PricingSection>
  );
}

export function PricingBatchesPanel({
  scenarios,
  onClear,
  state,
  canPublish,
  onReviewItem,
  canManage = false,
}: {
  scenarios: Scenario[];
  onClear: () => void;
  state: PricingState;
  canPublish: boolean;
  onReviewItem?: (item: { sku: string; name: string }) => void;
  canManage?: boolean;
}) {
  const qc = useQueryClient();
  const [confirm, dialog] = useConfirmDialog();
  const [name, setName] = useState(""),
    [preview, setPreview] = useState<PriceBatch | null>(null),
    [notice, setNotice] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [selectedEntries, setSelectedEntries] = useState<number[]>([]);
  const [portfolioScenarios, setPortfolioScenarios] = useState<Scenario[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [recommendedLines, setRecommendedLines] = useState<
    Record<string, string>
  >({});
  const [workingError, setWorkingError] = useState("");
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [portfolioVersion, setPortfolioVersion] = useState(0);
  const working = [...scenarios, ...portfolioScenarios];
  const occurrences = new Map<string, number>();
  const workingKeys = working.map((scenario) => {
    const value = JSON.stringify(scenario),
      occurrence = occurrences.get(value) ?? 0;
    occurrences.set(value, occurrence + 1);
    return `${value}:${occurrence}`;
  });
  const workingKey = (_scenario: Scenario, index: number) => workingKeys[index];
  const includedCount = working.filter(
    (_, index) => !excluded[workingKeys[index]],
  ).length;
  const editedScenario = (scenario: Scenario, index: number): Scenario => ({
    ...scenario,
    lines: scenario.lines.map((line) => {
      const key = `${workingKey(scenario, index)}:${line.id}`;
      const amount =
        amounts[key] === undefined
          ? line.unitAmountCents
          : parsePricingMoney(amounts[key]);
      if (amount === null)
        throw new Error(`Enter a valid dollar amount for ${line.description}.`);
      return { ...line, unitAmountCents: amount };
    }),
  });
  const recommendation = useMutation({
    mutationFn: ({
      scenario,
      lineId,
    }: {
      scenario: Scenario;
      lineId: string;
      key: string;
    }) => recommendPricingScenario(scenario, lineId),
    onSuccess: (data, request) => {
      const result = data.recommendation;
      if (
        result.status !== "recommended" ||
        result.recommendedUnitPriceCents == null
      ) {
        setWorkingError(
          `Recommendation unavailable: ${result.status.replaceAll("_", " ")}. Review this scenario's costs and assumptions.`,
        );
        return;
      }
      setAmounts((old) => ({
        ...old,
        [`${request.key}:${request.lineId}`]: pricingMoneyInput(
          result.recommendedUnitPriceCents,
        ),
      }));
      setWorkingError("");
    },
  });
  const bulkRecommendation = useMutation({
    mutationFn: async (
      entries: Array<{ scenario: Scenario; lineId: string; key: string }>,
    ) => {
      const current = captureSessionCacheGuard(qc);
      const updated: Record<string, string> = {},
        failures: string[] = [];
      for (let index = 0; index < entries.length; index += 4) {
        if (!current())
          throw new Error(
            "The session changed. Review the selected scenarios again.",
          );
        const group = entries.slice(index, index + 4);
        const results = await Promise.allSettled(
          group.map((request) =>
            recommendPricingScenario(request.scenario, request.lineId),
          ),
        );
        if (!current())
          throw new Error(
            "The session changed. Review the selected scenarios again.",
          );
        results.forEach((result, offset) => {
          const request = group[offset];
          if (
            result.status === "fulfilled" &&
            result.value.recommendation.status === "recommended" &&
            result.value.recommendation.recommendedUnitPriceCents != null
          )
            updated[`${request.key}:${request.lineId}`] = pricingMoneyInput(
              result.value.recommendation.recommendedUnitPriceCents,
            );
          else
            failures.push(
              `${request.scenario.lines.map((line) => line.sku).join(", ")}: ${result.status === "rejected" ? (result.reason instanceof Error ? result.reason.message : "Recommendation failed") : result.value.recommendation.status.replaceAll("_", " ")}`,
            );
        });
      }
      if (failures.length)
        throw new Error(
          `No amounts were changed. Review these scenarios or explicitly exclude them: ${failures.join("; ")}`,
        );
      return updated;
    },
    onSuccess: (updated, entries) => {
      setAmounts((old) => ({ ...old, ...updated }));
      setNotice(
        `Target prices applied to ${entries.length} selected self-pay scenarios. Insurance collection assumptions were preserved. Create a frozen preview to verify the full change.`,
      );
      setWorkingError("");
    },
  });
  const recommending = recommendation.isPending || bulkRecommendation.isPending;
  const subset = useMutation({
    mutationFn: () =>
      previewPricingBatch({
        name: `${preview!.name} — selected ${selectedEntries.length}`,
        scenarios: preview!.entries
          .filter((_, index) => selectedEntries.includes(index))
          .map((entry) => entry.scenario),
      }),
    onSuccess: (batch) => {
      setPreview(batch);
      setSelectedEntries([]);
      void qc.invalidateQueries({ queryKey: [...pricingKey, "batches"] });
    },
  });
  const schedule = useMutation({
    mutationFn: ({ id, cancel }: { id: string; cancel?: boolean }) =>
      cancel
        ? cancelPricingBatchSchedule(id, state.revision)
        : schedulePricingBatch(
            id,
            state.revision,
            new Date(scheduledAt).toISOString(),
          ),
    onSuccess: () => {
      setNotice(
        "Activation schedule updated. Costs and policy validity will be checked again at the scheduled time.",
      );
      void qc.invalidateQueries({ queryKey: pricingKey });
    },
  });
  const batches = useQuery({
    queryKey: [...pricingKey, "batches"],
    queryFn: getPricingBatches,
  });
  const makePreview = useMutation({
    mutationFn: (snapshot: { name: string; scenarios: Scenario[] }) =>
      previewPricingBatch(snapshot),
    onSuccess: (data) => {
      setPreview(data);
      setSelectedEntries([]);
      void qc.invalidateQueries({ queryKey: [...pricingKey, "batches"] });
    },
  });
  const activate = useMutation({
    mutationFn: (id: string) => activatePricingBatch(id, state.revision),
    onSuccess: () => {
      setNotice(
        "Internal price list activated for future quotes. Existing order terms were preserved.",
      );
      setPreview(null);
      setPortfolioScenarios([]);
      setAmounts({});
      setExcluded({});
      setPortfolioVersion((old) => old + 1);
      onClear();
      void qc.invalidateQueries({ queryKey: pricingKey });
    },
  });
  const publish = async (batch: PriceBatch) => {
    const current = captureSessionCacheGuard(qc);
    const changedPrices = batch.entries.some(
      (entry) =>
        entry.comparison &&
        entry.comparison.previousPriceListId !== state.activePriceListId,
    );
    if (
      (await confirm({
        title: "Activate internal price list?",
        description: `Activate the saved snapshot “${batch.name}” with ${batch.entries.length} reviewed scenarios${batch.retainedEntryCount != null ? ` (${batch.selectedEntryCount} selected updates and ${batch.retainedEntryCount} retained published contexts)` : ""}? ${changedPrices ? "The active price list has changed since this comparison was frozen. This explicitly restores the saved amounts rather than recalculating a change from today's prices. " : ""}Supplier versions and policy validity will be checked again.`,
        confirmLabel: "Activate price list",
      })) &&
      current()
    )
      activate.mutate(batch.id);
  };
  return (
    <div className="space-y-5">
      {dialog}
      {notice && <PricingNotice>{notice}</PricingNotice>}
      {canManage && (
        <PricingPortfolioPanel
          key={portfolioVersion}
          remainingCapacity={Math.max(0, 100 - working.length)}
          onReviewItem={onReviewItem}
          onAdd={(added) => setPortfolioScenarios((old) => [...old, ...added])}
        />
      )}
      <PricingSection
        title="Preview a bulk price change"
        description="Review the working selection from the portfolio or Item review. Edit each unit price or request a target price, then freeze this exact selection for approval."
      >
        <PricingField label="Price list name">
          <input
            className={pricingControl}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setPreview(null);
            }}
          />
        </PricingField>
        <ul className="mt-3 space-y-2 text-sm">
          {working.map((scenario, index) => (
            <li
              key={workingKey(scenario, index)}
              className="rounded border border-slate-200 p-3"
            >
              <label className="mb-3 flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={!excluded[workingKey(scenario, index)]}
                  disabled={makePreview.isPending || recommending}
                  onChange={(event) =>
                    setExcluded((old) => ({
                      ...old,
                      [workingKey(scenario, index)]: !event.target.checked,
                    }))
                  }
                />
                Include scenario {index + 1} in frozen preview
              </label>
              {scenario.lines
                .map((l) => `${l.description} × ${l.quantity}`)
                .join(", ")}{" "}
              ·{" "}
              {scenario.revenue.mode === "insurance"
                ? "Insurance review"
                : "Self-pay scenario"}
              <p className="mt-1 text-xs text-slate-500">
                Valid through {new Date(scenario.validUntil).toLocaleString()} ·{" "}
                {scenario.delivery?.service || "Delivery service not recorded"}.
                Quantities, supplier and collection assumptions stay fixed.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {scenario.lines.map((line) => (
                  <PricingField
                    key={line.id}
                    label={`Scenario ${index + 1} ${line.sku} new unit amount ($)`}
                  >
                    <input
                      className={pricingControl}
                      inputMode="decimal"
                      disabled={
                        makePreview.isPending ||
                        recommending ||
                        !!excluded[workingKey(scenario, index)]
                      }
                      value={
                        amounts[`${workingKey(scenario, index)}:${line.id}`] ??
                        pricingMoneyInput(line.unitAmountCents)
                      }
                      onChange={(event) =>
                        setAmounts((old) => ({
                          ...old,
                          [`${workingKey(scenario, index)}:${line.id}`]:
                            event.target.value,
                        }))
                      }
                    />
                  </PricingField>
                ))}
              </div>
              {scenario.revenue.mode === "self_pay" && (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {scenario.lines.length > 1 && (
                    <PricingField
                      label={`Scenario ${index + 1} item to recommend`}
                    >
                      <select
                        className={pricingControl}
                        value={
                          recommendedLines[workingKey(scenario, index)] ?? ""
                        }
                        onChange={(event) =>
                          setRecommendedLines((old) => ({
                            ...old,
                            [workingKey(scenario, index)]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Choose an item</option>
                        {scenario.lines.map((line) => (
                          <option key={line.id} value={line.id}>
                            {line.description}
                          </option>
                        ))}
                      </select>
                    </PricingField>
                  )}
                  <Button
                    intent="secondary"
                    size="sm"
                    disabled={
                      makePreview.isPending ||
                      recommending ||
                      !!excluded[workingKey(scenario, index)] ||
                      (scenario.lines.length > 1 &&
                        !recommendedLines[workingKey(scenario, index)])
                    }
                    onClick={() => {
                      try {
                        recommendation.mutate({
                          scenario: editedScenario(scenario, index),
                          key: workingKey(scenario, index),
                          lineId:
                            scenario.lines.length === 1
                              ? scenario.lines[0].id
                              : recommendedLines[workingKey(scenario, index)],
                        });
                      } catch (cause) {
                        setWorkingError(
                          cause instanceof Error
                            ? cause.message
                            : "Check the selected amounts.",
                        );
                      }
                    }}
                  >
                    Recommend target price for scenario {index + 1}
                  </Button>
                </div>
              )}
              {scenario.revenue.mode === "insurance" && (
                <p className="mt-2 text-xs text-slate-600">
                  Changing billed prices does not increase the verified expected
                  collections.
                </p>
              )}
            </li>
          ))}
        </ul>
        {working.length === 0 && (
          <p className="mt-3 text-sm text-slate-500">
            No working scenarios selected. Choose published scenarios above or
            evaluate an item and choose “Add to bulk preview”.
          </p>
        )}
        <div className="mt-3 flex gap-3">
          <Button
            disabled={
              !includedCount ||
              includedCount > 100 ||
              !name.trim() ||
              recommending
            }
            isLoading={makePreview.isPending}
            onClick={() => {
              try {
                setWorkingError("");
                makePreview.mutate({
                  name: name.trim(),
                  scenarios: working.flatMap((scenario, index) =>
                    excluded[workingKey(scenario, index)]
                      ? []
                      : [editedScenario(scenario, index)],
                  ),
                });
              } catch (cause) {
                setWorkingError(
                  cause instanceof Error
                    ? cause.message
                    : "Check the selected amounts.",
                );
              }
            }}
          >
            Create frozen preview
          </Button>
          <Button
            intent="ghost"
            disabled={!working.length || makePreview.isPending || recommending}
            onClick={() => {
              onClear();
              setPortfolioScenarios([]);
              setAmounts({});
              setExcluded({});
              setPortfolioVersion((old) => old + 1);
              setPreview(null);
            }}
          >
            Clear selection
          </Button>
        </div>
        <Button
          className="mt-3"
          intent="secondary"
          isLoading={bulkRecommendation.isPending}
          disabled={
            makePreview.isPending ||
            recommending ||
            !working.some(
              (scenario, index) =>
                !excluded[workingKey(scenario, index)] &&
                scenario.revenue.mode === "self_pay",
            )
          }
          onClick={() => {
            try {
              const entries = working.flatMap((scenario, index) => {
                if (
                  excluded[workingKey(scenario, index)] ||
                  scenario.revenue.mode !== "self_pay"
                )
                  return [];
                const lineId =
                  scenario.lines.length === 1
                    ? scenario.lines[0].id
                    : recommendedLines[workingKey(scenario, index)];
                if (!lineId)
                  throw new Error(
                    `Choose the item to recommend for scenario ${index + 1}. Other bundle prices stay fixed.`,
                  );
                return [
                  {
                    scenario: editedScenario(scenario, index),
                    key: workingKey(scenario, index),
                    lineId,
                  },
                ];
              });
              setWorkingError("");
              bulkRecommendation.mutate(entries);
            } catch (cause) {
              setWorkingError(
                cause instanceof Error
                  ? cause.message
                  : "Check the selected assumptions.",
              );
            }
          }}
        >
          Recommend target prices for selected self-pay scenarios
        </Button>
        {bulkRecommendation.error && (
          <ErrorPanel
            error={bulkRecommendation.error}
            onRetry={() => bulkRecommendation.reset()}
          />
        )}
        <p className="mt-3 text-xs text-slate-600">
          {includedCount} of {working.length} working scenarios will be frozen.
          Excluded scenarios remain visible and are not included in the new
          preview.
        </p>
        {includedCount > 100 && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            A price preview supports up to 100 scenarios. Clear this working
            selection and select a smaller group.
          </p>
        )}
        {workingError && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {workingError}
          </p>
        )}
        {recommendation.error && (
          <ErrorPanel
            error={recommendation.error}
            onRetry={() => recommendation.reset()}
          />
        )}
        {makePreview.error && (
          <PricingBatchError
            error={makePreview.error}
            onRetry={() => makePreview.reset()}
          />
        )}
      </PricingSection>
      {preview && (
        <PricingSection
          title={`Frozen preview: ${preview.name}`}
          description={`${preview.selectedEntryCount ?? preview.entries.length} selected updates and ${preview.retainedEntryCount ?? 0} retained published contexts; ${preview.entries.length} scenarios in the complete price list. Changing your working selection does not change this saved snapshot.`}
        >
          {preview.entries.some(
            (entry) =>
              entry.comparison &&
              entry.comparison.previousPriceListId !== state.activePriceListId,
          ) && (
            <p
              role="status"
              className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
            >
              The active price list has changed since this comparison was
              frozen. Create a fresh preview to compare against today's prices.
              Activating this snapshot explicitly restores its saved amounts.
            </p>
          )}
          <div className="space-y-4">
            {preview.entries.map((entry, index) => (
              <div
                className="rounded-lg border border-slate-200 p-4"
                key={index}
              >
                {entry.changeKind === "retained" ? (
                  <p className="mb-3 rounded bg-slate-100 p-2 text-xs font-semibold text-slate-700">
                    Retained published context · original amounts preserved and
                    current costs checked
                  </p>
                ) : (
                  <label className="mb-3 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedEntries.includes(index)}
                      disabled={entry.evaluation.state !== "meets_target"}
                      onChange={(event) =>
                        setSelectedEntries((old) =>
                          event.target.checked
                            ? [...old, index]
                            : old.filter((i) => i !== index),
                        )
                      }
                    />
                    Include this eligible change in a new subset preview
                  </label>
                )}
                <p className="mb-3 font-medium">
                  {entry.scenario.lines.map((l) => l.description).join(", ")}
                </p>
                <div className="mb-3 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th className="p-2">Item</th>
                        <th className="p-2">Previous amount at preview</th>
                        <th className="p-2">New unit amount</th>
                        <th className="p-2">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.scenario.lines.map((line) => {
                        const previous =
                          entry.comparison?.previousUnitAmounts.find(
                            (l) =>
                              l.sku === line.sku &&
                              l.quantity === line.quantity,
                          );
                        return (
                          <tr
                            key={line.id}
                            className="border-t border-slate-100"
                          >
                            <td className="p-2">{line.description}</td>
                            <td className="p-2">
                              {formatPricingMoney(previous?.unitAmountCents)}
                            </td>
                            <td className="p-2">
                              {formatPricingMoney(line.unitAmountCents)}
                            </td>
                            <td className="p-2">
                              {previous && previous.unitAmountCents > 0
                                ? `${(((line.unitAmountCents - previous.unitAmountCents) / previous.unitAmountCents) * 100).toFixed(2)}%`
                                : "New / unavailable"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-sm font-semibold">
                    Comparable price projections
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    Previous and new prices use the same current quantities,
                    supplier costs, delivery and collection assumptions. These
                    are projected economics, not historical realized margins.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <PricingMetric
                      label="Previous-price projected margin"
                      value={
                        entry.comparison?.status === "comparable" &&
                        entry.comparison.previousEvaluation
                          ?.selectedBasisMarginBps != null
                          ? `${(entry.comparison.previousEvaluation.selectedBasisMarginBps / 100).toFixed(2)}%`
                          : "Not available"
                      }
                      detail={
                        entry.comparison?.status === "comparable"
                          ? `Contribution ${formatPricingMoney(entry.comparison.previousEvaluation?.contributionCents)}`
                          : undefined
                      }
                    />
                    <PricingMetric
                      label="New-price projected margin"
                      value={
                        entry.evaluation.selectedBasisMarginBps == null
                          ? "Not available"
                          : `${(entry.evaluation.selectedBasisMarginBps / 100).toFixed(2)}%`
                      }
                      detail={`Contribution ${formatPricingMoney(entry.evaluation.contributionCents)}`}
                    />
                  </div>
                  {entry.comparison?.status !== "comparable" && (
                    <p className="mt-2 text-xs text-amber-800">
                      {entry.comparison?.reason ||
                        (entry.comparison?.status ===
                        "ambiguous_published_price"
                          ? "Several published price contexts match. A reliable previous-price comparison is unavailable."
                          : "No comparable published-price calculation was recorded for this snapshot.")}
                    </p>
                  )}
                  {entry.comparison && (
                    <p className="mt-2 text-xs text-slate-500">
                      Comparison frozen{" "}
                      {new Date(entry.comparison.evaluatedAt).toLocaleString()}
                      {entry.comparison.previousPriceListId
                        ? ` · prior price list ${entry.comparison.previousPriceListId} · scenario(s) ${entry.comparison.previousEntryIndexes.map((index) => index + 1).join(", ")}`
                        : ""}
                    </p>
                  )}
                </div>
                <PricingStatus state={entry.evaluation.state} />
                <div className="mt-3">
                  <PricingEvaluationResult result={entry} />
                </div>
              </div>
            ))}
          </div>
          <PricingVolumeScenarios key={preview.id} entries={preview.entries} />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              intent="secondary"
              disabled={selectedEntries.length === 0}
              isLoading={subset.isPending}
              onClick={() => subset.mutate()}
            >
              Preview selected eligible changes ({selectedEntries.length} of{" "}
              {preview.selectedEntryCount ??
                preview.entries.filter(
                  (entry) => entry.changeKind !== "retained",
                ).length}
              )
            </Button>
            <p className="text-xs text-slate-600">
              The new preview keeps other active published contexts at their
              original amounts. It does not remove prices outside the selected
              changes.
            </p>
          </div>
          {subset.error && (
            <PricingBatchError
              error={subset.error}
              onRetry={() => subset.reset()}
            />
          )}
          {canPublish && (
            <Button
              className="mt-4"
              disabled={preview.entries.some(
                (e) => e.evaluation.state !== "meets_target",
              )}
              isLoading={activate.isPending}
              onClick={() => void publish(preview)}
            >
              Activate reviewed price list
            </Button>
          )}
          {canPublish && (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <PricingField label="Activate later (your local time)">
                <input
                  className={pricingControl}
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </PricingField>
              <Button
                intent="secondary"
                disabled={
                  !scheduledAt ||
                  !Number.isFinite(Date.parse(scheduledAt)) ||
                  Date.parse(scheduledAt) <= Date.now() ||
                  preview.entries.some(
                    (e) => e.evaluation.state !== "meets_target",
                  )
                }
                isLoading={schedule.isPending}
                onClick={() => schedule.mutate({ id: preview.id })}
              >
                Schedule activation
              </Button>
            </div>
          )}
          {schedule.error && (
            <PricingBatchError
              error={schedule.error}
              onRetry={() =>
                void qc.invalidateQueries({ queryKey: pricingKey })
              }
            />
          )}
        </PricingSection>
      )}
      <PricingSection
        title="Internal price list history"
        description="Reactivating a previous snapshot is an explicit rollback for future quotes. Stale offers cannot be reactivated."
      >
        {batches.isPending ? (
          <p role="status">Loading price lists…</p>
        ) : batches.error ? (
          <ErrorPanel
            error={batches.error}
            onRetry={() => void batches.refetch()}
          />
        ) : (
          <div className="space-y-3">
            {batches.data?.batches.length === 0 && (
              <p className="text-sm text-slate-500">
                No price list previews saved yet.
              </p>
            )}
            {batches.data?.batches.map((batch) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 p-4"
                key={batch.id}
              >
                <div>
                  <p className="font-medium">{batch.name}</p>
                  <p className="text-xs text-slate-500">
                    {batch.entries.length} scenarios ·{" "}
                    {new Date(batch.createdAt).toLocaleString()}{" "}
                    {state.activePriceListId === batch.id ? "· Active" : ""}
                  </p>
                  {batch.scheduledAt && (
                    <p className="mt-1 text-xs text-slate-600">
                      Activation {new Date(batch.scheduledAt).toLocaleString()}{" "}
                      · {batch.scheduleStatus}
                      {batch.scheduleError
                        ? ` · ${describePricingBatchConflict(batch.scheduleError) ?? batch.scheduleError.replaceAll("_", " ")}`
                        : ""}
                    </p>
                  )}
                </div>
                <Button
                  intent="secondary"
                  onClick={() => {
                    setPreview(batch);
                    setSelectedEntries([]);
                  }}
                >
                  Review snapshot
                </Button>
                {canPublish && batch.scheduleStatus === "pending" && (
                  <Button
                    intent="ghost"
                    disabled={schedule.isPending}
                    onClick={() =>
                      schedule.mutate({ id: batch.id, cancel: true })
                    }
                  >
                    Cancel scheduled activation
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {activate.error && (
          <PricingBatchError
            error={activate.error}
            onRetry={() => void qc.invalidateQueries({ queryKey: pricingKey })}
          />
        )}
      </PricingSection>
    </div>
  );
}

function describePricingBatchConflict(code: string): string | null {
  const explanations: Record<string, string> = {
    retained_context_requires_review:
      "Existing published scenarios need updated evidence before this change can preserve the complete price list. Review the listed scenarios and include the required updates in a new preview.",
    price_list_contexts_changed:
      "Published item groups or retained prices changed after this snapshot was prepared. Create a fresh preview so the current prices outside your selected changes are preserved before activation.",
    price_list_context_limit:
      "The selected updates and retained published scenarios exceed the 100-scenario price-list limit. Review the complete portfolio before creating this price list.",
    duplicate_price_context:
      "The same item and quantity context was selected more than once. Keep one explicit price for each context, then create a new preview.",
  };
  return explanations[code] ?? null;
}

function PricingBatchError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const data =
    error instanceof ApiError
      ? (error.data as {
          error?: string;
          issues?: Array<{ path?: string; message?: string }>;
        } | null)
      : null;
  const explanation = data?.error && describePricingBatchConflict(data.error);
  if (!explanation) return <ErrorPanel error={error} onRetry={onRetry} />;
  return (
    <div
      role="alert"
      className="mt-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      <p className="font-semibold">The price list needs another review</p>
      <p className="mt-1">{explanation}</p>
      {Array.isArray(data?.issues) && (
        <ul className="mt-3 list-disc space-y-1 pl-5">
          {data.issues.map((issue, index) => (
            <li key={index}>
              <span className="font-semibold">
                {typeof issue.path === "string"
                  ? issue.path
                      .replace(/^self_pay:/, "Self-pay · ")
                      .replace(/^insurance:/, "Insurance · ")
                      .replaceAll("|", ", ")
                  : "Published scenario"}
              </span>{" "}
              —{" "}
              {typeof issue.message === "string"
                ? issue.message.replaceAll("_", " ")
                : "Evidence needs review"}
            </li>
          ))}
        </ul>
      )}
      <Button className="mt-3" intent="secondary" size="sm" onClick={onRetry}>
        Review again
      </Button>
    </div>
  );
}
