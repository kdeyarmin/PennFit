// /admin/followups — unified admin queue of open follow-ups across
// customers and patients (Phase 18, expanded in Phase 20).
//
// Phase 17 surfaced follow-ups inside the customer-360 page; Phase 18
// flipped the view around so a CSR opening admin can see "what does
// the team owe today across everyone" in one screen, and Phase 20
// extended that unified queue to include patient follow-ups too.
//
// Three buckets, computed client-side from the timestamps:
//   * Overdue (due_at < now) — rose-tinted, listed first.
//   * Today (due_at within next 24h) — neutral.
//   * Upcoming (everything else) — muted.
//
// Each row links to the relevant admin context and has a one-click
// "Done" that reuses the appropriate per-entity PATCH endpoint.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarClock, CheckCircle2, ExternalLink } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  listAllAdminFollowups,
  type AdminFollowupRow,
} from "@/lib/admin/followups-list-api";
import { completeAdminCustomerFollowup } from "@/lib/admin/customer-followups-api";
import { completeAdminPatientFollowup } from "@/lib/admin/patient-followups-api";

const DAY_MS = 24 * 60 * 60 * 1000;

export function AdminFollowupsPage() {
  const qc = useQueryClient();
  const queryKey = ["admin", "followups", "open"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: listAllAdminFollowups,
  });

  const completeMutation = useMutation({
    // Phase 20: row.kind switches between the customer and patient
    // PATCH endpoints. Both surfaces use the same id-shape contract
    // and return the same response shape.
    mutationFn: (row: AdminFollowupRow) =>
      row.kind === "patient"
        ? completeAdminPatientFollowup(row.subjectId, row.id)
        : completeAdminCustomerFollowup(row.subjectId, row.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      // Phase 16 inbox-counts feeds the nav badge — invalidate so the
      // overdue count drops immediately rather than waiting for the
      // 30s staleTime.
      void qc.invalidateQueries({ queryKey: ["admin-inbox-counts"] });
    },
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

  const buckets = bucketize(data.followups);
  const completingId = completeMutation.isPending
    ? (completeMutation.variables?.id ?? null)
    : null;

  return (
    <div
      style={{
        padding: 24,
        display: "grid",
        gap: 16,
        maxWidth: 900,
        margin: "0 auto",
      }}
      data-testid="admin-followups-page"
    >
      <header>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <CalendarClock size={20} />
          Follow-ups
        </h1>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: 13,
            color: "var(--text-muted, #475569)",
          }}
        >
          What the team owes today, across all customers. Schedule new
          follow-ups from any customer&apos;s 360 page.
        </p>
      </header>

      <Bucket
        title="Overdue"
        rows={buckets.overdue}
        emptyHint="Nothing overdue. Nice work."
        tone="danger"
        onComplete={(row) => completeMutation.mutate(row)}
        completingId={completingId}
      />
      <Bucket
        title="Due today"
        rows={buckets.today}
        emptyHint="Nothing due in the next 24 hours."
        tone="warning"
        onComplete={(row) => completeMutation.mutate(row)}
        completingId={completingId}
      />
      <Bucket
        title="Upcoming"
        rows={buckets.upcoming}
        emptyHint="Nothing scheduled further out."
        tone="muted"
        onComplete={(row) => completeMutation.mutate(row)}
        completingId={completingId}
      />
    </div>
  );
}

function bucketize(rows: AdminFollowupRow[]): {
  overdue: AdminFollowupRow[];
  today: AdminFollowupRow[];
  upcoming: AdminFollowupRow[];
} {
  const now = Date.now();
  const cutoff = now + DAY_MS;
  const overdue: AdminFollowupRow[] = [];
  const today: AdminFollowupRow[] = [];
  const upcoming: AdminFollowupRow[] = [];
  for (const r of rows) {
    const due = new Date(r.dueAt).getTime();
    if (due < now) overdue.push(r);
    else if (due < cutoff) today.push(r);
    else upcoming.push(r);
  }
  return { overdue, today, upcoming };
}

function Bucket({
  title,
  rows,
  emptyHint,
  tone,
  onComplete,
  completingId,
}: {
  title: string;
  rows: AdminFollowupRow[];
  emptyHint: string;
  tone: "danger" | "warning" | "muted";
  onComplete: (row: AdminFollowupRow) => void;
  completingId: string | null;
}) {
  return (
    <Card>
      <div
        style={{ padding: 16 }}
        data-testid={`admin-followups-bucket-${title.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 14,
            marginBottom: 8,
            color:
              tone === "danger"
                ? "#b91c1c"
                : tone === "warning"
                  ? "#92400e"
                  : "var(--text-muted, #475569)",
          }}
        >
          {title} ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: "var(--text-muted, #475569)",
            }}
          >
            {emptyHint}
          </p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 8,
            }}
          >
            {rows.map((r) => (
              <Row
                key={r.id}
                row={r}
                tone={tone}
                onComplete={onComplete}
                isCompleting={completingId === r.id}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Row({
  row,
  tone,
  onComplete,
  isCompleting,
}: {
  row: AdminFollowupRow;
  tone: "danger" | "warning" | "muted";
  onComplete: (row: AdminFollowupRow) => void;
  isCompleting: boolean;
}) {
  const accent =
    tone === "danger"
      ? { bg: "#fef2f2", border: "#fecaca" }
      : tone === "warning"
        ? { bg: "#fffbeb", border: "#fde68a" }
        : { bg: "#f8fafc", border: "var(--border, #e2e8f0)" };
  return (
    <li
      style={{
        padding: 10,
        border: `1px solid ${accent.border}`,
        borderRadius: 6,
        background: accent.bg,
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-muted, #475569)",
            marginBottom: 2,
          }}
        >
          Due {new Date(row.dueAt).toLocaleString()} · scheduled by{" "}
          {row.createdByEmail}
          {row.kind === "patient" && (
            <span
              style={{
                marginLeft: 6,
                padding: "0 4px",
                borderRadius: 3,
                background: "#e0f2fe",
                color: "#075985",
                fontSize: 10,
                fontWeight: 600,
              }}
            >
              Patient
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 6 }}>
          {row.body}
        </div>
        <Link href={subjectHref(row)}>
          <a
            style={{
              fontSize: 12,
              color: "#1e40af",
              textDecoration: "none",
              display: "inline-flex",
              gap: 4,
              alignItems: "center",
            }}
            data-testid={`admin-followup-customer-link-${row.id}`}
          >
            {row.subjectDisplayName ?? row.subjectEmail ?? row.subjectId}
            <ExternalLink size={11} />
          </a>
        </Link>
      </div>
      <Button
        size="sm"
        intent="secondary"
        disabled={isCompleting}
        onClick={() => onComplete(row)}
        data-testid={`admin-followup-complete-${row.id}`}
      >
        <CheckCircle2 size={12} />
        {isCompleting ? "Saving…" : "Done"}
      </Button>
    </li>
  );
}

// Phase 20: route the row's "Open subject" link to the right detail
// page based on `kind`. Shop customers live under /admin/shop/customers,
// patients under /admin/patients.
function subjectHref(row: AdminFollowupRow): string {
  if (row.kind === "patient") {
    return `/admin/patients/${encodeURIComponent(row.subjectId)}`;
  }
  return `/admin/shop/customers/${encodeURIComponent(row.subjectId)}`;
}
