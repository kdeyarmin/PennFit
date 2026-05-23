import { Link } from "wouter";
import { useGetDashboardSummary } from "@workspace/api-client-react/admin";
import { KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { PhiSweepStatusCard } from "@/components/admin/PhiSweepStatusCard";

// Admin landing page. Six KPI tiles + four "filtered queue" deep
// links. Numbers come from /dashboard/summary which is a single
// COUNT(*)-only query — no PHI crosses the API boundary.
//
// Each KPI tile is wrapped in a Link to a pre-filtered queue view —
// admins can click "Awaiting admin" and land directly on the filtered
// conversations list rather than re-typing the filter. The destination
// always honours an existing query string the page understands; if a
// page doesn't take that exact filter today, the link still navigates
// to the page so the admin can refine from there.

type KpiLink = {
  label: string;
  value: number | "—";
  hint: string;
  href: string;
  testId: string;
};

export function DashboardPage() {
  const { data, isPending, isError, error, refetch } = useGetDashboardSummary();

  const kpis: KpiLink[] = [
    {
      label: "Active conversations",
      value: data?.activeConversations ?? "—",
      hint: "open · awaiting_patient · awaiting_admin",
      href: "/admin/conversations?status=open",
      testId: "kpi-active-conversations",
    },
    {
      label: "Awaiting admin",
      value: data?.awaitingAdmin ?? "—",
      hint: "parked for human attention",
      href: "/admin/conversations?status=awaiting_admin",
      testId: "kpi-awaiting-admin",
    },
    {
      label: "Overdue episodes",
      value: data?.overdueEpisodes ?? "—",
      hint: "due_at ≤ now & status pending or awaiting",
      href: "/admin/episodes?status=overdue",
      testId: "kpi-overdue-episodes",
    },
    {
      label: "Fulfillments this week",
      value: data?.fulfillmentsThisWeek ?? "—",
      hint: "created in last 7 days",
      href: "/admin/episodes?status=fulfilled",
      testId: "kpi-fulfillments-week",
    },
    {
      label: "Paused patients",
      value: data?.pausedPatients ?? "—",
      hint: "status = paused",
      href: "/admin/patients?status=paused",
      testId: "kpi-paused-patients",
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Dashboard
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Live counters across the resupply pipeline. Each tile links to its
          filtered queue.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((k) => (
          <Link
            key={k.testId}
            href={k.href}
            className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a24a] focus-visible:ring-offset-2 transition-shadow hover:shadow-md"
            data-testid={k.testId}
          >
            <KpiCard
              label={k.label}
              value={k.value}
              isLoading={isPending}
              hint={k.hint}
            />
          </Link>
        ))}
      </div>

      <PhiSweepStatusCard
        data={data?.prescriptionAttachmentSweep}
        isLoading={isPending}
      />

      <section
        className="bg-white border rounded-lg p-5"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <h2
          className="text-base font-semibold mb-3"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Quick links
        </h2>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <li>
            <Link
              href="/admin/conversations?status=awaiting_admin"
              className="underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Conversations awaiting admin →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/episodes?status=overdue"
              className="underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Overdue episode queue →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/patients?status=active"
              className="underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Active patients →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/shop/abandoned-carts"
              className="underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Abandoned shop carts →
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
