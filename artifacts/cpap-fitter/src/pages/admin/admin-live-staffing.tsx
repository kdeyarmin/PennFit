// /admin/live-staffing — real-time CSR workload snapshot (CSR #C3).
//
// The companion to "Team throughput" (which is a lagging close-rate
// rollup): this is the LIVE picture a supervisor uses to rebalance work
// mid-shift — open conversation load per active agent, availability,
// who's on shift, and the unassigned backlog.

import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  getLiveStaffing,
  type LiveStaffingSnapshot,
  type StaffAgentLoad,
} from "@/lib/admin/live-staffing-api";

const AVAILABILITY_LABEL: Record<string, string> = {
  available: "Available",
  away: "Away",
  do_not_assign: "Do not assign",
};

export function AdminLiveStaffingPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "staffing", "live"] as const,
    queryFn: getLiveStaffing,
    // It's a live snapshot — keep it fresh while a lead watches it.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="h-6 w-6" />
          Live staffing
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Open conversation load per active agent right now — so you can
          rebalance mid-shift. Refreshes automatically. For close/approve/
          resolve history, see Team throughput.
        </p>
      </header>

      <Card title="Current workload">
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : (
          <StaffingBody data={data} />
        )}
      </Card>
    </div>
  );
}

function StaffingBody({ data }: { data: LiveStaffingSnapshot }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 text-sm">
        <Stat
          label="On shift"
          value={`${data.onShiftAgents}/${data.activeAgents}`}
        />
        <Stat
          label="Open conversations"
          value={String(data.totalOpenConversations)}
        />
        <Stat
          label="Unassigned backlog"
          value={String(data.unassignedOpenConversations)}
          emphasize={data.unassignedOpenConversations > 0}
        />
      </div>

      {data.agents.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No active agents on the roster.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-3 py-1.5 font-medium">Agent</th>
              <th className="px-3 py-1.5 font-medium">Role</th>
              <th className="px-3 py-1.5 font-medium">Availability</th>
              <th className="px-3 py-1.5 font-medium">Shift</th>
              <th className="px-3 py-1.5 font-medium text-right">Open</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => (
              <AgentRow key={a.adminUserId} agent={a} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AgentRow({ agent }: { agent: StaffAgentLoad }) {
  return (
    <tr className="border-t">
      <td className="px-3 py-1.5">{agent.displayName ?? agent.email}</td>
      <td className="px-3 py-1.5 capitalize">{agent.role}</td>
      <td className="px-3 py-1.5">
        {AVAILABILITY_LABEL[agent.availability] ?? agent.availability}
      </td>
      <td className="px-3 py-1.5">{agent.onShift ? "On shift" : "—"}</td>
      <td className="px-3 py-1.5 text-right font-semibold">
        {agent.openConversations}
      </td>
    </tr>
  );
}

function Stat({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        emphasize ? "border-amber-300 bg-amber-50 text-amber-900" : ""
      }`}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
