import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, PackageX, Truck, CheckCircle2, Clock, XCircle } from "lucide-react";

import {
  fetchMyReturns,
  type MyReturnRow,
  type ShopReturnStatus,
} from "@/lib/account-api";

/**
 * "Your returns" section on /account.
 *
 * Lists the signed-in customer's open and recently-closed return
 * requests so they can track status without navigating back to
 * /shop/orders. Initiation still happens on /shop/orders (where the
 * order context lives); this section is the read-side companion.
 *
 * Hides itself entirely when the customer has no returns on file.
 */
export function MyReturnsSection() {
  const [returns, setReturns] = useState<MyReturnRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchMyReturns();
        if (!cancelled) setReturns(r.returns);
      } catch {
        // Silent failure — additive surface.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !returns || returns.length === 0) return null;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-my-returns"
    >
      <div className="flex items-center gap-2">
        <PackageX className="h-5 w-5 text-[hsl(var(--penn-gold))]" />
        <h2 className="font-semibold">Your returns</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Status of returns and exchanges you&apos;ve started. To open a new
        return, find the order on{" "}
        <Link href="/shop/orders" className="text-primary hover:underline">
          My orders
        </Link>
        .
      </p>
      <ul className="space-y-3">
        {returns.map((r) => (
          <ReturnRow key={r.id} row={r} />
        ))}
      </ul>
    </section>
  );
}

const STATUS_LABELS: Record<ShopReturnStatus, string> = {
  requested: "Requested",
  approved: "Approved — ship it back",
  rejected: "Not approved",
  shipped_back: "On its way back",
  received: "Received at warehouse",
  refunded: "Refunded",
  replaced: "Replacement sent",
  closed: "Closed",
};

const STATUS_TONE: Record<
  ShopReturnStatus,
  "pending" | "active" | "success" | "negative" | "muted"
> = {
  requested: "pending",
  approved: "active",
  rejected: "negative",
  shipped_back: "active",
  received: "active",
  refunded: "success",
  replaced: "success",
  closed: "muted",
};

function StatusBadge({ status }: { status: ShopReturnStatus }) {
  const tone = STATUS_TONE[status];
  const colors: Record<typeof tone, string> = {
    pending: "bg-amber-50 text-amber-900 border-amber-200",
    active: "bg-blue-50 text-blue-900 border-blue-200",
    success: "bg-emerald-50 text-emerald-900 border-emerald-200",
    negative: "bg-rose-50 text-rose-900 border-rose-200",
    muted: "bg-muted text-muted-foreground border-border",
  };
  const Icon = (
    {
      pending: Clock,
      active: Truck,
      success: CheckCircle2,
      negative: XCircle,
      muted: PackageX,
    } as const
  )[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${colors[tone]}`}
    >
      <Icon className="h-3 w-3" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function ReturnRow({ row }: { row: MyReturnRow }) {
  const created = new Date(row.createdAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <li
      className="rounded-xl border border-border/60 p-3 sm:p-4"
      data-testid={`return-${row.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            Opened {created} · order {row.sessionId.slice(-12)}
          </div>
          <div className="text-sm font-medium">
            Reason: {humanizeReason(row.reason)}
          </div>
          {row.reasonNote && (
            <div className="text-xs text-muted-foreground italic">
              &quot;{row.reasonNote}&quot;
            </div>
          )}
        </div>
        <StatusBadge status={row.status} />
      </div>
      {row.returnLabelUrl && row.status === "approved" && (
        <a
          href={row.returnLabelUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-[hsl(var(--penn-navy))] hover:underline"
          data-testid={`return-${row.id}-label`}
        >
          Print return label <ArrowRight className="h-3 w-3" />
        </a>
      )}
      {row.returnCarrier && row.returnTrackingNumber && (
        <div className="mt-2 text-xs text-muted-foreground">
          Tracking: {row.returnCarrier} {row.returnTrackingNumber}
        </div>
      )}
      {row.status === "refunded" && row.refundCents != null && (
        <div className="mt-2 text-xs text-emerald-900">
          Refunded ${(row.refundCents / 100).toFixed(2)}
        </div>
      )}
    </li>
  );
}

function humanizeReason(reason: MyReturnRow["reason"]): string {
  switch (reason) {
    case "fit":
      return "Fit / comfort";
    case "defective":
      return "Defective or damaged";
    case "wrong_item":
      return "Wrong item";
    case "no_longer_needed":
      return "No longer needed";
    case "other":
      return "Other";
  }
}
