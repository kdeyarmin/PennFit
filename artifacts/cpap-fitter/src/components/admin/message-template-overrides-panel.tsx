// Per-customer message-template overrides — embedded card on the
// customer-360 page (Phase 3 of docs/proposals/customer-message-
// templates.md).
//
// Layout shape:
//   * Card with a "+ New override" affordance.
//   * Existing overrides list compactly: <key> · <channel> · <state>
//     plus the note (always shown — that's the "why" record).
//   * Click an override to expand into an inline editor: subject (if
//     channel=email), body_text, body_html (if email), isActive
//     toggle, note. Same Save/Cancel flow as the global library.
//   * The "+ New override" form requires templateKey + channel + note.
//     No allowed-variables hint here because the form doesn't have
//     access to the global template's allowedVariables; the API
//     pre-flight check is the source of truth and surfaces the
//     allowed list in its error response.
//
// PHI posture matches the API: notes can mention WHY the override
// exists (e.g. "patient asked for email-only after 2026-04 SMS
// opt-out") but never patient PHI; templates contain content with
// {{var}} placeholders that resolve at send time.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { TemplatePatchError } from "@/lib/admin/message-templates-api";
import {
  type CreateOverrideBody,
  type MessageTemplateOverride,
  type PatchOverrideBody,
  type TemplateChannel,
  createOverride,
  deactivateOverride,
  listOverrides,
  patchOverride,
} from "@/lib/admin/message-template-overrides-api";

const CHANNELS: TemplateChannel[] = ["email", "sms", "voice", "push"];

const CHANNEL_LABEL: Record<TemplateChannel, string> = {
  email: "Email",
  sms: "SMS",
  voice: "Voice",
  push: "Push",
};

export function MessageTemplateOverridesPanel({
  userId,
}: {
  userId: string;
}) {
  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-4"
      data-testid="message-template-overrides-panel"
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Message overrides
          </h2>
          <p className="text-xs text-slate-500">
            Per-customer customisation of automated messages. Inherits
            from the global library; this lists only deviations.
          </p>
        </div>
      </header>
      <OverridesList userId={userId} />
      <div className="mt-4 border-t border-slate-100 pt-4">
        <NewOverrideForm userId={userId} />
      </div>
    </section>
  );
}

function OverridesList({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: ["admin-message-template-overrides", userId],
    queryFn: () => listOverrides(userId),
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
        No overrides for this customer — every automated message uses the
        global template.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {list.map((o) => (
        <OverrideRow key={o.id} userId={userId} item={o} />
      ))}
    </ul>
  );
}

function OverrideRow({
  userId,
  item,
}: {
  userId: string;
  item: MessageTemplateOverride;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: ["admin-message-template-overrides", userId],
    });

  const patch = useMutation({
    mutationFn: (body: PatchOverrideBody) =>
      patchOverride(userId, item.id, body),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });
  const deactivate = useMutation({
    mutationFn: () => deactivateOverride(userId, item.id),
    onSuccess: invalidate,
  });
  const reactivate = useMutation({
    mutationFn: () => patchOverride(userId, item.id, { isActive: true }),
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
      data-testid={`override-row-${item.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs font-mono text-slate-700">
              {item.templateKey}
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
            <p className="mt-1 text-xs italic text-slate-600">
              {item.note}
            </p>
          )}
          {(item.subject ||
            item.bodyText ||
            item.bodyHtml) && (
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
        <div className="flex flex-col gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-slate-700 hover:text-slate-900 underline"
          >
            Edit
          </button>
          {item.isActive ? (
            <button
              type="button"
              onClick={() => deactivate.mutate()}
              disabled={deactivate.isPending}
              className="text-xs text-rose-700 hover:text-rose-900 underline disabled:opacity-60"
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              onClick={() => reactivate.mutate()}
              disabled={reactivate.isPending}
              className="text-xs text-slate-700 hover:text-slate-900 underline disabled:opacity-60"
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
  initial: MessageTemplateOverride;
  submitting: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (body: PatchOverrideBody) => void;
}) {
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [bodyText, setBodyText] = useState(initial.bodyText ?? "");
  const [bodyHtml, setBodyHtml] = useState(initial.bodyHtml ?? "");
  const [note, setNote] = useState(initial.note ?? "");

  const isEmail = initial.channel === "email";

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const body: PatchOverrideBody = {};
    const subjectVal = isEmail ? (subject || null) : null;
    if (subjectVal !== initial.subject) body.subject = subjectVal;
    const bodyTextVal = bodyText || null;
    if (bodyTextVal !== initial.bodyText) body.bodyText = bodyTextVal;
    if (isEmail) {
      const bodyHtmlVal = bodyHtml || null;
      if (bodyHtmlVal !== initial.bodyHtml) body.bodyHtml = bodyHtmlVal;
    }
    if (note !== (initial.note ?? "")) body.note = note;
    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    onSubmit(body);
  }

  const errorView = renderError(error);

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded border border-slate-300 bg-slate-50 p-3 space-y-3"
    >
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
        Editing override · <code>{initial.templateKey}</code> ·{" "}
        {CHANNEL_LABEL[initial.channel]}
      </div>
      {isEmail && (
        <label className="block">
          <span className="text-xs font-medium text-slate-600">
            Subject (leave blank to inherit from global)
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
          Body text (leave blank to inherit from global)
        </span>
        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.currentTarget.value)}
          rows={initial.channel === "sms" ? 3 : 8}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
        />
      </label>
      {isEmail && (
        <label className="block">
          <span className="text-xs font-medium text-slate-600">
            Body HTML (leave blank to inherit from global)
          </span>
          <textarea
            value={bodyHtml}
            onChange={(e) => setBodyHtml(e.currentTarget.value)}
            rows={10}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-xs font-mono"
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
      {errorView}
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

function NewOverrideForm({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [templateKey, setTemplateKey] = useState("");
  const [channel, setChannel] = useState<TemplateChannel>("email");
  const [note, setNote] = useState("");

  const create = useMutation({
    mutationFn: (body: CreateOverrideBody) => createOverride(userId, body),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["admin-message-template-overrides", userId],
      });
      setTemplateKey("");
      setNote("");
      setOpen(false);
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-slate-700 hover:text-slate-900 underline"
      >
        + Add override
      </button>
    );
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!templateKey || !note) return;
    create.mutate({
      templateKey,
      channel,
      note,
      // Subject + body fields stay null on create — admin edits
      // them in the inline editor after the row exists. This
      // matches the "create the override, then customise" flow
      // and keeps this form tight.
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded border border-slate-300 bg-slate-50 p-3 space-y-2"
    >
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
        New override
      </div>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Template key</span>
        <input
          type="text"
          value={templateKey}
          onChange={(e) => setTemplateKey(e.currentTarget.value.trim())}
          required
          pattern="[a-z0-9][a-z0-9_.-]*"
          placeholder="e.g. rx_renewal.30_day"
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Channel</span>
        <select
          value={channel}
          onChange={(e) =>
            setChannel(e.currentTarget.value as TemplateChannel)
          }
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm bg-white"
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
          Note (why this customer needs an override)
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
          disabled={create.isPending || !templateKey || note.length < 3}
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
  if (error instanceof TemplatePatchError && error.disallowed) {
    return (
      <div
        className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"
        role="alert"
      >
        Disallowed placeholders:{" "}
        {error.disallowed.map((d, i) => (
          <span key={d}>
            {i > 0 && ", "}
            <code className="bg-rose-100 px-1 rounded">{`{{${d}}}`}</code>
          </span>
        ))}
        .{" "}
        {error.allowed && error.allowed.length > 0 && (
          <>
            Allowed:{" "}
            {error.allowed.map((d, i) => (
              <span key={d}>
                {i > 0 && ", "}
                <code className="bg-rose-100 px-1 rounded">{`{{${d}}}`}</code>
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
