// /admin/billing/secondary — secondary / COB claims worklist (Biller #28).
//
// Primary claims the primary payer PAID that carry a secondary coverage +
// a patient-responsibility balance, ranked by recoverable balance. One
// click generates the secondary claim (copies the line items, snapshots
// the primary's adjudication for the 837 COB loop) in 'draft' for the
// biller to review + submit through the normal batch path.
//
// reports.read to view; "Generate secondary" needs admin.tools.manage
// (enforced server-side).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Layers } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  getSecondaryEligible,
  generateSecondaryClaim,
  type SecondaryEligibleItem,
} from "@/lib/admin/secondary-claims-api";

const QUERY_KEY = ["admin", "secondary-eligible"] as const;

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function AdminSecondaryClaimsPage() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getSecondaryEligible,
    staleTime: 30_000,
  });

  const totalRecoverable = (query.data?.eligible ?? []).reduce(
    (sum, e) => sum + e.patientResponsibilityCents,
    0,
  );

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-secondary-claims-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Layers className="h-6 w-6" />
          Secondary claims (COB)
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Paid primaries with a secondary coverage and a leftover
          patient-responsibility balance. Generate the secondary claim to roll
          that balance to the next payer — the primary&apos;s adjudication is
          carried in the COB loop.
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Loading COB worklist…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Eligible claims" value={query.data.count} />
            <KpiCard
              label="Recoverable balance"
              value={money(totalRecoverable)}
              tone="gold"
            />
          </div>

          {query.data.eligible.length === 0 ? (
            <Card>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                No primaries are waiting on a secondary claim right now.
              </p>
            </Card>
          ) : (
            <Card title={`Eligible (${query.data.eligible.length})`}>
              <div className="space-y-2">
                {query.data.eligible.map((item) => (
                  <EligibleRow key={item.claimId} item={item} />
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function EligibleRow({ item }: { item: SecondaryEligibleItem }) {
  const qc = useQueryClient();
  const generate = useMutation({
    mutationFn: () => generateSecondaryClaim(item.claimId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div
      className="rounded border p-3 flex items-center justify-between gap-3 flex-wrap"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="secondary-eligible-row"
    >
      <span className="flex flex-col gap-0.5 min-w-0">
        <span
          className="font-medium truncate"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {item.primaryPayerName}
        </span>
        <Link
          href={`/admin/patients/${encodeURIComponent(item.patientId)}`}
          className="text-xs underline decoration-dotted font-mono truncate"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {item.patientId}
        </Link>
      </span>
      <span className="flex items-center gap-4 text-sm">
        <span style={{ color: "hsl(var(--ink-3))" }}>
          billed {money(item.billedCents)}
        </span>
        <span style={{ color: "hsl(var(--ink-3))" }}>
          primary paid {money(item.primaryPaidCents)}
        </span>
        <span
          className="font-semibold tabular-nums"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          balance {money(item.patientResponsibilityCents)}
        </span>
        <Button
          size="sm"
          isLoading={generate.isPending}
          onClick={() => generate.mutate()}
        >
          Generate secondary
        </Button>
      </span>
      {generate.error instanceof Error && (
        <p className="w-full text-xs" style={{ color: "#b91c1c" }} role="alert">
          Couldn&apos;t generate the secondary claim.
        </p>
      )}
    </div>
  );
}
