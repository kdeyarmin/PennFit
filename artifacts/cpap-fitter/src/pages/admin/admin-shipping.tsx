// /admin/shipping — XPS Ship shipping-label console.
//
// The DME's "print labels" worklist. For each paid, ship-method order
// that hasn't shipped yet, staff can rate-shop carriers, then create a
// label with the patient's address merged straight in — no re-keying
// into XPS Webship. On booking, tracking auto-fills on the order (which
// fires the existing patient shipping notification) and the label PDF
// opens for printing.
//
// XPS uses a stage-then-process model, so a freshly created label can be
// momentarily "staged" (awaiting XPS booking); the modal offers a Sync
// action to resolve it without leaving the page.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Truck, Printer, RefreshCw, Ban, Package } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { AdminModal } from "@/components/admin/AdminModal";
import { useDocumentTitle } from "@/hooks/admin/use-document-title";
import {
  getXpsStatus,
  getXpsQueue,
  getXpsRates,
  createXpsLabel,
  syncXpsLabel,
  voidXpsLabel,
  xpsLabelPdfUrl,
  type LabelResult,
  type XpsQueueOrder,
  type XpsRate,
} from "@/lib/admin/xps-shipping-api";

const statusKey = ["admin", "xps", "status"] as const;
const queueKey = ["admin", "xps", "queue"] as const;

function formatCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function AdminShippingPage() {
  useDocumentTitle("Admin · Shipping labels");

  const status = useQuery({ queryKey: statusKey, queryFn: getXpsStatus });
  const queue = useQuery({
    queryKey: queueKey,
    queryFn: () => getXpsQueue(50),
  });

  const [activeOrder, setActiveOrder] = useState<XpsQueueOrder | null>(null);

  const configured = status.data?.availability.status === "configured";

  return (
    <div className="admin-root">
      <div className="p-6 space-y-6 max-w-5xl">
        <header>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Truck className="h-6 w-6" /> Shipping labels
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Create XPS shipping labels with each patient's address merged in.
            Tracking auto-fills on the order and the customer is notified.
          </p>
        </header>

        {status.isPending ? (
          <Spinner label="Checking XPS connection…" />
        ) : status.isError ? (
          <ErrorPanel error={status.error} onRetry={() => status.refetch()} />
        ) : !configured ? (
          <Card>
            <div className="p-4">
              <p className="text-sm font-semibold mb-1">
                XPS Ship not configured
              </p>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                Add your XPS API key, customer id, integration id, and a
                ship-from address under{" "}
                <a
                  href="/admin/system-configuration"
                  className="underline decoration-dotted"
                >
                  System Configuration → Shipping labels (XPS Ship)
                </a>
                . Until then, orders can still be shipped by entering tracking
                manually.
              </p>
            </div>
          </Card>
        ) : null}

        {configured && (
          <Card>
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Package className="h-4 w-4" /> Awaiting shipment
                </h2>
                <Button
                  intent="ghost"
                  size="sm"
                  onClick={() => queue.refetch()}
                  isLoading={queue.isFetching}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Refresh
                </Button>
              </div>

              {queue.isPending ? (
                <Spinner label="Loading orders…" />
              ) : queue.isError ? (
                <ErrorPanel
                  error={queue.error}
                  onRetry={() => queue.refetch()}
                />
              ) : (queue.data?.orders.length ?? 0) === 0 ? (
                <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                  No paid orders are awaiting a shipping label. 🎉
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr
                      className="text-left text-xs uppercase tracking-wider"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      <th className="py-2">Order</th>
                      <th className="py-2">Ship to</th>
                      <th className="py-2">Total</th>
                      <th className="py-2">Status</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {queue.data!.orders.map((o) => (
                      <tr
                        key={o.id}
                        className="border-t"
                        style={{ borderColor: "hsl(var(--line-1))" }}
                      >
                        <td className="py-2">
                          <code className="text-xs">{o.id.slice(0, 8)}</code>
                        </td>
                        <td className="py-2">{o.shipTo ?? "—"}</td>
                        <td className="py-2">
                          {formatCents(o.amountTotalCents)}
                        </td>
                        <td className="py-2">
                          {o.labelStatus === "staged" ? (
                            <span style={{ color: "hsl(var(--ink-3))" }}>
                              staged
                            </span>
                          ) : o.labelStatus === "voided" ? (
                            <span style={{ color: "hsl(var(--ink-3))" }}>
                              voided
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <Button
                            size="sm"
                            disabled={!o.hasAddress}
                            onClick={() => setActiveOrder(o)}
                          >
                            {o.hasAddress ? "Create label" : "No address"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
        )}

        {activeOrder && (
          <CreateLabelModal
            order={activeOrder}
            onClose={() => setActiveOrder(null)}
          />
        )}
      </div>
    </div>
  );
}

function CreateLabelModal({
  order,
  onClose,
}: {
  order: XpsQueueOrder;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [weightOz, setWeightOz] = useState("16");
  const [lengthIn, setLengthIn] = useState("");
  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [rates, setRates] = useState<XpsRate[] | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [result, setResult] = useState<LabelResult | null>(null);

  function parcel() {
    return {
      weightOz: Number.parseFloat(weightOz) || 0,
      lengthIn: lengthIn ? Number.parseFloat(lengthIn) : null,
      widthIn: widthIn ? Number.parseFloat(widthIn) : null,
      heightIn: heightIn ? Number.parseFloat(heightIn) : null,
    };
  }

  const ratesMut = useMutation({
    mutationFn: () => getXpsRates(order.id, { parcel: parcel() }),
    onSuccess: (data) => {
      setRates(data.rates);
      if (data.rates.length > 0) setSelectedService(data.rates[0].serviceCode);
    },
  });

  const createMut = useMutation({
    mutationFn: () =>
      createXpsLabel(order.id, {
        parcel: parcel(),
        shippingService: selectedService!,
      }),
    onSuccess: (data) => {
      setResult(data);
      void qc.invalidateQueries({ queryKey: queueKey });
      if (data.status === "booked") {
        window.open(xpsLabelPdfUrl(order.id), "_blank", "noopener");
      }
    },
  });

  const syncMut = useMutation({
    mutationFn: () => syncXpsLabel(order.id),
    onSuccess: (data) => {
      setResult(data);
      void qc.invalidateQueries({ queryKey: queueKey });
      if (data.status === "booked") {
        window.open(xpsLabelPdfUrl(order.id), "_blank", "noopener");
      }
    },
  });

  const voidMut = useMutation({
    mutationFn: () => voidXpsLabel(order.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queueKey });
      onClose();
    },
  });

  const weightValid = (Number.parseFloat(weightOz) || 0) > 0;

  return (
    <AdminModal
      title={`Create label · ${order.id.slice(0, 8)}`}
      description={order.shipTo ?? undefined}
      onClose={onClose}
    >
      <div className="space-y-4">
        {/* Parcel */}
        <div>
          <p className="text-xs font-semibold mb-1">Parcel weight & size</p>
          <div className="grid grid-cols-4 gap-2">
            <label className="text-xs">
              Weight (oz)
              <input
                type="number"
                min="0"
                step="0.1"
                value={weightOz}
                onChange={(e) => setWeightOz(e.target.value)}
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs">
              L (in)
              <input
                type="number"
                min="0"
                value={lengthIn}
                onChange={(e) => setLengthIn(e.target.value)}
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs">
              W (in)
              <input
                type="number"
                min="0"
                value={widthIn}
                onChange={(e) => setWidthIn(e.target.value)}
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs">
              H (in)
              <input
                type="number"
                min="0"
                value={heightIn}
                onChange={(e) => setHeightIn(e.target.value)}
                className="mt-0.5 w-full rounded border px-2 py-1 text-sm"
              />
            </label>
          </div>
          <div className="mt-2">
            <Button
              intent="secondary"
              size="sm"
              disabled={!weightValid}
              isLoading={ratesMut.isPending}
              onClick={() => ratesMut.mutate()}
            >
              Get rates
            </Button>
          </div>
          {ratesMut.isError && (
            <p className="text-xs mt-1" style={{ color: "#991b1b" }}>
              Couldn't fetch rates. Check the weight and try again.
            </p>
          )}
        </div>

        {/* Rates */}
        {rates && rates.length > 0 && (
          <div>
            <p className="text-xs font-semibold mb-1">Choose a service</p>
            <div className="space-y-1 max-h-48 overflow-auto">
              {rates.map((r) => (
                <label
                  key={`${r.carrierCode}-${r.serviceCode}`}
                  className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-sm cursor-pointer"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="service"
                      checked={selectedService === r.serviceCode}
                      onChange={() => setSelectedService(r.serviceCode)}
                    />
                    {r.serviceDescription}
                  </span>
                  <span className="font-semibold">
                    {formatCents(r.totalCents)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
        {rates && rates.length === 0 && (
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            No rates returned for this parcel.
          </p>
        )}

        {/* Result */}
        {result?.status === "booked" ? (
          <div
            className="rounded border p-3 text-sm"
            style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}
          >
            <p className="font-semibold">Label booked ✓</p>
            <p className="mt-0.5">
              {result.carrier} · {result.trackingNumber}
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  window.open(xpsLabelPdfUrl(order.id), "_blank", "noopener")
                }
              >
                <Printer className="h-3.5 w-3.5" /> Print label
              </Button>
              <Button
                intent="ghost"
                size="sm"
                isLoading={voidMut.isPending}
                onClick={() => voidMut.mutate()}
              >
                <Ban className="h-3.5 w-3.5" /> Void
              </Button>
            </div>
          </div>
        ) : result?.status === "staged" ? (
          <div
            className="rounded border p-3 text-sm"
            style={{ background: "#fffbe6", borderColor: "hsl(var(--line-1))" }}
          >
            <p className="font-semibold">Staged in XPS</p>
            <p className="mt-0.5" style={{ color: "hsl(var(--ink-3))" }}>
              The order is in XPS but hasn't been booked into a shipment yet.
              Sync to pull the tracking number and label once XPS processes it.
            </p>
            <div className="mt-2">
              <Button
                size="sm"
                isLoading={syncMut.isPending}
                onClick={() => syncMut.mutate()}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Sync now
              </Button>
            </div>
          </div>
        ) : null}

        {/* Primary action */}
        {!result && (
          <div className="flex justify-end gap-2 pt-2">
            <Button intent="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!selectedService}
              isLoading={createMut.isPending}
              onClick={() => createMut.mutate()}
            >
              <Printer className="h-3.5 w-3.5" /> Create &amp; print label
            </Button>
          </div>
        )}
        {createMut.isError && (
          <p className="text-xs" style={{ color: "#991b1b" }}>
            Couldn't create the label. The order may need signed paperwork or a
            valid address.
          </p>
        )}
      </div>
    </AdminModal>
  );
}
