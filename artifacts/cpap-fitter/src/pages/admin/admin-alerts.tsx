// /admin/alerts — the Alert Library.
//
// A curated catalog of alerts that can be sent to a patient over
// email, SMS, or an automated phone call. Each alert exposes an
// editable per-channel message (subject + HTML/text body for email;
// a single text body / spoken transcript for SMS and voice). Admins
// edit the copy inline; a "Send test" action dispatches one alert to
// one patient over one channel.
//
// Hand-rolled Tailwind UI to match the rest of pages/admin/* (e.g.
// admin-macros.tsx) — no shadcn dependency. Copy edits hit
// PATCH /admin/alerts/:key/messages/:channel; sends hit
// POST /admin/alerts/:key/send.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type AlertChannel,
  type AlertDefinition,
  type AlertMessage,
  listAlerts,
  patchAlertMessage,
  sendAlert,
} from "@/lib/admin/alerts-api";

const alertsQueryKey = ["admin-alerts"] as const;

const SEVERITY_STYLE: Record<string, string> = {
  info: "bg-slate-100 text-slate-700",
  warning: "bg-amber-100 text-amber-900",
  critical: "bg-rose-100 text-rose-900",
};

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  voice: "Phone call",
};

export function AdminAlertsPage() {
  return (
    <div className="space-y-6" data-testid="admin-alerts-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Alert library
        </h1>
        <p className="text-sm text-slate-600">
          Curated alerts you can send to a patient over email, SMS, or an
          automated phone call. Edit the message for each channel below — copy
          supports merge tokens like{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            {"{{first_name}}"}
          </code>
          . Edits take effect immediately.
        </p>
      </header>
      <AlertList />
    </div>
  );
}

function AlertList() {
  const query = useQuery({
    queryKey: alertsQueryKey,
    queryFn: listAlerts,
  });

  const grouped = useMemo(() => {
    const byCategory = new Map<string, AlertDefinition[]>();
    for (const a of query.data?.alerts ?? []) {
      const list = byCategory.get(a.category) ?? [];
      list.push(a);
      byCategory.set(a.category, list);
    }
    return [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [query.data]);

  if (query.isPending) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className="text-sm text-rose-700" role="alert">
        Couldn&apos;t load alerts:{" "}
        {query.error instanceof Error ? query.error.message : "unknown error"}.
      </div>
    );
  }
  if (grouped.length === 0) {
    return (
      <div className="text-sm text-slate-500">
        No alerts defined yet. The starter library is seeded by migration
        0179 — if this is empty, the migration hasn&apos;t been applied to this
        environment.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {grouped.map(([category, alerts]) => (
        <section key={category}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-600">
            {category}
          </h2>
          <ul className="space-y-3">
            {alerts.map((a) => (
              <AlertCard key={a.key} alert={a} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AlertCard({ alert }: { alert: AlertDefinition }) {
  const [openChannel, setOpenChannel] = useState<AlertChannel | null>(null);
  const [sending, setSending] = useState(false);

  const messageByChannel = useMemo(() => {
    const m = new Map<string, AlertMessage>();
    for (const msg of alert.messages) m.set(msg.channel, msg);
    return m;
  }, [alert.messages]);

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">
              {alert.name}
            </span>
            <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-500">
              {alert.key}
            </code>
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                SEVERITY_STYLE[alert.severity] ?? SEVERITY_STYLE.info
              }`}
            >
              {alert.severity}
            </span>
            {!alert.isActive && (
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                inactive
              </span>
            )}
          </div>
          {alert.description && (
            <p className="mt-1 text-sm text-slate-600">{alert.description}</p>
          )}
          {alert.allowedVariables.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {alert.allowedVariables.map((v) => (
                <code
                  key={v}
                  className="rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-500"
                >
                  {`{{${v}}}`}
                </code>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSending((s) => !s)}
          className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          {sending ? "Close" : "Send test"}
        </button>
      </div>

      {sending && <SendTestForm alert={alert} onClose={() => setSending(false)} />}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {alert.channels.map((ch) => {
          const channel = ch as AlertChannel;
          const has = messageByChannel.has(ch);
          const isOpen = openChannel === channel;
          return (
            <button
              key={ch}
              type="button"
              onClick={() => setOpenChannel(isOpen ? null : channel)}
              className={`rounded border px-2 py-1 text-xs font-semibold ${
                isOpen
                  ? "border-blue-400 bg-blue-50 text-blue-800"
                  : "border-slate-300 text-slate-700 hover:bg-slate-50"
              } ${has ? "" : "opacity-50"}`}
            >
              {CHANNEL_LABEL[ch] ?? ch}
            </button>
          );
        })}
      </div>

      {openChannel &&
        (messageByChannel.has(openChannel) ? (
          <ChannelEditor
            alertKey={alert.key}
            channel={openChannel}
            message={messageByChannel.get(openChannel)!}
          />
        ) : (
          <div className="mt-3 text-sm text-slate-500">
            No {CHANNEL_LABEL[openChannel] ?? openChannel} message configured for
            this alert.
          </div>
        ))}
    </li>
  );
}

function ChannelEditor({
  alertKey,
  channel,
  message,
}: {
  alertKey: string;
  channel: AlertChannel;
  message: AlertMessage;
}) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState(message.subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(message.bodyHtml ?? "");
  const [bodyText, setBodyText] = useState(message.bodyText);

  const patch = useMutation({
    mutationFn: () =>
      patchAlertMessage(alertKey, channel, {
        ...(channel === "email"
          ? {
              subject: subject.trim() === "" ? null : subject,
              bodyHtml: bodyHtml.trim() === "" ? null : bodyHtml,
            }
          : {}),
        bodyText,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: alertsQueryKey });
    },
  });

  const dirty =
    bodyText !== message.bodyText ||
    (channel === "email" &&
      (subject !== (message.subject ?? "") ||
        bodyHtml !== (message.bodyHtml ?? "")));

  return (
    <div className="mt-3 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      {channel === "email" && (
        <>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">
              Subject
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              aria-label="Subject"
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">
              HTML body
            </label>
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={5}
              aria-label="HTML body"
              className="w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
            />
          </div>
        </>
      )}
      <div>
        <label className="mb-1 block text-xs font-semibold text-slate-600">
          {channel === "voice"
            ? "Spoken transcript"
            : channel === "email"
              ? "Plain-text body"
              : "Message body"}
        </label>
        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value.slice(0, 50000))}
          rows={channel === "email" ? 4 : 3}
          aria-label="Message body"
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />
        {channel === "sms" && (
          <p className="mt-1 text-[11px] text-slate-500">
            SMS bodies must be plain ASCII (smart quotes / em-dashes triple the
            cost per message).
          </p>
        )}
      </div>
      {patch.isError && (
        <div className="text-xs text-rose-700" role="alert">
          {patch.error instanceof Error ? patch.error.message : "Save failed."}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="text-[11px] text-slate-400">
          {message.updatedBy
            ? `Last edited by ${message.updatedBy}`
            : "Not yet edited"}
        </span>
        <button
          type="button"
          onClick={() => patch.mutate()}
          disabled={!dirty || patch.isPending}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {patch.isPending ? "Saving…" : "Save message"}
        </button>
      </div>
    </div>
  );
}

function SendTestForm({
  alert,
  onClose,
}: {
  alert: AlertDefinition;
  onClose: () => void;
}) {
  const [patientId, setPatientId] = useState("");
  const [channel, setChannel] = useState<AlertChannel>(
    (alert.channels[0] as AlertChannel) ?? "email",
  );

  const send = useMutation({
    mutationFn: () => sendAlert(alert.key, { patientId: patientId.trim(), channel }),
    onSuccess: () => {
      setPatientId("");
    },
  });

  return (
    <div className="mt-3 space-y-2 rounded-md border border-blue-200 bg-blue-50/60 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            Patient ID
          </label>
          <input
            type="text"
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            aria-label="Patient ID"
            placeholder="UUID"
            className="w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            Channel
          </label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as AlertChannel)}
            aria-label="Channel"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          >
            {alert.channels.map((ch) => (
              <option key={ch} value={ch}>
                {CHANNEL_LABEL[ch] ?? ch}
              </option>
            ))}
          </select>
        </div>
      </div>
      {send.isError && (
        <div className="text-xs text-rose-700" role="alert">
          {send.error instanceof Error ? send.error.message : "Send failed."}
        </div>
      )}
      {send.isSuccess && (
        <div className="text-xs text-emerald-700">Sent ({send.data.channel}).</div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => send.mutate()}
          disabled={patientId.trim() === "" || send.isPending}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {send.isPending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
