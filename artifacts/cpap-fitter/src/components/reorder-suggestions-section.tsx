import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { Clock, AlertCircle, Package, ArrowRight } from "lucide-react";
import {
  fetchReorderSuggestions,
  type ReorderSuggestion,
} from "@/lib/account-api";
import { Button } from "@/components/ui/button";

/**
 * "Time to reorder?" section on /account. Renders only when the
 * server has at least one overdue or due-soon SKU based on the
 * customer's purchase history. Each card links to the product
 * detail page so the patient can add to cart with the right
 * one-time/subscription mode for them.
 *
 * Section is hidden entirely when there's nothing actionable —
 * a "you have nothing to reorder" empty state would just be noise.
 */
export function ReorderSuggestionsSection() {
  const [items, setItems] = useState<ReorderSuggestion[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchReorderSuggestions();
        if (!cancelled) setItems(r.suggestions);
      } catch {
        // Silent failure — the section just doesn't render. Don't
        // bother the user with a "couldn't fetch reorder suggestions"
        // banner when this is purely additive surface.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !items || items.length === 0) return null;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-reorder-suggestions"
    >
      <div className="flex items-center gap-2">
        <Clock className="h-5 w-5 text-[hsl(var(--penn-gold))]" />
        <h2 className="font-semibold">Time to reorder?</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Based on your purchase history, these supplies are due (or about to be)
        for replacement.
      </p>
      <ul className="space-y-3">
        {items.map((s) => (
          <ReorderCard key={s.productId} item={s} />
        ))}
      </ul>
      <div className="text-xs text-muted-foreground">
        Want to skip the math? Subscribe & ship sends each item on its
        replacement schedule automatically.{" "}
        <Link
          href="/learn/replacement-schedule"
          className="font-medium text-[hsl(var(--penn-navy))] underline-offset-2 hover:underline"
        >
          See the full schedule
        </Link>
        .
      </div>
    </section>
  );
}

function ReorderCard({ item }: { item: ReorderSuggestion }) {
  const overdue = item.status === "overdue";
  const lastPaid = new Date(item.lastPaidAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const dueOn = new Date(item.dueOn).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return (
    <li
      className={`rounded-xl border p-4 flex flex-col sm:flex-row gap-3 ${
        overdue
          ? "border-rose-200 bg-rose-50/50"
          : "border-[hsl(var(--penn-gold)/0.4)] bg-[hsl(var(--penn-gold)/0.06)]"
      }`}
      data-testid={`reorder-card-${item.productId}`}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="h-12 w-12 rounded-lg bg-white border flex items-center justify-center shrink-0 overflow-hidden">
          {item.imageUrl ? (
            <img
              src={item.imageUrl}
              alt=""
              className="w-full h-full object-contain"
              loading="lazy"
            />
          ) : (
            <Package className="w-5 h-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-[hsl(var(--penn-navy))]">
              {item.productName}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                overdue
                  ? "border-rose-300 bg-rose-100 text-rose-800"
                  : "border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/15 text-[hsl(var(--penn-navy))]"
              }`}
            >
              {overdue ? <AlertCircle className="w-3 h-3" /> : null}
              {overdue
                ? `${item.ageDays - item.cadenceDays} day${
                    item.ageDays - item.cadenceDays === 1 ? "" : "s"
                  } overdue`
                : `Due ${dueOn}`}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Last ordered {lastPaid} · suggested cadence every {item.cadenceDays}{" "}
            days
          </div>
        </div>
      </div>
      <div className="flex gap-2 shrink-0 sm:items-center">
        <Link href={`/shop/p/${encodeURIComponent(item.productId)}`}>
          <Button size="sm" data-testid={`reorder-card-cta-${item.productId}`}>
            Reorder <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </Button>
        </Link>
      </div>
    </li>
  );
}
