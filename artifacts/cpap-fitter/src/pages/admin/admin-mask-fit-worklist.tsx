// /admin/clinical/mask-fit — RT triage of mask-fit micro-survey outcomes
// (RT #22a slice 2).
//
// Open leaking / uncomfortable reports, worst-fit first, each linking to
// the patient so an RT can follow up (→ an intervention, #21). "Reviewed"
// keeps it visible; "Actioned" clears it from the worklist.
//
// clinical.read to view; triage needs clinical.intervention.write
// (enforced server-side).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Wind } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  getMaskFitWorklist,
  triageMaskFit,
  type MaskFitWorkItem,
} from "@/lib/admin/mask-fit-worklist-api";

const QUERY_KEY = ["admin", "mask-fit-worklist"] as const;

export function AdminMaskFitWorklistPage() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getMaskFitWorklist,
    staleTime: 30_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-mask-fit-worklist-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Wind className="h-6 w-6" />
          Mask-fit feedback
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Patients who reported a leaking or uncomfortable fit on the
          post-delivery survey, worst first. Follow up — then mark actioned.
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Loading worklist…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.count === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No open mask-fit reports. 🎉
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard
              label="Uncomfortable"
              value={query.data.counts.uncomfortable}
              tone="navy"
            />
            <KpiCard label="Leaking" value={query.data.counts.leaking} />
          </div>
          <Card title={`Open (${query.data.count})`}>
            <div className="space-y-2">
              {query.data.items.map((item) => (
                <MaskFitRow key={item.id} item={item} />
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function MaskFitRow({ item }: { item: MaskFitWorkItem }) {
  const qc = useQueryClient();
  const triage = useMutation({
    mutationFn: (status: "reviewed" | "actioned") =>
      triageMaskFit(item.id, status),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div
      className="rounded border p-3 flex items-start justify-between gap-3 flex-wrap"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="mask-fit-row"
    >
      <span className="flex flex-col gap-1 min-w-0">
        <span className="flex items-center gap-2">
          <Badge
            variant={
              item.fit_outcome === "uncomfortable" ? "danger" : "warning"
            }
          >
            {item.fit_outcome}
          </Badge>
          {item.status === "reviewed" && (
            <Badge variant="muted">reviewed</Badge>
          )}
        </span>
        {item.patientId ? (
          <Link
            href={`/admin/patients/${encodeURIComponent(item.patientId)}`}
            className="text-xs underline decoration-dotted font-mono truncate"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {item.patientId}
          </Link>
        ) : (
          <span
            className="text-xs font-mono truncate"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            order {item.order_id}
          </span>
        )}
        {item.comment && (
          <span className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            “{item.comment}”
          </span>
        )}
      </span>
      <span className="flex items-center gap-2">
        {item.status !== "reviewed" && (
          <Button
            size="sm"
            intent="secondary"
            isLoading={triage.isPending && triage.variables === "reviewed"}
            onClick={() => triage.mutate("reviewed")}
          >
            Reviewed
          </Button>
        )}
        <Button
          size="sm"
          isLoading={triage.isPending && triage.variables === "actioned"}
          onClick={() => triage.mutate("actioned")}
        >
          Actioned
        </Button>
      </span>
    </div>
  );
}
