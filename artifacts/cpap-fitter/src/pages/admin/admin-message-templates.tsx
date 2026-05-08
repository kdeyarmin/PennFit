// /admin/templates — admin list + edit for the customer-message
// template library (Phase 2 of docs/proposals/customer-message-
// templates.md).
//
// Layout decisions:
//   * Group rows by templateKey, so all channels for a single
//     "concept" (e.g. rx_renewal.30_day) appear together. Inside
//     a group, one row per channel.
//   * Edit is inline (toggle the row into a form) — same shape as
//     /admin/macros so admins don't context-switch UI.
//   * Subject only renders for email; body_html only renders when
//     the row has one. SMS / voice / push are body_text-only.
//   * The row's allowedVariables list shows above the editor as a
//     copy-and-click reference. Click a token to insert it at the
//     caret position of the focused textarea (small QoL).
//   * No POST or DELETE — templates are seeded by code paired with
//     each renderer migration. isActive=false is the soft-delete
//     path; we expose it as a toggle in the editor.
//
// Cache caveat shown in the header: edits propagate within ~5 min
// because the render-path's in-process LRU has a 5-min TTL. Until
// Phase 4 wires explicit invalidation, this is the user-visible
// latency floor.

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type MessageTemplate,
  type PatchTemplateBody,
  type TemplateChannel,
  TemplatePatchError,
  listTemplates,
  patchTemplate,
} from "@/lib/admin/message-templates-api";

const CHANNEL_LABEL: Record<TemplateChannel, string> = {
  email: "Email",
  sms: "SMS",
  voice: "Voice",
  push: "Push",
};

export function AdminMessageTemplatesPage() {
  return (
    <div className="space-y-6" data-testid="admin-message-templates-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Message templates
        </h1>
        <p className="text-sm text-slate-600">
          Edit the copy that customer-facing automated messages use.
          Templates support placeholders like{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            {"{{first_name}}"}
          </code>
          ; only the variables listed under each row are substituted.
          Edits take effect within 5 minutes (the render path caches
          lookups). Deactivate a row to fall back to the hard-coded
          baseline shipped with the code.
        </p>
      </header>
      <TemplateList />
    </div>
  );
}

function TemplateList() {
  const [includeInactive, setIncludeInactive] = useState(false);
  const [filterKey, setFilterKey] = useState("");

  const query = useQuery({
    queryKey: ["admin-message-templates", { includeInactive }],
    queryFn: () => listTemplates({ includeInactive }),
  });

  const grouped = useMemo(() => {
    const list = query.data?.templates ?? [];
    const filtered = filterKey
      ? list.filter((t) => t.templateKey.includes(filterKey))
      : list;
    const map = new Map<string, MessageTemplate[]>();
    for (const t of filtered) {
      const arr = map.get(t.templateKey);
      if (arr) arr.push(t);
      else map.set(t.templateKey, [t]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [query.data, filterKey]);

  if (query.isPending) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className="text-sm text-rose-700" role="alert">
        Couldn&apos;t load templates:{" "}
        {query.error instanceof Error
          ? query.error.message
          : "unknown error"}
        .
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="templates-filter-key"
            className="text-sm text-slate-700"
          >
            Filter templates
          </label>
          <input
            id="templates-filter-key"
            type="search"
            placeholder="Filter by key (e.g. rx_renewal)"
            value={filterKey}
            onChange={(e) => setFilterKey(e.currentTarget.value.trim())}
            className="rounded border border-slate-300 px-2 py-1 text-sm w-72"
            data-testid="templates-filter-key"
          />
        </div>
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.currentTarget.checked)}
            data-testid="templates-include-inactive"
          />
          Show inactive
        </label>
        <span className="text-xs text-slate-500">
          {grouped.length} template{grouped.length === 1 ? "" : "s"}
        </span>
      </div>

      {grouped.length === 0 ? (
        <div className="text-sm text-slate-500">
          No templates match. Templates are seeded by code; if the
          list is empty, the migration may not have been applied yet
          (the render path falls back to baselines in that case — see
          docs/migration-state-investigation-2026-05-08.md).
        </div>
      ) : (
        <ul className="space-y-3">
          {grouped.map(([key, rows]) => (
            <TemplateGroup key={key} templateKey={key} rows={rows} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateGroup({
  templateKey,
  rows,
}: {
  templateKey: string;
  rows: MessageTemplate[];
}) {
  return (
    <li className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 py-2">
        <code className="text-sm font-mono text-slate-900">
          {templateKey}
        </code>
        <span className="ml-2 text-xs text-slate-500">
          {rows.length} channel{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="divide-y divide-slate-100">
        {rows
          .slice()
          .sort((a, b) => a.channel.localeCompare(b.channel))
          .map((r) => (
            <TemplateRow key={r.id} item={r} />
          ))}
      </ul>
    </li>
  );
}

function TemplateRow({ item }: { item: MessageTemplate }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["admin-message-templates"] });

  const patch = useMutation({
    mutationFn: (body: PatchTemplateBody) => patchTemplate(item.id, body),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });
  const toggleActive = useMutation({
    mutationFn: () => patchTemplate(item.id, { isActive: !item.isActive }),
    onSuccess: invalidate,
  });

  if (editing) {
    return (
      <li className="px-4 py-3">
        <TemplateForm
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
      className={`px-4 py-3 ${item.isActive ? "" : "opacity-60"}`}
      data-testid={`template-row-${item.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              {CHANNEL_LABEL[item.channel]}
            </span>
            {!item.isActive && (
              <span className="text-[11px] uppercase tracking-wider text-amber-700">
                inactive · falls back to baseline
              </span>
            )}
          </div>
          {item.subject !== null && (
            <div className="mt-1 text-sm">
              <span className="text-slate-500">Subject:</span>{" "}
              <span className="text-slate-900">{item.subject}</span>
            </div>
          )}
          <pre className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700 font-sans">
            {item.bodyText}
          </pre>
          {item.allowedVariables.length > 0 && (
            <div className="mt-2 text-[11px] text-slate-500">
              Allowed variables:{" "}
              {item.allowedVariables.map((v, i) => (
                <span key={v}>
                  {i > 0 && ", "}
                  <code className="bg-slate-100 px-1 py-0.5 rounded">
                    {`{{${v}}}`}
                  </code>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-slate-700 hover:text-slate-900 underline"
            data-testid={`template-row-edit-${item.id}`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => toggleActive.mutate()}
            disabled={toggleActive.isPending}
            className="text-xs text-slate-500 hover:text-slate-700 underline disabled:opacity-60"
          >
            {item.isActive ? "Deactivate" : "Reactivate"}
          </button>
        </div>
      </div>
    </li>
  );
}

function TemplateForm({
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  initial: MessageTemplate;
  submitting: boolean;
  error: unknown;
  onSubmit: (body: PatchTemplateBody) => void;
  onCancel: () => void;
}) {
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [bodyText, setBodyText] = useState(initial.bodyText);
  const [bodyHtml, setBodyHtml] = useState(initial.bodyHtml ?? "");
  const lastFocusedRef = useRef<
    HTMLInputElement | HTMLTextAreaElement | null
  >(null);

  const isEmail = initial.channel === "email";
  const hasHtml = initial.bodyHtml !== null;

  /** Insert the token at the caret of the most-recently-focused
   *  text input, or append if nothing has focus yet. Mirrors the
   *  affordance the macros editor offers via merge tokens. */
  function insertToken(token: string): void {
    const target = lastFocusedRef.current;
    if (!target) {
      setBodyText((current) => current + token);
      return;
    }
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const next = target.value.slice(0, start) + token + target.value.slice(end);
    if (target === document.activeElement) {
      target.value = next;
    }
    if (target instanceof HTMLInputElement) {
      setSubject(next);
    } else if (target.dataset.field === "bodyText") {
      setBodyText(next);
    } else if (target.dataset.field === "bodyHtml") {
      setBodyHtml(next);
    }
    // Re-focus + position caret after the inserted token.
    requestAnimationFrame(() => {
      target.focus();
      const caret = start + token.length;
      target.setSelectionRange(caret, caret);
    });
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const body: PatchTemplateBody = {};
    const subjectVal = isEmail ? (subject || null) : null;
    if (subjectVal !== initial.subject) body.subject = subjectVal;
    if (bodyText !== initial.bodyText) body.bodyText = bodyText;
    if (hasHtml && bodyHtml !== initial.bodyHtml) {
      body.bodyHtml = bodyHtml || null;
    }
    if (Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    onSubmit(body);
  }

  const errorView = renderEditError(error);

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
        Editing {CHANNEL_LABEL[initial.channel]} ·{" "}
        <code className="text-[11px]">{initial.templateKey}</code>
      </div>

      {initial.allowedVariables.length > 0 && (
        <div className="text-[11px] text-slate-600">
          Click to insert:{" "}
          {initial.allowedVariables.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => insertToken(`{{${v}}}`)}
              className="ml-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-slate-200"
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      )}

      {isEmail && (
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.currentTarget.value)}
            onFocus={(e) => {
              lastFocusedRef.current = e.currentTarget;
            }}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            data-testid="template-edit-subject"
          />
        </label>
      )}

      <label className="block">
        <span className="text-xs font-medium text-slate-600">Body (text)</span>
        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.currentTarget.value)}
          onFocus={(e) => {
            lastFocusedRef.current = e.currentTarget;
          }}
          data-field="bodyText"
          rows={initial.channel === "sms" ? 3 : 8}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
          data-testid="template-edit-body-text"
          required
        />
      </label>

      {hasHtml && (
        <label className="block">
          <span className="text-xs font-medium text-slate-600">
            Body (HTML)
          </span>
          <textarea
            value={bodyHtml}
            onChange={(e) => setBodyHtml(e.currentTarget.value)}
            onFocus={(e) => {
              lastFocusedRef.current = e.currentTarget;
            }}
            data-field="bodyHtml"
            rows={12}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-xs font-mono"
            data-testid="template-edit-body-html"
          />
        </label>
      )}

      {errorView}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
          data-testid="template-edit-save"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function renderEditError(error: unknown) {
  if (!error) return null;
  if (error instanceof TemplatePatchError && error.disallowed) {
    return (
      <div
        className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800"
        role="alert"
      >
        These placeholders aren&apos;t in this template&apos;s allowedVariables:{" "}
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
