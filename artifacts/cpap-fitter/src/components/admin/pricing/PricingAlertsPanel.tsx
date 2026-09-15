import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import {
  getPricingAlerts,
  pricingKey,
  reviewPricingAlert,
  type PricingAlert,
} from "@/lib/admin/pricing-api";
import { formatPricingMoney } from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingSection,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";
export function PricingAlertsPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient(),
    [selected, setSelected] = useState<PricingAlert | null>(null),
    [owner, setOwner] = useState(""),
    [reviewAt, setReviewAt] = useState(""),
    [notes, setNotes] = useState(""),
    [resolved, setResolved] = useState(false);
  const alerts = useQuery({
    queryKey: [...pricingKey, "alerts"],
    queryFn: getPricingAlerts,
  });
  const review = useMutation({
    mutationFn: () =>
      reviewPricingAlert(selected!.key, {
        expectedRevision: selected!.revision,
        owner: owner.trim(),
        reviewAt: reviewAt ? new Date(reviewAt).toISOString() : null,
        notes: notes.trim(),
        status: resolved ? "resolved" : "open",
      }),
    onSuccess: () => {
      setSelected(null);
      void qc.invalidateQueries({ queryKey: [...pricingKey, "alerts"] });
    },
  });
  return (
    <div className="space-y-5">
      <PricingSection
        title="Profitability follow-up"
        description="Assign cost, expiry and margin issues to an owner. Resolving a review records the decision; it does not silently rewrite an order."
      >
        {alerts.isPending ? (
          <p role="status">Loading pricing alerts…</p>
        ) : alerts.error ? (
          <ErrorPanel
            error={alerts.error}
            onRetry={() => void alerts.refetch()}
          />
        ) : (
          <div className="space-y-3">
            {alerts.data?.alerts.length === 0 && (
              <p className="text-sm text-slate-500">
                No pricing issues need attention.
              </p>
            )}
            {alerts.data?.alerts.map((alert) => (
              <article
                key={alert.key}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 p-4"
              >
                <div>
                  <h3 className="font-medium">
                    {alert.code.replaceAll("_", " ")}
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">
                    {alert.amountCents !== null
                      ? `${formatPricingMoney(alert.amountCents)} · `
                      : ""}
                    {alert.owner || "Unassigned"}
                    {alert.reviewAt
                      ? ` · Review ${new Date(alert.reviewAt).toLocaleString()}`
                      : ""}
                  </p>
                  {alert.notes && (
                    <p className="mt-2 text-sm text-slate-500">{alert.notes}</p>
                  )}
                </div>
                <div className="flex gap-3">
                  <PricingStatus state={alert.status} />
                  {canManage && (
                    <Button
                      intent="secondary"
                      size="sm"
                      onClick={() => {
                        setSelected(alert);
                        setOwner(alert.owner);
                        setReviewAt("");
                        setNotes(alert.notes);
                        setResolved(alert.status === "resolved");
                      }}
                    >
                      Assign / review
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </PricingSection>
      {selected && canManage && (
        <PricingSection title={`Review ${selected.code.replaceAll("_", " ")}`}>
          <div className="grid gap-4 md:grid-cols-2">
            <PricingField label="Review owner">
              <input
                className={pricingControl}
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </PricingField>
            <PricingField label="Next review (your local time)">
              <input
                className={pricingControl}
                type="datetime-local"
                value={reviewAt}
                onChange={(e) => setReviewAt(e.target.value)}
              />
            </PricingField>
            <PricingField label="Decision and evidence">
              <textarea
                className={pricingControl}
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </PricingField>
          </div>
          <label className="mt-3 flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={resolved}
              onChange={(e) => setResolved(e.target.checked)}
            />
            Mark this issue resolved
          </label>
          <div className="mt-4 flex gap-3">
            <Button
              disabled={!notes.trim()}
              isLoading={review.isPending}
              onClick={() => review.mutate()}
            >
              Save follow-up
            </Button>
            <Button intent="ghost" onClick={() => setSelected(null)}>
              Cancel
            </Button>
          </div>
          {review.error && (
            <ErrorPanel
              error={review.error}
              onRetry={() => void alerts.refetch()}
            />
          )}
        </PricingSection>
      )}
    </div>
  );
}
