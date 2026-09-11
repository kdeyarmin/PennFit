import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card } from "./Card";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import { ErrorPanel } from "./ErrorPanel";
import { humanizeStatus } from "./Badge";
import { ResupplyOutreachActions } from "./ResupplyOutreachActions";
import { getSupplyOverview } from "@/lib/admin/resupply-calendar-api";
import { formatDate } from "@/lib/admin/format";

export function PatientSupplyOverview({
  patientId,
  patientName = "This patient",
}: {
  patientId: string;
  patientName?: string;
}) {
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["admin", "supply-overview", patientId, offset],
    queryFn: () => getSupplyOverview(patientId, offset),
    placeholderData: keepPreviousData,
  });
  if (query.isPending)
    return <Spinner label="Loading orders and supply dates…" />;
  if (query.isError)
    return (
      <div className="space-y-3">
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
        {offset > 0 && (
          <Button
            intent="secondary"
            size="sm"
            disabled={query.isFetching}
            onClick={() => setOffset((previous) => Math.max(0, previous - 25))}
          >
            Newer
          </Button>
        )}
      </div>
    );
  const { supplies, orders, totalOrders, linkedOrders = [] } = query.data;
  const due = supplies
    .filter(
      (s) =>
        s.episodeId &&
        s.scheduledDueAt &&
        Date.parse(s.scheduledDueAt) <= Date.now(),
    )
    .sort((a, b) => a.scheduledDueAt!.localeCompare(b.scheduledDueAt!))[0];
  return (
    <div className="space-y-5">
      <Card
        title="Supplies & next eligibility"
        subtitle="Replacement rules are checked against recorded orders. Insurance coverage and prescription validity still need verification before fulfillment."
      >
        <div className="flex flex-wrap justify-between gap-3 mb-4">
          <ResupplyOutreachActions
            recipients={due ? [{ id: due.episodeId!, patientName }] : []}
          />
          <Link href="/admin/resupply-calendar" className="text-sm underline">
            Open resupply calendar
          </Link>
        </div>
        {!supplies.length ? (
          <p>
            No active prescriptions. Add or renew a prescription to schedule
            resupply.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b">
                  <th className="p-2">Supply</th>
                  <th className="p-2">Last ordered</th>
                  <th className="p-2">Next eligibility</th>
                  <th className="p-2">Scheduled resupply</th>
                </tr>
              </thead>
              <tbody>
                {supplies.map((s) => (
                  <tr key={s.prescriptionId} className="border-b align-top">
                    <td className="p-2">
                      <strong>{s.itemName}</strong>
                      <div className="text-xs text-muted-foreground">
                        {s.itemSku} · {s.hcpcsCode ?? "No HCPCS mapping"}
                      </div>
                      <div className="text-xs">
                        Every {s.cadenceDays} days · Rx expires{" "}
                        {formatDate(s.validUntil)}
                      </div>
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {formatDate(s.lastOrderedAt)}
                    </td>
                    <td className="p-2">
                      {!s.eligibility ? (
                        <span>Needs eligibility review</span>
                      ) : (
                        <>
                          <strong>
                            {s.eligibility.eligible
                              ? "Eligible by replacement rule"
                              : s.eligibility.status === "quantity_exceeded"
                                ? "Quantity limit reached"
                                : `Interval opens ${formatDate(s.eligibility.intervalEligibleOn)}`}
                          </strong>
                          <p className="text-xs max-w-sm">
                            {s.eligibility.reason}
                          </p>
                          <p className="text-xs">
                            {s.eligibility.maxQuantityNow} unit(s) available in
                            the current quantity window.
                          </p>
                          {s.eligibility.quantityEligibleOn && (
                            <p className="text-xs">
                              Next quantity review:{" "}
                              {formatDate(s.eligibility.quantityEligibleOn)}
                            </p>
                          )}
                        </>
                      )}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {s.scheduledDueAt
                        ? formatDate(s.scheduledDueAt)
                        : "Not scheduled"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {linkedOrders.length > 0 && (
        <Card
          title="CSR orders & signatures"
          subtitle="Orders linked to this patient's most recent 50 resupply drafts. Signed orders may also appear in the fulfillment history below."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  {[
                    "Created",
                    "Order",
                    "Items ordered",
                    "Signature status",
                  ].map((h) => (
                    <th key={h} className="p-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {linkedOrders.map((o) => (
                  <tr key={o.id} className="border-b align-top">
                    <td className="p-2">{formatDate(o.createdAt)}</td>
                    <td className="p-2">{o.orderReference}</td>
                    <td className="p-2">
                      {o.items.map((item, i) => (
                        <div key={i}>
                          {item.quantity} × {item.description}
                        </div>
                      ))}
                    </td>
                    <td className="p-2">
                      {humanizeStatus(o.status)}
                      {o.signedAt && (
                        <div className="text-xs">{formatDate(o.signedAt)}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card
        title="Order history"
        subtitle={`${totalOrders} recorded supply order lines · newest first`}
      >
        {!orders.length ? (
          <p>
            {totalOrders > 0
              ? "No order lines on this page. Return to newer history."
              : "No supply orders recorded for this patient."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b">
                  {[
                    "Ordered",
                    "Item",
                    "Qty",
                    "Status / reference",
                    "Shipped",
                    "Delivered",
                  ].map((h) => (
                    <th key={h} className="p-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b">
                    <td className="p-2 whitespace-nowrap">
                      {formatDate(o.orderedAt)}
                    </td>
                    <td className="p-2">
                      <strong>{o.itemName}</strong>
                      <div className="text-xs text-muted-foreground">
                        {o.itemSku}
                      </div>
                    </td>
                    <td className="p-2">{o.quantity}</td>
                    <td className="p-2">
                      {humanizeStatus(o.status)}
                      <div className="text-xs">
                        {o.orderReference ?? "No external reference"}
                      </div>
                    </td>
                    <td className="p-2">{formatDate(o.shippedAt)}</td>
                    <td className="p-2">{formatDate(o.deliveredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(totalOrders > 25 || offset > 0) && (
          <div className="mt-3 flex items-center gap-3">
            <Button
              intent="secondary"
              size="sm"
              disabled={offset === 0 || query.isFetching}
              onClick={() => setOffset(offset - 25)}
            >
              Newer
            </Button>
            <span>
              {query.isFetching
                ? "Loading order history…"
                : orders.length
                  ? `${offset + 1}–${Math.min(offset + orders.length, totalOrders)} of ${totalOrders}`
                  : `0 shown of ${totalOrders}`}
            </span>
            <Button
              intent="secondary"
              size="sm"
              disabled={offset + 25 >= totalOrders || query.isFetching}
              onClick={() => setOffset(offset + 25)}
            >
              Older
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
