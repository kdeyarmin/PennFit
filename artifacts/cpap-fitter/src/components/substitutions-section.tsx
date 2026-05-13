import { useQuery } from "@tanstack/react-query";
import { Shuffle } from "lucide-react";

import { fetchSubstitutions } from "@/lib/account-api";

/**
 * "Recent substitutions" section on /account.
 *
 * When the resupply order-flow ships an alternative SKU because the
 * patient's prescribed SKU was backordered, this card surfaces the
 * swap so the patient isn't surprised by "this looks different
 * from last time." Hidden entirely when there's nothing to show
 * (the common case).
 */
export function SubstitutionsSection() {
  const { data } = useQuery({
    queryKey: ["account", "substitutions"] as const,
    queryFn: fetchSubstitutions,
  });
  if (!data || !data.patientLinked) return null;
  if (data.substitutions.length === 0) return null;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-3"
      data-testid="account-substitutions"
    >
      <div className="flex items-center gap-2">
        <Shuffle className="h-5 w-5 text-[hsl(var(--penn-gold))]" />
        <h2 className="font-semibold">Recent substitutions</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Your prescribed item was temporarily out of stock; we shipped an
        equivalent alternative. Questions? Reply in chat below.
      </p>
      <ul className="space-y-2">
        {data.substitutions.map((s) => (
          <li
            key={s.id}
            className="rounded-xl border p-3 flex items-center justify-between gap-3 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <div className="min-w-0">
              <div>
                <span className="font-mono text-xs line-through text-muted-foreground">
                  {s.requestedSku}
                </span>
                {" → "}
                <span className="font-mono text-xs font-semibold">
                  {s.shippedSku}
                </span>
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {s.deliveredAt
                  ? `Delivered ${new Date(s.deliveredAt).toLocaleDateString()}`
                  : s.shippedAt
                    ? `Shipped ${new Date(s.shippedAt).toLocaleDateString()}`
                    : `Confirmed ${new Date(s.createdAt).toLocaleDateString()}`}
              </div>
            </div>
            <span className="text-[10px] uppercase tracking-wider font-semibold rounded bg-amber-100 text-amber-900 px-1.5 py-0.5">
              substituted
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
