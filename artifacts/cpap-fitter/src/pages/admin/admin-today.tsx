// /admin/today — unified CSR work queue.
//
// Aggregate worklist that surfaces the top items across the queues a
// CSR touches every day, in one screen, so opening admin lands on
// "what does the team owe right now" instead of an empty operations
// dashboard. Each section deep-links to its full queue.
//
// Data: GET /admin/today (top 5 per queue, single round-trip).
// Section visibility: a section that has zero items renders a
// muted "all clear" line so the page communicates state explicitly
// rather than going eerily empty.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Inbox,
  MessageSquare,
  PackageX,
  Pill,
  RefreshCw,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  fetchTodayWorklist,
  type TodayResponse,
  type TodayComplianceAlert,
} from "@/lib/admin/today-api";
import { createCoachingPlan } from "@/lib/admin/coaching-plans-api";

const queryKey = ["admin", "today"] as const;

export function AdminTodayPage() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch, isRefetching } = useQuery({
    queryKey,
    queryFn: fetchTodayWorklist,
    refetchOnWindowFocus: true,
  });

  if (isPending) {
    return (
      <div style={{ padding: 24 }}>
        <Spinner />
      </div>
    );
  }
  if (isError) {
    return (
      <div style={{ padding: 24 }}>
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Today</h1>
          <p
            className="text-sm mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Top items across every queue. Cleared up to 5 per section
            — refresh to pull the next batch, or click through to a
            queue for the full list.
          </p>
        </div>
        <Button
          intent="ghost"
          onClick={() => {
            void qc.invalidateQueries({ queryKey });
          }}
          disabled={isRefetching}
        >
          <RefreshCw
            className={`h-4 w-4 mr-1.5 ${isRefetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ConversationsCard data={data} />
        <FollowupsCard data={data} />
        <ReturnsCard data={data} />
        <ComplianceAlertsCard data={data} />
        <RxRenewalsCard data={data} />
        <DocumentsCard data={data} />
        <InboundFaxesCard data={data} />
      </div>
    </div>
  );
}

function SectionTitle({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <span className="flex items-center gap-2">
      {icon}
      <span>{label}</span>
      <span
        className="ml-1 inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums"
        style={{
          backgroundColor:
            count > 0 ? "hsl(var(--penn-gold))" : "hsl(var(--line-2))",
          color: count > 0 ? "hsl(var(--penn-navy))" : "hsl(var(--ink-3))",
        }}
      >
        {count}
      </span>
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs py-2" style={{ color: "hsl(var(--ink-3))" }}>
      <CheckCircle2 className="h-3.5 w-3.5" />
      {children}
    </div>
  );
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function ConversationsCard({ data }: { data: TodayResponse }) {
  const items = data.conversationsAwaitingReply;
  return (
    <Card
      title={
        <SectionTitle
          icon={<MessageSquare className="h-4 w-4" />}
          label="Conversations awaiting reply"
          count={items.length}
        />
      }
      action={
        <Link
          href="/admin/conversations"
          className="text-xs font-semibold hover:underline"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          View inbox →
        </Link>
      }
    >
      {items.length === 0 ? (
        <EmptyState>Inbox is clear.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <Link
                href={`/admin/conversations/${c.id}`}
                className="flex-1 hover:underline"
              >
                <span
                  className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider mr-2"
                  style={{
                    backgroundColor: "hsl(var(--line-2))",
                    color: "hsl(var(--ink-2))",
                  }}
                >
                  {c.channel}
                </span>
                {c.last_message_at ? relativeAge(c.last_message_at) : "—"}
              </Link>
              {c.assigned_admin_user_id == null && (
                <span className="text-[10px] uppercase tracking-wider text-amber-700 font-semibold">
                  Unassigned
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function FollowupsCard({ data }: { data: TodayResponse }) {
  const items = data.overdueFollowups;
  return (
    <Card
      title={
        <SectionTitle
          icon={<Clock className="h-4 w-4" />}
          label="Overdue followups"
          count={items.length}
        />
      }
      action={
        <Link
          href="/admin/followups"
          className="text-xs font-semibold hover:underline"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          All followups →
        </Link>
      }
    >
      {items.length === 0 ? (
        <EmptyState>Nothing overdue.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((f) => {
            const link =
              f.source === "patient"
                ? `/admin/patients/${f.patient_id}`
                : `/admin/shop/customers/${f.customer_id}`;
            return (
              <li key={f.id} className="text-sm">
                <Link href={link} className="hover:underline">
                  <span className="font-medium">
                    {relativeAge(f.due_at)} overdue
                  </span>
                  <span
                    className="ml-2"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    — {f.body.slice(0, 80)}
                    {f.body.length > 80 ? "…" : ""}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ReturnsCard({ data }: { data: TodayResponse }) {
  const items = data.pendingReturns;
  return (
    <Card
      title={
        <SectionTitle
          icon={<PackageX className="h-4 w-4" />}
          label="Returns to action"
          count={items.length}
        />
      }
      action={
        <Link
          href="/admin/shop/returns"
          className="text-xs font-semibold hover:underline"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          All returns →
        </Link>
      }
    >
      {items.length === 0 ? (
        <EmptyState>No returns waiting.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => (
            <li key={r.id} className="text-sm">
              <Link
                href={`/admin/shop/returns`}
                className="hover:underline"
              >
                <span className="font-medium">{humanizeReturnStatus(r.status)}</span>
                <span className="ml-2" style={{ color: "hsl(var(--ink-3))" }}>
                  — {r.reason} · opened {relativeAge(r.created_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ComplianceAlertsCard({ data }: { data: TodayResponse }) {
  const items = data.complianceAlerts;
  return (
    <Card
      title={
        <SectionTitle
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Compliance alerts"
          count={items.length}
        />
      }
    >
      {items.length === 0 ? (
        <EmptyState>No open alerts.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((a) => (
            <ComplianceAlertRow key={a.id} alert={a} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ComplianceAlertRow({ alert }: { alert: TodayComplianceAlert }) {
  const qc = useQueryClient();
  const plan = useMutation({
    mutationFn: () =>
      createCoachingPlan({
        patientId: alert.patient_id,
        sourceAlertId: alert.id,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({
        queryKey: ["admin", "coaching-plans"],
      });
    },
  });
  return (
    <li className="text-sm flex items-start gap-2">
      <SeverityChip severity={alert.severity} />
      <div className="flex-1 min-w-0">
        <Link
          href={`/admin/patients/${alert.patient_id}`}
          className="font-medium hover:underline"
        >
          {humanizeAlertType(alert.alert_type)}
        </Link>
        {alert.summary && (
          <span
            className="ml-2"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            — {alert.summary.slice(0, 80)}
            {alert.summary.length > 80 ? "…" : ""}
          </span>
        )}
        {plan.isError && (
          <div
            className="text-xs mt-0.5"
            style={{ color: "hsl(var(--alert))" }}
          >
            Couldn&apos;t open plan: {(plan.error as Error).message}
          </div>
        )}
      </div>
      <Button
        intent="ghost"
        onClick={() => plan.mutate()}
        disabled={plan.isPending || plan.isSuccess}
        title="Open a coaching plan from this alert (snoozes the alert 30 days)."
      >
        {plan.isSuccess ? "Plan opened" : plan.isPending ? "Opening…" : "Plan"}
      </Button>
    </li>
  );
}

function RxRenewalsCard({ data }: { data: TodayResponse }) {
  const items = data.rxRenewalsDue;
  return (
    <Card
      title={
        <SectionTitle
          icon={<Pill className="h-4 w-4" />}
          label="Rx renewals due (≤30d)"
          count={items.length}
        />
      }
    >
      {items.length === 0 ? (
        <EmptyState>No prescriptions expiring soon.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((r) => {
            const days = daysUntil(r.valid_until);
            return (
              <li key={r.id} className="text-sm">
                <Link
                  href={`/admin/patients/${r.patient_id}`}
                  className="hover:underline"
                >
                  <span className="font-medium">
                    {r.item_sku}
                    {r.hcpcs_code ? ` (${r.hcpcs_code})` : ""}
                  </span>
                  <span
                    className="ml-2"
                    style={{ color: days <= 7 ? "hsl(var(--alert))" : "hsl(var(--ink-3))" }}
                  >
                    — expires in {days} day{days === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DocumentsCard({ data }: { data: TodayResponse }) {
  const items = data.documentsToReview;
  return (
    <Card
      title={
        <SectionTitle
          icon={<FileText className="h-4 w-4" />}
          label="Documents to review"
          count={items.length}
        />
      }
    >
      {items.length === 0 ? (
        <EmptyState>No documents waiting.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((d) => (
            <li key={d.id} className="text-sm">
              <Link
                href={`/admin/patients/${d.patient_id}`}
                className="hover:underline"
              >
                <span className="font-medium">
                  {humanizeDocType(d.document_type)}
                </span>
                <span className="ml-2" style={{ color: "hsl(var(--ink-3))" }}>
                  — {d.filename} · uploaded {relativeAge(d.created_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function InboundFaxesCard({ data }: { data: TodayResponse }) {
  const items = data.inboundFaxes;
  return (
    <Card
      title={
        <SectionTitle
          icon={<Inbox className="h-4 w-4" />}
          label="New inbound faxes"
          count={items.length}
        />
      }
      action={
        <Link
          href="/admin/inbound-faxes"
          className="text-xs font-semibold hover:underline"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          Open queue →
        </Link>
      }
    >
      {items.length === 0 ? (
        <EmptyState>No untriaged faxes.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((f) => (
            <li key={f.id} className="text-sm">
              <Link
                href={`/admin/inbound-faxes`}
                className="hover:underline"
              >
                <span className="font-medium">
                  {f.from_e164 ?? "Unknown sender"}
                </span>
                <span className="ml-2" style={{ color: "hsl(var(--ink-3))" }}>
                  — {f.num_pages ?? "?"}{" "}
                  {f.num_pages === 1 ? "page" : "pages"} ·{" "}
                  {relativeAge(f.received_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SeverityChip({
  severity,
}: {
  severity: TodayComplianceAlert["severity"];
}) {
  const colors: Record<typeof severity, string> = {
    info: "bg-blue-100 text-blue-900",
    warning: "bg-amber-100 text-amber-900",
    critical: "bg-rose-100 text-rose-900",
  };
  const Icon = severity === "critical" ? AlertTriangle : Activity;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${colors[severity]}`}
    >
      <Icon className="h-3 w-3" />
      {severity}
    </span>
  );
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function humanizeReturnStatus(s: string): string {
  switch (s) {
    case "requested":
      return "New return request";
    case "approved":
      return "Awaiting customer ship-back";
    case "shipped_back":
      return "In transit to warehouse";
    case "received":
      return "Received — needs refund or replacement";
    default:
      return s;
  }
}

function humanizeAlertType(t: string): string {
  switch (t) {
    case "low_usage":
      return "Low usage";
    case "no_response":
      return "No response after check-in";
    case "send_failure":
      return "Outreach delivery failure";
    case "manual":
      return "Manual alert";
    default:
      return t;
  }
}

function humanizeDocType(t: string): string {
  switch (t) {
    case "insurance_card":
      return "Insurance card";
    case "prescription":
      return "Prescription";
    case "referral":
      return "Referral";
    case "id_document":
      return "ID";
    case "sleep_study":
      return "Sleep study";
    default:
      return t;
  }
}
