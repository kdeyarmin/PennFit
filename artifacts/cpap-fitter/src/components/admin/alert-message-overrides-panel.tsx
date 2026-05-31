// Per-patient alert-message overrides — embedded card on the patient
// detail page. Patient-keyed analogue of the message-template-
// overrides panel.
//
// Layout shape mirrors the message-overrides panel:
//   * Card with a "+ Add override" affordance.
//   * Existing overrides list compactly: <alert_key> · <channel> ·
//     <state> plus the note (the "why" record).
//   * Click an override to expand into an inline editor: subject (email
//     only), body_text, body_html (email only), note. Leaving a field
//     blank inherits from the global alert message.
//   * isActive=false SUPPRESSES the alert for this patient on this
//     channel — surfaced as a "suppressed" badge.
//
// The "+ Add override" form requires alertKey + channel + note. No
// allowed-variables hint here — the API pre-flight is the source of
// truth and surfaces the allowed list in its error response.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type AlertChannel,
  type AlertMessageOverride,
  type CreateAlertOverrideBody,
  type PatchAlertOverrideBody,
  AlertOverrideError,
  createAlertOverride,
  deactivateAlertOverride,
  listAlertOverrides,
  patchAlertOverride,
} from "@/lib/admin/alert-message-overrides-api";

const CHANNELS: AlertChannel[] = ["email", "sms", "voice"];

const CHANNEL_LABEL: Record<AlertChannel, string> = {
  email: "Email",
  sms: "SMS",
  voice: "Phone call",
};

export function AlertMessageOverridesPanel({
  patientId,
}: {
  patientId: string;
}) {
  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-4"
      data-testid="alert-message-overrides-panel"
    >
      <header className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">
          Alert overrides
        </h2>
        <p className="text-xs text-slate-500">
          Per-patient customisation of alert-library messages. Each override
          inherits the not-overridden fields from the global alert; deactivating
          one suppresses that alert for this patient on that channel.
        </p>
      </header>
      <OverridesList patientId={patientId} />
      <div className="mt-4 border-t border-slate-100 pt-4">
        <NewOverrideForm patientId={patientId} />
      </div>
    </section>
  );
}

function queryKey(patientId: string) {
  return ["admin-alert-message-overrides", patientId] as const;
}

function OverridesList({ patientId }: { patientId: string }) {
  const query = useQuery({
    queryKey: queryKey(patientId),
    queryFn: () => listAlertOverrides(patientId),
  });

  if (query.isPending) {
    return <div className="text-sm text-slate-500">Loading overrides…</div>;
  }
  if (query.isError) {
    return (
      <div className="text-sm text-rose-700" role="alert">
        Couldn&apos;t load overrides:{" "}
        {query.error instanceof Error ? query.error.message : "unknown"}.
      </div>
    );
  }
  const list = query.data?.overrides ?? [];
  if (list.length === 0) {
    return (
      <div className="text-sm text-slate-500">
        No overrides for this patient — every alert uses the global message.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {list.map((o) => (
        <OverrideRow key={o.id} patientId={patientId} item={o} />
      ))}
    </ul>
  );
}

function OverrideRow({
  patientId,
  item,
}: {
  patientId: string;
  item: AlertMessageOverride;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: queryKey(patientId) });

  const patch = useMutation({
    mutationFn: (body: PatchAlertOverrideBody) =>
      patchAlertOverride(patientId, item.id, body),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });
  const deactivate = useMutation({
    mutationFn: () => deactivateAlertOverride(patientId, item.id),
    onSuccess: invalidate,
  });
  const reactivate = useMutation({
    mutationFn: () =>
      patchAlertOverride(patientId, item.id, { isActive: true }),
    onSuccess: invalidate,
  });

  if (editing) {
    return (
      <li>
        <OverrideEditor
          initial={item}
          submitting={patch.isPending}
          error={patch.error}
          onCancel={() => setEditing(false)}
          onSubmit={(body) => patch.mutate(body)}
        />
      </li>
    );
  }

  return (
    <li
      className={`rounded border border-slate-200 px-3 py-2 ${
        item.isActive ? "" : "opacity-60"
      }`}
      data-testid={`alert-override-row-${item.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs text-slate-700">
              {item.alertKey}
            </code>
            <span className="text-[11px] uppercase tracking-wider text-slate-500">
              · {CHANNEL_LABEL[item.channel]}
            </span>
            {!item.isActive && (
              <span className="text-[11px] uppercase tracking-wider text-amber-700">
                · suppressed
              </span>
            )}
          </div>
          {item.note && (
            <p className="mt-1 text-xs italic text-slate-600">{item.note}</p>
          )}
          {(item.subject || item.bodyText) && (
            <div className="mt-1.5 space-y-1 text-xs text-slate-700">
              {item.subject && (
                <div>
                  <span className="text-slate-500">Subject:</span>{" "}
                  {item.subject}
                </div>
              )}
              {item.bodyText && (
                <pre className="whitespace-pre-wrap font-sans">
                  {item.bodyText}
                </pre>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-slate-700 underline hover:text-slate-900"
          >
            Edit
          </button>
          {item.isActive ? (
            <button
              type="button"
              onClick={() => deactivate.mutate()}
              disabled={deactivate.isPending}
              className="text-xs text-rose-700 underline hover:text-rose-900 disabled:opacity-60"
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              onClick={() => reactivate.mutate()}
              disabled={reactivate.isPending}
              className="text-xs text-slate-700 underline hover:text-slate-900 disabled:opacity-60"
            >
              Reactivate
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function OverrideEditor({
  initial,
  submitting,
  error,
  onCancel,
  onSubmit,
}: {
  initial: AlertMessageOverride;
  submitting: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (body: PatchAlertOverrideBody) => void;
}) {
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [bodyText, setBodyText] = useState(initial.bodyText ?? "");
  const [bodyHtml, setBodyHtml] = useState(initial.bodyHtml ?? "");
  const [note, setNote] = useState(initial.note ?? "");

  const isEmail = initial.channel === "email";

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmedNote = note.trim();
    if (trimmedNote.length < 3) return;
    const body: PatchAlertOverrideBody = {};
    const subjectVal = isEmail ? subject || null : null;
    if (subjectVal !== initial.subject) body.subject = subjectVal;
    const bodyTextVal = bodyText || null;
    if (bodyTextVal !== initial.bodyText) body.bodyText = bodyTextVal;
    if (isEmail) {
      const bodyHtmlVal = bodyHtml || null;
      if (bodyHtmlVal !== initial.bodyHtml) body.bodyHtml = bodyHtmlVal;
    }
    if (trimmedNote !== (initial.note ?? "")) body.note = trimmedNote;
    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    onSubmit(body);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded border border-slate-300 bg-slate-50 p-3"
    >
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
        Editing override · <code>{initial.alertKey}</code> ·{" "}
        {CHANNEL_LABEL[initial.channel]}
      </div>
      {isEmail && (
        <label className="block">
          <span className="text-xs font-medium text-slate-600">
            Subject (blank = inherit global)
          </span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.currentTarget.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
      )}
      <label className="block">
        <span className="text-xs font-medium text-slate-600">
          {initial.channel === "voice" ? "Spoken transcript" : "Body text"}{" "}
          (blank = inherit global)
        </span>
        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.currentTarget.value)}
          rows={initial.channel === "sms" ? 3 : 8}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-sm"
        />
      </label>
      {isEmail && (
        <label className="block">
          <span className="text-xs font-medium text-slate-600">
            Body HTML (blank = inherit global)
          </span>
          <textarea
            value={bodyHtml}
            onChange={(e) => setBodyHtml(e.currentTarget.value)}
            rows={10}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs"
          />
        </label>
      )}
      <label className="block">
        <span className="text-xs font-medium text-slate-600">
          Note (why this override exists — required)
        </span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          required
          minLength={3}
          maxLength={2000}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>
      {renderError(error)}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-white"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function NewOverrideForm({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [alertKey, setAlertKey] = useState("");
  const [channel, setChannel] = useState<AlertChannel>("email");
  const [note, setNote] = useState("");

  const create = useMutation({
    mutationFn: (body: CreateAlertOverrideBody) =>
      createAlertOverride(patientId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(patientId) });
      setAlertKey("");
      setNote("");
      setOpen(false);
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-slate-700 underline hover:text-slate-900"
      >
        + Add override
      </button>
    );
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmedNote = note.trim();
    if (!alertKey || trimmedNote.length < 3) return;
    create.mutate({ alertKey, channel, note: trimmedNote });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-2 rounded border border-slate-300 bg-slate-50 p-3"
    >
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
        New override
      </div>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Alert key</span>
        <input
          type="text"
          value={alertKey}
          onChange={(e) => setAlertKey(e.currentTarget.value.trim())}
          required
          pattern="[a-z0-9][a-z0-9_.-]*"
          placeholder="e.g. resupply_due"
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-sm"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Channel</span>
        <select
          value={channel}
          onChange={(e) => setChannel(e.currentTarget.value as AlertChannel)}
          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">
          Note (why this patient needs an override)
        </span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          required
          minLength={3}
          maxLength={2000}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>
      {renderError(create.error)}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={create.isPending || !alertKey || note.trim().length < 3}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {create.isPending ? "Creating…" : "Create override"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-white"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function renderError(error: unknown) {
  if (!error) return null;
  if (error instanceof AlertOverrideError && error.disallowed?.length) {
    return (
      <div
        className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"
        role="alert"
      >
        Disallowed placeholders:{" "}
        {error.disallowed.map((d, i) => (
          <span key={d}>
            {i > 0 && ", "}
            <code className="rounded bg-rose-100 px-1">{`{{${d}}}`}</code>
          </span>
        ))}
        .{" "}
        {error.allowed && error.allowed.length > 0 && (
          <>
            Allowed:{" "}
            {error.allowed.map((d, i) => (
              <span key={d}>
                {i > 0 && ", "}
                <code className="rounded bg-rose-100 px-1">{`{{${d}}}`}</code>
              </span>
            ))}
            .
          </>
        )}
      </div>
    );
  }
  return (
    <div
      className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"
      role="alert"
    >
      {error instanceof Error ? error.message : "Save failed."}
    </div>
  );
}
