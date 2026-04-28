import { Link } from "wouter";
import { useGetDashboardSummary } from "@workspace/resupply-api-client";
import { KpiCard } from "../components/Card";
import { ErrorPanel } from "../components/ErrorPanel";

// Operator landing page. Six KPI tiles + four "filtered queue" deep
// links. Numbers come from /dashboard/summary which is a single
// COUNT(*)-only query — no PHI crosses the API boundary.

export function DashboardPage() {
  const { data, isPending, isError, error, refetch } = useGetDashboardSummary();

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "#0a1f44" }}
        >
          Dashboard
        </h1>
        <p className="text-sm" style={{ color: "#374151" }}>
          Live counters across the resupply pipeline.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <KpiCard
          label="Active conversations"
          value={data?.activeConversations ?? "—"}
          isLoading={isPending}
          hint="open · awaiting_patient · awaiting_operator"
        />
        <KpiCard
          label="Awaiting operator"
          value={data?.awaitingOperator ?? "—"}
          isLoading={isPending}
          hint="parked for human attention"
        />
        <KpiCard
          label="Overdue episodes"
          value={data?.overdueEpisodes ?? "—"}
          isLoading={isPending}
          hint="due_at ≤ now & status pending or awaiting"
        />
        <KpiCard
          label="Fulfillments this week"
          value={data?.fulfillmentsThisWeek ?? "—"}
          isLoading={isPending}
          hint="created in last 7 days"
        />
        <KpiCard
          label="Paused patients"
          value={data?.pausedPatients ?? "—"}
          isLoading={isPending}
          hint="status = paused"
        />
      </div>

      <section
        className="bg-white border rounded-lg p-5"
        style={{ borderColor: "#e5e7eb" }}
      >
        <h2
          className="text-base font-semibold mb-3"
          style={{ color: "#0a1f44" }}
        >
          Quick links
        </h2>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <li>
            <Link
              href="/conversations?status=awaiting_operator"
              className="underline"
              style={{ color: "#0a1f44" }}
            >
              Conversations awaiting operator →
            </Link>
          </li>
          <li>
            <Link
              href="/episodes?status=overdue"
              className="underline"
              style={{ color: "#0a1f44" }}
            >
              Overdue episode queue →
            </Link>
          </li>
          <li>
            <Link
              href="/patients?status=active"
              className="underline"
              style={{ color: "#0a1f44" }}
            >
              Active patients →
            </Link>
          </li>
          <li>
            <Link
              href="/audit"
              className="underline"
              style={{ color: "#0a1f44" }}
            >
              Recent audit activity →
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
