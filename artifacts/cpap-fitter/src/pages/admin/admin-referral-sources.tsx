// /admin/referral-sources — the referral-source CRM.
//
// A scorecard of which referring physicians drive the most claim volume,
// patients, and paid revenue (from insurance_claims.referring_provider_id),
// plus a per-source rep-activity log (visits/calls) so a relationship owner
// can record outreach and the next action. reports.read-gated server-side
// (logging a touch is conversations.manage). No patient PHI — provider +
// claim aggregates only.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartHandshake } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  getReferralActivity,
  getReferralScorecard,
  logReferralActivity,
  type ReferralSourceRow,
} from "@/lib/admin/referral-sources-api";

const WINDOWS = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
  { value: 365, label: "365 days" },
];

const ACTIVITY_TYPES = ["visit", "call", "email", "lunch", "mailer", "other"];

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function AdminReferralSourcesPage() {
  const [days, setDays] = useState(90);
  const [openProviderId, setOpenProviderId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin", "referrals", "scorecard", days],
    queryFn: () => getReferralScorecard(days),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-referral-sources-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <HeartHandshake className="h-6 w-6" />
            Referral sources
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Referring physicians ranked by claim volume, patients, and paid
            revenue. Expand a row to log a rep visit or call.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          Window
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded border border-slate-300 px-2 py-1 text-xs"
          >
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {query.isPending ? (
        <Spinner label="Loading referral sources…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.sources.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No referring physicians on any claims yet. Referral sources appear
            here once claims carry a referring/ordering provider.
          </p>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left">
                    Referring physician
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Claims
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Patients
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    In window
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Paid
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Last touch
                  </th>
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.sources.map((s) => (
                  <ScorecardRow
                    key={s.providerId}
                    source={s}
                    open={openProviderId === s.providerId}
                    onToggle={() =>
                      setOpenProviderId(
                        openProviderId === s.providerId ? null : s.providerId,
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function ScorecardRow({
  source,
  open,
  onToggle,
}: {
  source: ReferralSourceRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-t border-slate-100">
        <td className="px-3 py-2">
          <div className="font-medium" style={{ color: "hsl(var(--ink-1))" }}>
            {source.providerName ?? "Unknown physician"}
          </div>
          <div className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
            {[source.practiceName, source.npi ? `NPI ${source.npi}` : null]
              .filter(Boolean)
              .join(" · ") || "—"}
          </div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {num(source.claimCount)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {num(source.patientCount)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {num(source.claimsSince)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {usd(source.paidCents)}
        </td>
        <td
          className="px-3 py-2 text-xs"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {source.lastActivityOn ?? "—"}
        </td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="text-xs underline"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            {open ? "Hide" : "Activity"}
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={7} className="px-3 py-3 bg-slate-50/60">
            <ActivityPanel providerId={source.providerId} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ActivityPanel({ providerId }: { providerId: string }) {
  const qc = useQueryClient();
  const [activityType, setActivityType] = useState("visit");
  const [summary, setSummary] = useState("");
  const [nextAction, setNextAction] = useState("");

  const activity = useQuery({
    queryKey: ["admin", "referrals", "activity", providerId],
    queryFn: () => getReferralActivity(providerId),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: () =>
      logReferralActivity(providerId, {
        activityType,
        summary: summary.trim(),
        nextAction: nextAction.trim() || null,
      }),
    onSuccess: () => {
      setSummary("");
      setNextAction("");
      void qc.invalidateQueries({
        queryKey: ["admin", "referrals", "activity", providerId],
      });
      void qc.invalidateQueries({
        queryKey: ["admin", "referrals", "scorecard"],
      });
    },
  });

  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (summary.trim()) mutation.mutate();
        }}
      >
        <label className="text-xs text-slate-600">
          Type
          <select
            value={activityType}
            onChange={(e) => setActivityType(e.target.value)}
            className="block rounded border border-slate-300 px-2 py-1 text-xs"
          >
            {ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-600 flex-1 min-w-[200px]">
          Summary
          <input
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Dropped off brochures, discussed turnaround times…"
            className="block w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />
        </label>
        <label className="text-xs text-slate-600 flex-1 min-w-[160px]">
          Next action (optional)
          <input
            type="text"
            value={nextAction}
            onChange={(e) => setNextAction(e.target.value)}
            placeholder="Follow up in 2 weeks"
            className="block w-full rounded border border-slate-300 px-2 py-1 text-xs"
          />
        </label>
        <button
          type="submit"
          disabled={!summary.trim() || mutation.isPending}
          className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {mutation.isPending ? "Logging…" : "Log touch"}
        </button>
      </form>
      {mutation.isError ? (
        <p className="text-xs text-red-600">Could not log the activity.</p>
      ) : null}

      {activity.isPending ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Loading activity…
        </p>
      ) : activity.isError ? (
        <p className="text-xs text-red-600">Could not load activity.</p>
      ) : activity.data.activity.length === 0 ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          No rep activity logged yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {activity.data.activity.map((a) => (
            <li
              key={a.id}
              className="text-xs flex flex-wrap gap-x-2"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              <span
                className="tabular-nums"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {a.occurredOn}
              </span>
              <span className="font-medium uppercase">{a.activityType}</span>
              <span>{a.summary}</span>
              {a.nextAction ? (
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  → {a.nextAction}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
