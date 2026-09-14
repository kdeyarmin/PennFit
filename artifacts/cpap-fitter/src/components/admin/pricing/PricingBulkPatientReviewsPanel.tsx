import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import type { PricingDraftReviewResponse } from "@workspace/api-client-react/admin";
import { Link } from "wouter";
import { adminJsonFetch } from "@/lib/admin-json-fetch";
import { listResupplyDrafts } from "@/lib/admin/therapy-resupply-api";
import { formatPricingMoney } from "@/lib/admin/pricing-input";
import { pricingKey } from "@/lib/admin/pricing-api";
import { Button } from "../Button";
import { PricingSection } from "./PricingPrimitives";

export function PricingBulkPatientReviewsPanel() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<PricingDraftReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const drafts = useQuery({
    queryKey: [...pricingKey, "resupply-drafts"],
    queryFn: () => listResupplyDrafts("proposed", 200),
  });
  const review = useMutation({
    mutationFn: (draftIds: string[]) =>
      adminJsonFetch<PricingDraftReviewResponse>(
        "/admin/pricing/resupply-review",
        { method: "POST", body: JSON.stringify({ draftIds }) },
      ),
  });
  async function run() {
    const current = captureSessionCacheGuard(qc);
    setResult(null);
    setError(null);
    try {
      const response = await review.mutateAsync([...selected]);
      if (current()) setResult(response);
    } catch {
      if (current())
        setError(
          "The selected reviews could not be checked. Your drafts are unchanged; retry when pricing is available.",
        );
    }
  }
  const rows = drafts.data?.drafts ?? [];
  const names = new Map(
    rows.map((d) => [d.id, d.patientName ?? "Patient record"]),
  );
  return (
    <PricingSection
      title="Review resupplies by patient"
      description="Check existing approved pricing for up to 50 selected drafts. Each patient's items, quantities, insurance estimate and delivery assumptions are checked separately. This review does not send messages or create orders."
    >
      <div className="space-y-4">
        {drafts.isPending && <p role="status">Loading open resupply drafts…</p>}
        {drafts.isError && (
          <div role="alert">
            Drafts could not be loaded.{" "}
            <Button intent="secondary" onClick={() => void drafts.refetch()}>
              Retry drafts
            </Button>
          </div>
        )}
        {!drafts.isPending && !drafts.isError && rows.length === 0 && (
          <p className="text-sm text-slate-600">
            No open resupply drafts. Stage due supplies from the resupply
            calendar first.
          </p>
        )}
        {rows.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                intent="secondary"
                disabled={review.isPending}
                onClick={() => {
                  setSelected(rows.slice(0, 50).map((d) => d.id));
                  setResult(null);
                }}
              >
                Select first {Math.min(50, rows.length)}
              </Button>
              <Button
                intent="secondary"
                disabled={review.isPending || selected.length === 0}
                onClick={() => {
                  setSelected([]);
                  setResult(null);
                }}
              >
                Clear selection
              </Button>
              <span className="text-sm">{selected.length} selected</span>
              <Button
                disabled={review.isPending || selected.length === 0}
                onClick={() => void run()}
              >
                {review.isPending
                  ? "Checking each patient…"
                  : "Evaluate selected drafts"}
              </Button>
            </div>
            {rows.length === 200 && (
              <p className="text-xs text-slate-600">
                Showing the first 200 open drafts. Use the resupply queue to
                work through the remaining drafts.
              </p>
            )}
            <div className="max-h-72 overflow-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-100">
                  <tr>
                    <th className="p-3">Select</th>
                    <th>Patient</th>
                    <th>Item</th>
                    <th>Quantity</th>
                    <th>Due</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id} className="border-t">
                      <td className="p-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${names.get(d.id)} ${d.suggestedProductId ?? d.category}`}
                          checked={selected.includes(d.id)}
                          disabled={
                            review.isPending ||
                            (!selected.includes(d.id) && selected.length >= 50)
                          }
                          onChange={(e) => {
                            setSelected((ids) =>
                              e.target.checked
                                ? [...ids, d.id]
                                : ids.filter((id) => id !== d.id),
                            );
                            setResult(null);
                          }}
                        />
                      </td>
                      <td>{names.get(d.id)}</td>
                      <td>
                        {d.suggestedProductId ?? `${d.category} — item needed`}
                      </td>
                      <td>{d.suggestedQuantity}</td>
                      <td>{d.nextEligibleDate ?? "Review eligibility"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {result && (
          <div className="space-y-3" aria-live="polite">
            <p className="font-medium">
              {result.reviews.filter((r) => r.state === "ready").length} ready ·{" "}
              {result.reviews.filter((r) => r.state !== "ready").length} need
              attention
            </p>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={exceptionsOnly}
                onChange={(e) => setExceptionsOnly(e.target.checked)}
              />
              Show only patients needing attention
            </label>
            {result.reviews
              .filter((r) => !exceptionsOnly || r.state !== "ready")
              .map((r) => (
                <article
                  key={r.draftId}
                  className="rounded-lg border p-3 text-sm"
                >
                  <p className="font-semibold">
                    {names.get(r.draftId) ?? "Unavailable draft"} ·{" "}
                    {r.sku ?? "Item selection needed"}
                  </p>
                  <p
                    className={
                      r.state === "ready" ? "text-green-800" : "text-amber-900"
                    }
                  >
                    {r.message}
                  </p>
                  {r.state === "ready" && (
                    <p>
                      Contribution{" "}
                      {formatPricingMoney(r.contributionCents ?? null)} · Margin{" "}
                      {r.marginBps == null
                        ? "Unknown"
                        : `${(r.marginBps / 100).toFixed(2)}%`}
                    </p>
                  )}
                  <Link
                    href="/admin/therapy-resupply"
                    className="mt-2 inline-block underline"
                  >
                    Open resupply order review
                  </Link>
                </article>
              ))}
            <p className="text-xs text-slate-500">
              Checked {new Date(result.evaluatedAt).toLocaleString()}. Pricing
              is checked again when an order is created. A financial review does
              not establish clinical eligibility.
            </p>
          </div>
        )}
      </div>
    </PricingSection>
  );
}
