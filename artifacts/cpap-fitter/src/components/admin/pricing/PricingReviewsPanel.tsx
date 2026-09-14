import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  activatePricingBatch,
  cancelPricingBatchSchedule,
  schedulePricingBatch,
  approvePricingQuote,
  closePricingActuals,
  getActivePricingPrices,
  getPricingActuals,
  getPricingBatches,
  getPricingQuotes,
  getPricingSummary,
  previewPricingBatch,
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
} from "@/lib/admin/pricing-input";
import { PricingEvaluationResult } from "./PricingItemReview";
import { PricingVolumeScenarios } from "./PricingVolumeScenarios";
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
  const actuals = useQuery({
    queryKey: [...pricingKey, "actuals", quoteId],
    queryFn: () => getPricingActuals(quoteId),
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
  const [costsComplete, setCostsComplete] = useState(false),
    [revenueComplete, setRevenueComplete] = useState(false),
    [closeReason, setCloseReason] = useState("");
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
    mutationFn: () =>
      closePricingActuals(quoteId, {
        expectedRevision: actuals.data!.revision,
        costsComplete,
        revenueComplete,
        reason: closeReason.trim(),
      }),
    onSuccess: () =>
      void qc.invalidateQueries({
        queryKey: [...pricingKey, "actuals", quoteId],
      }),
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
        <ErrorPanel
          error={actuals.error}
          onRetry={() => void actuals.refetch()}
        />
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
                      onChange={(e) => setCostsComplete(e.target.checked)}
                    />
                    All supplier and fulfillment costs are recorded
                  </label>
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={revenueComplete}
                      onChange={(e) => setRevenueComplete(e.target.checked)}
                    />
                    All collections, refunds and credits are recorded
                  </label>
                  <PricingField label="Completeness evidence / reason">
                    <textarea
                      className={pricingControl}
                      value={closeReason}
                      onChange={(e) => setCloseReason(e.target.value)}
                      rows={2}
                    />
                  </PricingField>
                  <Button
                    intent="secondary"
                    isLoading={close.isPending}
                    disabled={closeReason.trim().length < 10}
                    onClick={() => close.mutate()}
                  >
                    Save reconciliation status
                  </Button>
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
}: {
  scenarios: Scenario[];
  onClear: () => void;
  state: PricingState;
  canPublish: boolean;
}) {
  const qc = useQueryClient();
  const [confirm, dialog] = useConfirmDialog();
  const [name, setName] = useState(""),
    [preview, setPreview] = useState<PriceBatch | null>(null),
    [notice, setNotice] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [selectedEntries, setSelectedEntries] = useState<number[]>([]);
  const activePrices = useQuery({
    queryKey: [...pricingKey, "active-prices"],
    queryFn: getActivePricingPrices,
  });
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
    mutationFn: () => previewPricingBatch({ name: name.trim(), scenarios }),
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
      onClear();
      void qc.invalidateQueries({ queryKey: pricingKey });
    },
  });
  const publish = async (batch: PriceBatch) => {
    const current = captureSessionCacheGuard(qc);
    if (
      (await confirm({
        title: "Activate internal price list?",
        description: `Activate the saved snapshot “${batch.name}” with ${batch.entries.length} reviewed scenarios? Supplier versions and policy validity will be checked again.`,
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
      <PricingSection
        title="Preview a bulk price change"
        description="Add evaluated scenarios from Item review. The preview records your selection and rechecks its cost sources before activating all selected prices together."
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
          {scenarios.map((scenario, index) => (
            <li key={index} className="rounded border border-slate-200 p-3">
              {scenario.lines
                .map((l) => `${l.description} × ${l.quantity}`)
                .join(", ")}{" "}
              ·{" "}
              {scenario.revenue.mode === "insurance"
                ? "Insurance review"
                : "Self-pay scenario"}
            </li>
          ))}
        </ul>
        {scenarios.length === 0 && (
          <p className="mt-3 text-sm text-slate-500">
            No scenarios selected. Evaluate an item and choose “Add to bulk
            preview”.
          </p>
        )}
        <div className="mt-3 flex gap-3">
          <Button
            disabled={!scenarios.length || !name.trim()}
            isLoading={makePreview.isPending}
            onClick={() => makePreview.mutate()}
          >
            Create frozen preview
          </Button>
          <Button
            intent="ghost"
            disabled={!scenarios.length || makePreview.isPending}
            onClick={() => {
              onClear();
              setPreview(null);
            }}
          >
            Clear selection
          </Button>
        </div>
        {makePreview.error && (
          <ErrorPanel
            error={makePreview.error}
            onRetry={() => makePreview.reset()}
          />
        )}
      </PricingSection>
      {preview && (
        <PricingSection
          title={`Frozen preview: ${preview.name}`}
          description="Changing your working selection does not change this saved snapshot."
        >
          <div className="space-y-4">
            {preview.entries.map((entry, index) => (
              <div
                className="rounded-lg border border-slate-200 p-4"
                key={index}
              >
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
                  Include this eligible entry in a new subset preview
                </label>
                <p className="mb-3 font-medium">
                  {entry.scenario.lines.map((l) => l.description).join(", ")}
                </p>
                <div className="mb-3 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th className="p-2">Item</th>
                        <th className="p-2">Current unit amount</th>
                        <th className="p-2">New unit amount</th>
                        <th className="p-2">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.scenario.lines.map((line) => {
                        const previous = activePrices.data?.batch?.entries
                          .filter(
                            (e) =>
                              e.scenario.revenue.mode ===
                              entry.scenario.revenue.mode,
                          )
                          .flatMap((e) => e.scenario.lines)
                          .find(
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
              Preview selected eligible entries ({selectedEntries.length} of{" "}
              {preview.entries.length})
            </Button>
            <p className="text-xs text-slate-600">
              Unselected entries remain in this original snapshot. Only the new
              subset can be activated separately.
            </p>
          </div>
          {subset.error && (
            <ErrorPanel error={subset.error} onRetry={() => subset.reset()} />
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
            <ErrorPanel
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
                        ? ` · ${batch.scheduleError.replaceAll("_", " ")}`
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
          <ErrorPanel
            error={activate.error}
            onRetry={() => void qc.invalidateQueries({ queryKey: pricingKey })}
          />
        )}
      </PricingSection>
    </div>
  );
}
