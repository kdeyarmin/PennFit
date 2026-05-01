// /admin/operations — operations center.
//
// Three sections:
//   1. Vendor connectivity strip — green/red dot per integration
//      (SendGrid, Twilio Voice/SMS, Stripe, GCS object store).
//   2. Dispatchers — manual "Run now" buttons for the cart-abandonment
//      and review-request dispatchers, with the eligible-row counter
//      so admins know whether running will actually do anything.
//      Last-run results display for each.
//   3. Team summary — quick read-only counts (active admins, active
//      agents, pending invites) deep-linking to /admin/team.
//
// The PHI sweep status card is rendered separately on the dashboard
// home (PhiSweepStatusCard); this page focuses on the operator-action
// surface.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  fetchOpsStatus,
  runAbandonedCartDispatcher,
  runReviewRequestDispatcher,
  type DispatcherResult,
  type OpsStatus,
} from "../lib/ops-api";

export function AdminOperationsPage() {
  const status = useQuery({
    queryKey: ["admin-ops-status"],
    queryFn: fetchOpsStatus,
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6 max-w-5xl" data-testid="admin-operations-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Operations
        </h1>
        <p className="text-sm text-slate-600">
          Vendor connectivity, dispatcher controls, and team summary.
          Run dispatchers from here when ops needs to fire them
          out-of-band; otherwise they'll fire on their normal cadence.
        </p>
      </header>

      {status.isPending ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : status.isError ? (
        <div className="text-sm text-rose-700" role="alert">
          Couldn&apos;t load status:{" "}
          {status.error instanceof Error ? status.error.message : "unknown"}.
        </div>
      ) : status.data ? (
        <Body data={status.data} onRefresh={() => void status.refetch()} />
      ) : null}
    </div>
  );
}

function Body({
  data,
  onRefresh,
}: {
  data: OpsStatus;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-6">
      <VendorStrip vendors={data.vendors} />
      <DispatchersPanel dispatchers={data.dispatchers} onRefresh={onRefresh} />
      <TeamSummary team={data.team} />
    </div>
  );
}

function VendorStrip({ vendors }: { vendors: OpsStatus["vendors"] }) {
  const items: Array<{ key: keyof OpsStatus["vendors"]; label: string; hint: string }> = [
    {
      key: "sendgrid",
      label: "SendGrid",
      hint: "Outbound email (receipts, reminders, review requests)",
    },
    { key: "twilioSms", label: "Twilio SMS", hint: "Outbound resupply SMS" },
    { key: "twilioVoice", label: "Twilio Voice", hint: "Outbound voice calls" },
    { key: "stripe", label: "Stripe", hint: "Cash-pay shop checkout + refunds" },
    {
      key: "objectStorage",
      label: "Object storage (GCS)",
      hint: "Prescription document attachments",
    },
  ];
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600 mb-2">
        Vendor connectivity
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => {
          const ok = vendors[it.key];
          return (
            <div
              key={it.key}
              className={`rounded-lg border p-3 ${
                ok
                  ? "border-emerald-200 bg-emerald-50"
                  : "border-amber-200 bg-amber-50"
              }`}
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1 inline-block h-2 w-2 rounded-full ${
                    ok ? "bg-emerald-500" : "bg-amber-500"
                  }`}
                  aria-label={ok ? "Configured" : "Not configured"}
                />
                <div>
                  <div
                    className={`text-sm font-semibold ${
                      ok ? "text-emerald-900" : "text-amber-900"
                    }`}
                  >
                    {it.label}{" "}
                    <span className="text-[11px] font-normal opacity-70">
                      {ok ? "configured" : "not configured"}
                    </span>
                  </div>
                  <div className="text-xs text-slate-700 opacity-80">
                    {it.hint}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 mt-2">
        &ldquo;Configured&rdquo; means the vendor&apos;s required env vars are
        present. It does NOT mean the most recent send succeeded —
        check the dispatcher result panels below for that.
      </p>
    </section>
  );
}

function DispatchersPanel({
  dispatchers,
  onRefresh,
}: {
  dispatchers: OpsStatus["dispatchers"];
  onRefresh: () => void;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600 mb-2">
        Dispatchers
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <DispatcherCard
          title="Cart-abandonment nudge"
          subtitle="One reminder email per cart that has sat idle for 24+ hours, gated by communication preferences and quiet hours."
          eligibleNow={dispatchers.abandonedCart.eligibleNow}
          run={runAbandonedCartDispatcher}
          onRefresh={onRefresh}
        />
        <DispatcherCard
          title="Post-purchase review request"
          subtitle="Emails customers ~14 days after a paid order asking for a product review. Comm-prefs + DND aware."
          eligibleNow={dispatchers.reviewRequest.eligibleNow}
          run={runReviewRequestDispatcher}
          onRefresh={onRefresh}
        />
      </div>
    </section>
  );
}

function DispatcherCard({
  title,
  subtitle,
  eligibleNow,
  run,
  onRefresh,
}: {
  title: string;
  subtitle: string;
  eligibleNow: number;
  run: () => Promise<DispatcherResult>;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DispatcherResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const r = await run();
      setResult(r);
      setRanAt(new Date().toLocaleTimeString());
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="text-xs text-slate-600 mt-0.5">{subtitle}</p>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs">
          <span className="text-slate-500">Eligible now:</span>{" "}
          <span className="font-bold tabular-nums text-slate-900">
            {eligibleNow}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void onClick()}
          disabled={busy}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {busy ? "Running…" : "Run now"}
        </button>
      </div>
      {error && (
        <p className="text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}
      {result && (
        <ResultPanel result={result} ranAt={ranAt} />
      )}
    </div>
  );
}

function ResultPanel({ result, ranAt }: { result: DispatcherResult; ranAt: string | null }) {
  const rows = useMemo(() => {
    const items: Array<[string, number]> = [];
    if (result.scanned !== undefined) items.push(["Scanned", result.scanned]);
    if (result.sent !== undefined) items.push(["Sent", result.sent]);
    if (result.skippedOptOut !== undefined && result.skippedOptOut > 0)
      items.push(["Skipped (opt-out / DND)", result.skippedOptOut]);
    if (result.skippedNoConfig !== undefined && result.skippedNoConfig > 0)
      items.push(["Skipped (vendor not configured)", result.skippedNoConfig]);
    if (result.skippedFailed !== undefined && result.skippedFailed > 0)
      items.push(["Skipped (send failed)", result.skippedFailed]);
    return items;
  }, [result]);

  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-2">
      <div className="text-[11px] text-slate-500 mb-1">
        Last run{ranAt ? ` at ${ranAt}` : ""}
      </div>
      <ul className="text-xs space-y-0.5">
        {rows.map(([label, value]) => (
          <li key={label} className="flex justify-between">
            <span className="text-slate-600">{label}</span>
            <span className="tabular-nums font-semibold text-slate-900">
              {value}
            </span>
          </li>
        ))}
        {result.sendgridConfigured === false && (
          <li className="text-amber-800 mt-1">
            ⚠ SendGrid is not configured — sends were skipped.
          </li>
        )}
      </ul>
    </div>
  );
}

function TeamSummary({ team }: { team: OpsStatus["team"] }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Team
        </h2>
        <Link
          href="/admin/team"
          className="text-xs underline decoration-dotted"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Manage team →
        </Link>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Tile label="Active admins" value={team.activeAdmins} />
        <Tile label="Active CSRs" value={team.activeAgents} />
        <Tile
          label="Pending invitations"
          value={team.pendingInvites}
          hint={
            team.pendingInvites > 0
              ? "Invites that haven't been accepted yet"
              : undefined
          }
        />
      </div>
    </section>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums mt-1 text-slate-900">
        {value}
      </div>
      {hint && <div className="text-[11px] text-slate-500 mt-1">{hint}</div>}
    </div>
  );
}
