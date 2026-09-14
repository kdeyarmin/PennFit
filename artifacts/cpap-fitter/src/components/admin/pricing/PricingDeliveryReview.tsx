import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  useGetAdminMe,
  type CsrOrderRequestSummary,
} from "@workspace/api-client-react/admin";
import { AdminModal } from "../AdminModal";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import {
  approveDeliveryPricing,
  previewDeliveryPricing,
  type DeliveryPricingInput,
  type DeliveryPricingPreview,
} from "@/lib/admin/pricing-api";
import {
  formatPricingMoney,
  parsePricingMoney,
  pricingExpiry,
} from "@/lib/admin/pricing-input";
import {
  PricingField,
  PricingMetric,
  PricingNotice,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";
export function PricingDeliveryReviewAction({
  onClick,
}: {
  onClick: () => void;
}) {
  const me = useGetAdminMe();
  return me.data?.permissions?.includes("pricing.approve") ? (
    <Button intent="secondary" size="sm" onClick={onClick}>
      Review delivery
    </Button>
  ) : null;
}
export function PricingDeliveryReview({
  order,
  onClose,
  onUpdated,
}: {
  order: CsrOrderRequestSummary;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [country, setCountry] = useState("US"),
    [service, setService] = useState(""),
    [freight, setFreight] = useState(""),
    [source, setSource] = useState(""),
    [expiry, setExpiry] = useState(""),
    [revenueSource, setRevenueSource] = useState(""),
    [revenueExpiry, setRevenueExpiry] = useState(""),
    [verifyCosts, setVerifyCosts] = useState(false),
    [costSource, setCostSource] = useState(""),
    [costExpiry, setCostExpiry] = useState(""),
    [reason, setReason] = useState(""),
    [exception, setException] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<DeliveryPricingPreview | null>(null);
  const version = useRef(0);
  const calculate = useMutation({
    mutationFn: ({ body }: { body: DeliveryPricingInput; version: number }) =>
      previewDeliveryPricing(order.id, body),
    onSuccess: (data, variables) => {
      if (version.current === variables.version) setPreview(data);
    },
  });
  const approve = useMutation({
    mutationFn: () =>
      approveDeliveryPricing(order.id, preview!.reviewId, {
        revision: preview!.revision,
        reason: reason.trim(),
        allowException: exception,
      }),
    onSuccess: () => onUpdated(),
  });
  const change = (update: () => void) => {
    version.current++;
    setPreview(null);
    setReason("");
    setException(false);
    calculate.reset();
    approve.reset();
    setError("");
    update();
  };
  const evaluate = () => {
    setError("");
    const amountCents = freight.trim() ? parsePricingMoney(freight) : null,
      expiresAt = expiry ? pricingExpiry(expiry) : null;
    const revenueExpires = revenueExpiry ? pricingExpiry(revenueExpiry) : null;
    const costExpires = costExpiry ? pricingExpiry(costExpiry) : null;
    if (!/^[A-Za-z]{2}$/.test(country) || !service.trim()) {
      setError("Enter a country code and the supplier delivery service.");
      return;
    }
    if (
      freight.trim() &&
      (amountCents === null ||
        !source.trim() ||
        !expiresAt ||
        Date.parse(expiresAt) <= Date.now())
    ) {
      setError(
        "A replacement freight amount needs supplier evidence and a future expiry. Enter $0 only when confirmed free.",
      );
      return;
    }
    if (
      revenueSource.trim() &&
      (!revenueExpires || Date.parse(revenueExpires) <= Date.now())
    ) {
      setError("Choose a future expiry for the renewed collection evidence.");
      return;
    }
    if (
      verifyCosts &&
      (!costSource.trim() ||
        !costExpires ||
        Date.parse(costExpires) <= Date.now())
    ) {
      setError(
        "Provide evidence and a future expiry for the unchanged fees and reserves.",
      );
      return;
    }
    calculate.mutate({
      version: version.current,
      body: {
        delivery: { country: country.toUpperCase(), service: service.trim() },
        ...(freight.trim()
          ? {
              freight: {
                amountCents: amountCents!,
                source: source.trim(),
                expiresAt: expiresAt!,
              },
            }
          : {}),
        ...(revenueSource.trim()
          ? {
              revenueVerification: {
                source: revenueSource.trim(),
                expiresAt: revenueExpires!,
              },
            }
          : {}),
        ...(verifyCosts
          ? {
              costVerification: {
                source: costSource.trim(),
                expiresAt: costExpires!,
              },
            }
          : {}),
      },
    });
  };
  return (
    <AdminModal
      title={`Review delivery · ${order.orderReference}`}
      description="Review the current delivery costs and saved patient address. The accepted item amounts and original patient signature remain unchanged."
      className="max-w-3xl"
      onClose={onClose}
    >
      <div className="space-y-4">
        <p className="text-sm font-medium">
          {order.customerName} · Accepted billed amount{" "}
          {formatPricingMoney(order.amountTotalCents)}
        </p>
        <p className="text-xs text-slate-600">
          Confirm the saved address before release.{" "}
          {order.patientId && (
            <a
              className="underline underline-offset-2"
              href={`/admin/patients/${encodeURIComponent(order.patientId)}?tab=address`}
            >
              Open patient address
            </a>
          )}{" "}
          ·{" "}
          <a className="underline underline-offset-2" href="/admin/alerts">
            Review address-change alerts
          </a>
        </p>
        <ul className="space-y-1 text-sm text-slate-600">
          {order.items.map((item, index) => (
            <li key={item.lineId ?? index}>
              {item.description} · {item.quantity} ×{" "}
              {formatPricingMoney(item.unitAmountCents)}
            </li>
          ))}
        </ul>
        {approve.data ? (
          <PricingNotice>
            {approve.data.fulfillmentIds.length
              ? "Delivery review approved and eligible fulfillment items released."
              : `Delivery review saved. ${approve.data.skipped ? "Some items still need attention: " + approve.data.skipped.replaceAll("_", " ") : "Fulfillment is already up to date."}`}
          </PricingNotice>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <PricingField label="Delivery review country">
                <input
                  className={pricingControl}
                  value={country}
                  onChange={(e) => change(() => setCountry(e.target.value))}
                />
              </PricingField>
              <PricingField label="Delivery review service">
                <input
                  className={pricingControl}
                  value={service}
                  onChange={(e) => change(() => setService(e.target.value))}
                  placeholder="Supplier service / Ground"
                />
              </PricingField>
              <PricingField
                label="Updated freight amount ($)"
                hint="Optional when current verified supplier terms already cover this address."
              >
                <input
                  className={pricingControl}
                  inputMode="decimal"
                  value={freight}
                  onChange={(e) => change(() => setFreight(e.target.value))}
                />
              </PricingField>
              <PricingField label="Freight evidence reference">
                <input
                  className={pricingControl}
                  value={source}
                  onChange={(e) => change(() => setSource(e.target.value))}
                />
              </PricingField>
              <PricingField label="Freight evidence valid through (UTC)">
                <input
                  className={pricingControl}
                  type="date"
                  value={expiry}
                  onChange={(e) => change(() => setExpiry(e.target.value))}
                />
              </PricingField>
            </div>
            <details className="rounded border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Renew collection evidence without changing the amount
              </summary>
              <p className="mt-2 text-xs text-slate-500">
                Use this only after confirming that the original expected
                collection amount remains valid.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <PricingField label="Renewed collection evidence">
                  <input
                    className={pricingControl}
                    value={revenueSource}
                    onChange={(e) =>
                      change(() => setRevenueSource(e.target.value))
                    }
                  />
                </PricingField>
                <PricingField label="Renewed collection evidence valid through (UTC)">
                  <input
                    className={pricingControl}
                    type="date"
                    value={revenueExpiry}
                    onChange={(e) =>
                      change(() => setRevenueExpiry(e.target.value))
                    }
                  />
                </PricingField>
              </div>
            </details>
            <details className="rounded border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Renew original fee and reserve evidence
              </summary>
              <p className="mt-2 text-xs text-slate-500">
                Renew only previously verified non-delivery amounts that are
                unchanged. Missing or estimated amounts cannot be confirmed
                here. Update changed supplier costs in the supplier offer.
              </p>
              <label className="mt-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={verifyCosts}
                  onChange={(event) =>
                    change(() => setVerifyCosts(event.target.checked))
                  }
                />
                I verified that the original non-delivery fees and reserves are
                unchanged
              </label>
              {verifyCosts && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <PricingField label="Unchanged fee and reserve evidence">
                    <input
                      className={pricingControl}
                      value={costSource}
                      onChange={(event) =>
                        change(() => setCostSource(event.target.value))
                      }
                    />
                  </PricingField>
                  <PricingField label="Fee and reserve evidence valid through (UTC)">
                    <input
                      className={pricingControl}
                      type="date"
                      value={costExpiry}
                      onChange={(event) =>
                        change(() => setCostExpiry(event.target.value))
                      }
                    />
                  </PricingField>
                </div>
              )}
            </details>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <Button isLoading={calculate.isPending} onClick={evaluate}>
              Preview delivery profitability
            </Button>
            {calculate.error && (
              <div className="space-y-2">
                <ErrorPanel error={calculate.error} onRetry={evaluate} />
                <p className="text-sm text-slate-600">
                  For a changed supplier freight fee or a new delivery zone,
                  update the supplier offer in Supplier costs in{" "}
                  <a
                    href="/admin/pricing"
                    className="underline underline-offset-2"
                  >
                    Pricing &amp; Profitability
                  </a>
                  , then preview this delivery again. Manual freight cannot
                  override an existing supplier fee or its delivery coverage.
                </p>
              </div>
            )}{" "}
            {preview && (
              <div className="space-y-4 rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap justify-between gap-3">
                  <h3 className="text-sm font-semibold">
                    Current delivery review
                  </h3>
                  <PricingStatus state={preview.evaluation.state} />
                </div>
                <p className="text-sm text-slate-600">
                  Saved delivery address:{" "}
                  {Object.values(preview.addressSnapshot)
                    .filter((value) => typeof value === "string" && value)
                    .join(", ")}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <PricingMetric
                    label="Original delivered cost"
                    value={formatPricingMoney(
                      preview.originalEvaluation.deliveredCostCents,
                    )}
                  />
                  <PricingMetric
                    label="Current delivered cost"
                    value={formatPricingMoney(
                      preview.evaluation.deliveredCostCents,
                    )}
                  />
                  <PricingMetric
                    label="Current contribution"
                    value={formatPricingMoney(
                      preview.evaluation.contributionCents,
                    )}
                  />
                </div>
                {preview.evaluation.issues.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-amber-800">
                    {preview.evaluation.issues.map((issue, index) => (
                      <li key={index}>{issue.message}</li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-slate-500">
                  Review expires {new Date(preview.expiresAt).toLocaleString()}.
                </p>
                <PricingField label="Delivery approval reason">
                  <textarea
                    className={pricingControl}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                  />
                </PricingField>
                {preview.approvalClass === "exception" && (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={exception}
                      onChange={(e) => setException(e.target.checked)}
                    />
                    I approve this permitted margin exception based on the
                    recorded evidence.
                  </label>
                )}
                <Button
                  disabled={
                    preview.approvalClass === "blocked" ||
                    reason.trim().length < 10 ||
                    (preview.approvalClass === "exception" && !exception) ||
                    Date.parse(preview.expiresAt) <= Date.now()
                  }
                  isLoading={approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  Approve delivery and retry fulfillment
                </Button>
                {approve.error && (
                  <ErrorPanel error={approve.error} onRetry={evaluate} />
                )}
              </div>
            )}
          </>
        )}
        <div className="flex justify-end">
          <Button intent="secondary" onClick={onClose}>
            Close delivery review
          </Button>
        </div>
      </div>
    </AdminModal>
  );
}
