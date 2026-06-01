// /admin/productivity — per-agent throughput dashboard.
//
// Surveyors expect, and supervisors ask for, a "who's actually
// handling work" view. This page is exactly that: one row per
// active admin / CSR with their open queue + the events they
// closed in the chosen window.
//
// Numbers shown are attribution-best-effort: messages don't carry
// an admin_user_id today, and "conversation closed" attributes to
// the last assignee (not necessarily the closer). Both caveats are
// disclosed inline so a supervisor doesn't over-index on noisy
// signals.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";

import { humanizeStatus } from "@/components/admin/Badge";
import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  getProductivity,
  type AgentStats,
  type ProductivityWindow,
} from "@/lib/admin/productivity-api";

const WINDOW_LABEL: Record<ProductivityWindow, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export function AdminProductivityPage() {
  const [window, setWindow] = useState<ProductivityWindow>("7d");
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "productivity", window] as const,
    queryFn: () => getProductivity(window),
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Activity className="h-6 w-6" />
          Team throughput
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Per-agent count of conversations closed, returns approved, compliance
          alerts resolved, and follow-ups completed. Open queue depth (left
          column) reflects the current moment; everything else is scoped to the
          selected window.
        </p>
      </header>

      <div className="flex items-center gap-2">
        {(Object.keys(WINDOW_LABEL) as ProductivityWindow[]).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindow(w)}
            className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
            style={{
              backgroundColor:
                w === window ? "hsl(var(--penn-gold))" : "hsl(var(--line-2))",
              color:
                w === window ? "hsl(var(--penn-navy))" : "hsl(var(--ink-2))",
            }}
          >
            {WINDOW_LABEL[w]}
          </button>
        ))}
      </div>

      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : data.agents.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground py-2">
            No active admins on the roster yet. Invite team members at{" "}
            <a
              href="/admin/team"
              className="hover:underline"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              /admin/team
            </a>{" "}
            to see them here.
          </p>
        </Card>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left border-b"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <th className="py-2 font-semibold">Agent</th>
                <th className="py-2 font-semibold text-right">
                  Open
                  <div className="text-[10px] font-normal text-muted-foreground">
                    queue (now)
                  </div>
                </th>
                <th className="py-2 font-semibold text-right">
                  Closed
                  <div className="text-[10px] font-normal text-muted-foreground">
                    conversations*
                  </div>
                </th>
                <th className="py-2 font-semibold text-right">
                  Returns
                  <div className="text-[10px] font-normal text-muted-foreground">
                    approved / rejected
                  </div>
                </th>
                <th className="py-2 font-semibold text-right">
                  Compliance
                  <div className="text-[10px] font-normal text-muted-foreground">
                    alerts resolved
                  </div>
                </th>
                <th className="py-2 font-semibold text-right">
                  Follow-ups
                  <div className="text-[10px] font-normal text-muted-foreground">
                    completed
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <AgentRow key={a.adminUserId} agent={a} />
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] text-muted-foreground">
            * &ldquo;Closed conversations&rdquo; attributes to the last
            assignee; conversation rows don&rsquo;t carry an explicit closer
            today, so this is a best-effort proxy.
          </p>
        </Card>
      )}
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentStats }) {
  return (
    <tr className="border-b" style={{ borderColor: "hsl(var(--line-2))" }}>
      <td className="py-1.5">
        <div className="font-semibold">
          {agent.displayName?.trim() || agent.email}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {humanizeStatus(agent.role)}
          {agent.displayName?.trim() ? ` · ${agent.email}` : null}
        </div>
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums">
        {agent.assignedConversationsOpen}
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums">
        {agent.conversationsClosedInWindow}
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums">
        {agent.returnsApproved}
        <span className="text-muted-foreground">
          {" "}
          / {agent.returnsRejected}
        </span>
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums">
        {agent.complianceAlertsResolved}
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums">
        {agent.followupsCompleted}
      </td>
    </tr>
  );
}
