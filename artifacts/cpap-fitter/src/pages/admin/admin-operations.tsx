// /admin/operations — operations center.
//
// Three sections:
//   1. Vendor connectivity strip — green/amber/sky dot per integration
//      (SendGrid, Twilio Voice/SMS, Stripe, Supabase object store).
//      A credential saved in System Configuration but not yet folded
//      into the live process (applyMode: "restart") shows a distinct
//      "saved — applies after restart" state.
//   2. Dispatchers — manual "Run now" buttons for the cart-abandonment
//      and review-request dispatchers, with the eligible-row counter
//      so admins know whether running will actually do anything.
//      Last-run results display for each.
//   3. Team summary — quick read-only counts (active admins, active
//      agents, pending invites) deep-linking to /admin/team.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  fetchOpsStatus,
  runAbandonedCartDispatcher,
  runReviewRequestDispatcher,
  runRxRenewalDispatcher,
  runSmartTriggerDispatcher,
  runSmartTriggerEvaluator,
  type DispatcherResult,
  type OpsStatus,
} from "@/lib/admin/ops-api";
import {
  fetchVoiceMetrics,
  type VoiceMetrics,
} from "@/lib/admin/voice-metrics-api";

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
          Vendor connectivity, dispatcher controls, and team summary. Run
          dispatchers from here when ops needs to fire them out-of-band;
          otherwise they'll fire on their normal cadence.
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

function Body({ data, onRefresh }: { data: OpsStatus; onRefresh: () => void }) {
  return (
    <div className="space-y-6">
      <VendorStrip
        vendors={data.vendors}
        pendingRestart={data.vendorsPendingRestart}
      />
      <DispatchersPanel dispatchers={data.dispatchers} onRefresh={onRefresh} />
      <VoiceHandoffsPanel handoffs={data.voiceHandoffs} />
      <VoiceMetricsPanel />
      <QueuesPanel queues={data.queues} />
      <TeamSummary team={data.team} />
    </div>
  );
}

function QueuesPanel({ queues }: { queues: OpsStatus["queues"] }) {
  // Render only when faxOutreachPending is present — keeps older API
  // responses (or a future queues: {} partial payload) from showing
  // an empty section.
  if (!queues?.faxOutreachPending) return null;
  const faxPending = queues.faxOutreachPending.count ?? 0;
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600 mb-2">
        Manual queues
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-1">
          <h3 className="text-sm font-semibold text-slate-900">
            Physician-fax outreach — pending
          </h3>
          <p className="text-xs text-slate-600">
            CSR-submitted Rx-renewal fax requests waiting for the operator to
            send manually. Will auto-dispatch once a fax vendor adapter ships
            (Phase G.6 noted this is deferred).
          </p>
          <div className="text-xl font-bold tabular-nums text-slate-900">
            {faxPending}
          </div>
        </div>
      </div>
    </section>
  );
}

function VoiceHandoffsPanel({
  handoffs,
}: {
  handoffs: OpsStatus["voiceHandoffs"];
}) {
  // Optional on the API contract — skip the section entirely for older
  // responses rather than render a confusing all-zero panel.
  if (!handoffs) return null;
  const { open, urgent } = handoffs;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Voice handoffs
        </h2>
        <Link
          href="/admin/conversations?view=escalated"
          className="text-xs underline decoration-dotted"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Open escalated queue →
        </Link>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs uppercase tracking-wider text-slate-500">
            Awaiting follow-up
          </div>
          <div className="text-2xl font-bold tabular-nums mt-1 text-slate-900">
            {open}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Voice calls the AI agent flagged for a human teammate, still in the
            escalated queue.
          </div>
        </div>
        <div
          className={`rounded-lg border p-3 ${
            urgent > 0
              ? "border-rose-200 bg-rose-50"
              : "border-slate-200 bg-white"
          }`}
        >
          <div className="text-xs uppercase tracking-wider text-slate-500">
            Urgent (distressed)
          </div>
          <div
            className={`text-2xl font-bold tabular-nums mt-1 ${
              urgent > 0 ? "text-rose-700" : "text-slate-900"
            }`}
          >
            {urgent}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Callers the summarizer scored as distressed — routed at urgent
            priority. Triage these first.
          </div>
        </div>
      </div>
    </section>
  );
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtPct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 1000) / 10}%`;
}

function VoiceMetricsPanel() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["admin-voice-metrics", 30],
    queryFn: () => fetchVoiceMetrics(30),
    refetchInterval: 120_000,
  });

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600 mb-2">
        Voice calls — last 30 days
      </h2>
      {isPending ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : isError || !data ? (
        <div className="text-sm text-slate-500">Voice metrics unavailable.</div>
      ) : data.totalCalls === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          No voice calls recorded in the last 30 days.
        </div>
      ) : (
        <VoiceMetricsBody data={data} />
      )}
    </section>
  );
}

function VoiceMetricsBody({ data }: { data: VoiceMetrics }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Total calls" value={data.totalCalls} />
        <Tile
          label="Answer rate"
          value={fmtPct(data.answerRate)}
          hint={`${data.answeredCalls} answered`}
        />
        <Tile
          label="Avg handle"
          value={fmtDuration(data.avgHandleSeconds)}
          hint={`median ${fmtDuration(data.medianHandleSeconds)}`}
        />
        <Tile
          label="Avg ring"
          value={fmtDuration(data.avgRingSeconds)}
          hint={`median ${fmtDuration(data.medianRingSeconds)}`}
        />
        <Tile
          label="In / Out"
          value={`${data.byDirection.inbound} / ${data.byDirection.outbound}`}
          hint="inbound / outbound"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {Object.entries(data.byStatus)
          .sort(([, a], [, b]) => b - a)
          .map(([status, count]) => (
            <span
              key={status}
              className="text-xs rounded-full border border-slate-200 bg-white px-2.5 py-1 text-slate-700"
            >
              {status}:{" "}
              <span className="font-semibold tabular-nums">{count}</span>
            </span>
          ))}
      </div>
    </div>
  );
}

// Tile accepts string|number so the voice panel can pass formatted
// durations / percentages alongside the integer team counts.

// Visual treatment per connectivity state. "pending" is the saved-in-app
// -but-not-yet-live window (catalog keys are applyMode: "restart").
const VENDOR_STATE_STYLES = {
  ok: {
    card: "border-emerald-200 bg-emerald-50",
    dot: "bg-emerald-500",
    label: "text-emerald-900",
    badge: "configured",
    aria: "Configured",
  },
  pending: {
    card: "border-sky-200 bg-sky-50",
    dot: "bg-sky-500",
    label: "text-sky-900",
    badge: "saved — applies after restart",
    aria: "Saved, applies after restart",
  },
  off: {
    card: "border-amber-200 bg-amber-50",
    dot: "bg-amber-500",
    label: "text-amber-900",
    badge: "not configured",
    aria: "Not configured",
  },
} as const;

function VendorStrip({
  vendors,
  pendingRestart,
}: {
  vendors: OpsStatus["vendors"];
  pendingRestart: OpsStatus["vendorsPendingRestart"];
}) {
  const items: Array<{
    key: keyof OpsStatus["vendors"];
    label: string;
    hint: string;
  }> = [
    {
      key: "sendgrid",
      label: "SendGrid",
      hint: "Outbound email (receipts, reminders, review requests)",
    },
    { key: "twilioSms", label: "SMS", hint: "Outbound resupply SMS" },
    { key: "twilioVoice", label: "Voice", hint: "Outbound voice calls" },
    {
      key: "stripe",
      label: "Stripe",
      hint: "Cash-pay shop checkout + refunds",
    },
    {
      key: "objectStorage",
      label: "Object storage",
      hint: "Prescription document attachments",
    },
  ];
  const anyPending = items.some((it) => pendingRestart?.[it.key]);
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600 mb-2">
        Vendor connectivity
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => {
          // Three states. Check "pending" first: a saved-but-not-live
          // value reports configured===true AND pendingRestart===true,
          // and the restart caveat is the more important signal.
          const pending = pendingRestart?.[it.key] ?? false;
          const state = pending ? "pending" : vendors[it.key] ? "ok" : "off";
          const s = VENDOR_STATE_STYLES[state];
          return (
            <div key={it.key} className={`rounded-lg border p-3 ${s.card}`}>
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1 inline-block h-2 w-2 rounded-full ${s.dot}`}
                  aria-label={s.aria}
                />
                <div>
                  <div className={`text-sm font-semibold ${s.label}`}>
                    {it.label}{" "}
                    <span className="text-[11px] font-normal opacity-70">
                      {s.badge}
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
        &ldquo;Configured&rdquo; (green) means the vendor&apos;s required
        credentials are live in the running environment now. A credential
        entered in{" "}
        <Link
          href="/admin/system/configuration"
          className="underline decoration-dotted"
        >
          System Configuration
        </Link>{" "}
        but not yet applied shows as &ldquo;saved — applies after restart&rdquo;
        instead. Neither state means the most recent send succeeded — check the
        dispatcher result panels below for that.
      </p>
      {anyPending && (
        <p className="text-xs text-sky-700 mt-1">
          &ldquo;Saved — applies after restart&rdquo; means the credential was
          entered in System Configuration but won&apos;t take effect until the
          next deploy/restart. Redeploy the service to activate it.
        </p>
      )}
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
        <DispatcherCard
          title="Rx renewal — email"
          subtitle="Patients whose CPAP prescription is within 30 days of expiry get a one-time email asking them to coordinate a renewal."
          eligibleNow={dispatchers.rxRenewal?.eligibleNow}
          run={() => runRxRenewalDispatcher("email")}
          onRefresh={onRefresh}
        />
        <DispatcherCard
          title="Rx renewal — SMS"
          subtitle="Same window as the email channel; mops up patients without an email on file. Shares the same renewalRequestedAt stamp so a patient never gets nudged twice."
          eligibleNow={dispatchers.rxRenewal?.eligibleNow}
          run={() => runRxRenewalDispatcher("sms")}
          onRefresh={onRefresh}
        />
        <DispatcherCard
          title="Smart-trigger evaluator"
          subtitle="Re-scans patient_therapy_nights for newly fired triggers. Cheap + idempotent; safe to run on demand."
          run={runSmartTriggerEvaluator}
          onRefresh={onRefresh}
        />
        <DispatcherCard
          title="Smart-trigger nudge — email"
          subtitle="Sends one email per detected trigger that hasn't been nudged yet. PHI-safe envelope (kind + window only)."
          eligibleNow={dispatchers.smartTrigger?.eligibleNow}
          run={() => runSmartTriggerDispatcher("email")}
          onRefresh={onRefresh}
        />
        <DispatcherCard
          title="Smart-trigger nudge — SMS"
          subtitle="Same triggers, SMS channel. STOP-keyword compliant; single-segment ASCII."
          eligibleNow={dispatchers.smartTrigger?.eligibleNow}
          run={() => runSmartTriggerDispatcher("sms")}
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
  /** Optional — only the cart-abandonment + review-request dispatchers
   *  surface a count from /admin/ops-status today. Newer dispatchers
   *  (Rx renewal, smart-trigger) skip the badge until they grow one. */
  eligibleNow?: number;
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
          {eligibleNow !== undefined ? (
            <>
              <span className="text-slate-500">Eligible now:</span>{" "}
              <span className="font-bold tabular-nums text-slate-900">
                {eligibleNow}
              </span>
            </>
          ) : (
            <span className="text-slate-400">On-demand dispatcher</span>
          )}
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
      {result && <ResultPanel result={result} ranAt={ranAt} />}
    </div>
  );
}

function ResultPanel({
  result,
  ranAt,
}: {
  result: DispatcherResult;
  ranAt: string | null;
}) {
  const rows = useMemo(() => {
    const items: Array<[string, number | string]> = [];
    // Primary throughput counts
    if (result.scanned !== undefined) items.push(["Scanned", result.scanned]);
    if (result.attempted !== undefined)
      items.push(["Attempted", result.attempted]);
    if (result.proposed !== undefined)
      items.push(["Proposed", result.proposed]);
    // Success counts
    if (result.sent !== undefined) items.push(["Sent", result.sent]);
    if (result.inserted !== undefined)
      items.push(["Inserted", result.inserted]);
    // Failures / skips — only when non-zero to keep the panel tidy
    if (result.failed !== undefined && result.failed > 0)
      items.push(["Failed", result.failed]);
    if (result.skippedOptOut !== undefined && result.skippedOptOut > 0)
      items.push(["Skipped (opt-out / DND)", result.skippedOptOut]);
    if (result.skippedNoConfig !== undefined && result.skippedNoConfig > 0)
      items.push(["Skipped (vendor not configured)", result.skippedNoConfig]);
    if (result.skippedFailed !== undefined && result.skippedFailed > 0)
      items.push(["Skipped (send failed)", result.skippedFailed]);
    if (result.skippedNoContact !== undefined && result.skippedNoContact > 0)
      items.push(["Skipped (no contact on file)", result.skippedNoContact]);
    if (result.skippedExisting !== undefined && result.skippedExisting > 0)
      items.push(["Skipped (already detected)", result.skippedExisting]);
    // Backlog / metadata
    if (result.remaining !== undefined && result.remaining > 0)
      items.push(["Remaining (next run)", result.remaining]);
    if (result.windowDays !== undefined)
      items.push(["Window (days)", result.windowDays]);
    if (result.channel !== undefined) items.push(["Channel", result.channel]);
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
  value: number | string;
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
