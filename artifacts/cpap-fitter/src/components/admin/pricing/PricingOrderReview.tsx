import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useGetAdminMe } from "@workspace/api-client-react/admin";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import {
  getPricingQuotes,
  getPricingQuote,
  getPricingState,
  pricingKey,
  type Quote,
} from "@/lib/admin/pricing-api";
import { searchPatientsForAttach } from "@/lib/admin/manual-documents-api";
import { formatPricingMoney } from "@/lib/admin/pricing-input";
import { PricingItemReview, type InitialReviewLine } from "./PricingItemReview";
import { PricingStatus } from "./PricingPrimitives";
export function PricingOrderReview({
  patientId,
  initialLines,
  quote,
  onAttach,
  onRequirementChange,
}: {
  patientId?: string;
  initialLines: InitialReviewLine[];
  quote: Quote | null;
  onAttach: (quote: Quote | null) => void;
  onRequirementChange: (required: boolean | null) => void;
}) {
  const me = useGetAdminMe();
  const allowed = me.data?.permissions?.includes("pricing.evaluate") ?? false;
  const state = useQuery({
    queryKey: [...pricingKey, "state"],
    queryFn: getPricingState,
    enabled: allowed,
  });
  const [chosenPatient, setChosenPatient] = useState(patientId ?? ""),
    [patientSearch, setPatientSearch] = useState("");
  const effectivePatient = patientId || chosenPatient;
  const reviewKey = JSON.stringify([effectivePatient, initialLines]);
  const patients = useQuery({
    queryKey: [...pricingKey, "order-patient-search", patientSearch],
    queryFn: () => searchPatientsForAttach(patientSearch),
    enabled:
      allowed &&
      !patientId &&
      patientSearch.trim().length >= 2 &&
      !chosenPatient,
  });
  const [open, setOpen] = useState(false),
    [showSaved, setShowSaved] = useState(false),
    [offset, setOffset] = useState(0);
  const saved = useQuery({
    queryKey: [...pricingKey, "quotes", "approved", effectivePatient, offset],
    queryFn: () =>
      getPricingQuotes(offset, {
        patientId: effectivePatient,
        status: "approved",
      }),
    enabled: allowed && showSaved && !!effectivePatient,
  });
  const selection = useMutation({
    mutationFn: async (listed: Quote) => {
      const current = await getPricingQuote(listed.id);
      if (
        current.status !== "approved" ||
        current.boundOrderId ||
        current.patientId !== listed.patientId ||
        current.scenario.revenue.mode !== "insurance" ||
        current.revision !== listed.revision ||
        !(Date.parse(current.validUntil) > Date.now())
      ) {
        throw new Error(
          "This review is no longer available for a new order. Refresh the approved reviews or evaluate the items again.",
        );
      }
      return current;
    },
  });
  const resetSelection = selection.reset;
  useEffect(() => {
    resetSelection();
  }, [reviewKey, resetSelection]);
  useEffect(() => {
    if (quote && patientId && quote.patientId !== patientId) onAttach(null);
  }, [patientId, quote, onAttach]);
  useEffect(() => {
    onRequirementChange(
      me.isPending || me.error
        ? null
        : allowed
          ? state.error || state.isFetching
            ? null
            : (state.data?.enforceQuotes ?? null)
          : false,
    );
  }, [
    allowed,
    me.isPending,
    me.error,
    state.data?.enforceQuotes,
    state.error,
    state.isFetching,
    onRequirementChange,
  ]);
  if (me.isPending)
    return (
      <p role="status" className="text-sm">
        Checking pricing review access…
      </p>
    );
  if (me.error)
    return <ErrorPanel error={me.error} onRetry={() => void me.refetch()} />;
  if (!allowed)
    return (
      <p className="rounded-lg border border-slate-200 p-3 text-xs text-slate-600">
        Pricing review has not been attached. Your current role cannot evaluate
        pricing.
      </p>
    );
  return (
    <section
      aria-label="Order pricing review"
      className="space-y-3 rounded-xl border border-slate-300 bg-slate-50 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            Internal profitability review
          </h3>
          <p className="mt-1 text-xs text-slate-600">
            {state.isPending || state.isFetching
              ? "Checking pricing policy…"
              : state.error
                ? "Pricing policy could not be checked. Retry before creating an order."
                : state.data?.enforceQuotes
                  ? "An approved insurance review is required."
                  : "Review optional — this order is unreviewed until an approved review is attached."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            intent="secondary"
            size="sm"
            onClick={() => {
              setOpen((o) => !o);
              setShowSaved(false);
              selection.reset();
            }}
          >
            {open ? "Close calculator" : "Evaluate items"}
          </Button>
          <Button
            intent="secondary"
            size="sm"
            onClick={() => {
              setShowSaved((s) => !s);
              setOpen(false);
              selection.reset();
            }}
          >
            Choose approved review
          </Button>
        </div>
      </div>
      {!patientId && (
        <div className="space-y-2">
          <label className="block text-sm font-medium">
            Patient for pricing review
            <input
              className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2"
              value={patientSearch}
              onChange={(e) => {
                setPatientSearch(e.target.value);
                setChosenPatient("");
                onAttach(null);
                setOffset(0);
              }}
              placeholder="Find patient by name"
            />
          </label>
          {patients.isFetching && <p role="status">Finding patients…</p>}
          {!chosenPatient &&
            patients.data?.map((p) => (
              <button
                type="button"
                className="block w-full rounded bg-white px-3 py-2 text-left text-sm"
                key={p.id}
                onClick={() => {
                  setChosenPatient(p.id);
                  setPatientSearch(`${p.firstName} ${p.lastName}`);
                }}
              >
                {p.firstName} {p.lastName}
                {p.pacwareId ? ` · ${p.pacwareId}` : ""}
              </button>
            ))}
          {patients.error && (
            <ErrorPanel
              error={patients.error}
              onRetry={() => void patients.refetch()}
            />
          )}
        </div>
      )}
      {state.error && (
        <ErrorPanel error={state.error} onRetry={() => void state.refetch()} />
      )}
      {quote && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-emerald-200 bg-emerald-50 p-3">
          <div>
            <PricingStatus state="approved" />
            <ul className="mt-2 space-y-1 text-sm">
              {quote.lines.map((line) => (
                <li key={line.id}>
                  {line.description} · {line.sku} · {line.quantity} ×{" "}
                  {formatPricingMoney(line.unitAmountCents)} ·{" "}
                  {line.fulfillmentMethod === "dropship"
                    ? "Supplier dropship"
                    : "Warehouse stock"}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-emerald-900">
              Revision {quote.revision} attached · {quote.lines.length} item(s)
              · Expires {quote.validUntil.slice(0, 10)}
            </p>
          </div>
          <Button intent="ghost" size="sm" onClick={() => onAttach(null)}>
            Remove review
          </Button>
        </div>
      )}
      {open && (
        <PricingItemReview
          key={reviewKey}
          patientId={effectivePatient || undefined}
          initialLines={initialLines}
          canVerify={me.data?.permissions?.includes("pricing.manage")}
          insuranceOnly
          onAttach={(review) => {
            onAttach(review);
            setOpen(false);
          }}
        />
      )}
      {showSaved && (
        <div className="space-y-2">
          {!effectivePatient ? (
            <p className="text-sm text-slate-600">
              Choose a patient to find their approved reviews.
            </p>
          ) : saved.isPending ? (
            <p role="status">Loading approved reviews…</p>
          ) : saved.error ? (
            <ErrorPanel
              error={saved.error}
              onRetry={() => void saved.refetch()}
            />
          ) : (
            <>
              {selection.error && (
                <ErrorPanel
                  error={selection.error}
                  onRetry={() => {
                    selection.reset();
                    void saved.refetch();
                  }}
                />
              )}
              {saved.data?.quotes
                .filter(
                  (q) =>
                    q.status === "approved" &&
                    !q.boundOrderId &&
                    q.scenario.revenue.mode === "insurance" &&
                    q.patientId &&
                    q.patientId === effectivePatient,
                )
                .map((q) => (
                  <div
                    key={q.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 bg-white p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {q.lines.map((l) => l.description).join(", ")}
                      </p>
                      <p className="text-xs text-slate-500">
                        Billed amount{" "}
                        {formatPricingMoney(
                          q.lines.reduce(
                            (total, l) =>
                              total + l.unitAmountCents * l.quantity,
                            0,
                          ),
                        )}{" "}
                        · Expires {q.validUntil.slice(0, 10)}
                      </p>
                    </div>
                    <Button
                      intent="secondary"
                      size="sm"
                      disabled={
                        saved.isFetching ||
                        selection.isPending ||
                        !(Date.parse(q.validUntil) > Date.now())
                      }
                      isLoading={
                        selection.isPending && selection.variables?.id === q.id
                      }
                      onClick={() => {
                        selection.mutate(q, {
                          onSuccess: (current) => {
                            onAttach(current);
                            setShowSaved(false);
                          },
                        });
                      }}
                    >
                      Use this review
                    </Button>
                  </div>
                ))}
              {saved.data?.quotes.length === 0 && (
                <p className="text-sm text-slate-500">
                  No approved insurance reviews found. Save a review and ask a
                  pricing manager to approve its evidence.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  intent="ghost"
                  size="sm"
                  disabled={!offset || saved.isFetching || selection.isPending}
                  onClick={() => {
                    selection.reset();
                    setOffset((n) => n - 50);
                  }}
                >
                  Previous
                </Button>
                <Button
                  intent="ghost"
                  size="sm"
                  disabled={
                    !saved.data?.hasMore ||
                    saved.isFetching ||
                    selection.isPending
                  }
                  onClick={() => {
                    selection.reset();
                    setOffset((n) => n + 50);
                  }}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
