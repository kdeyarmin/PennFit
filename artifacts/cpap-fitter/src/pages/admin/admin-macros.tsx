// /admin/macros — admin CRUD for the canned-reply library used by the
// reply composer.
//
// Layout: simple list of macros + an inline "New macro" card at the
// top. Each row has Edit / Disable buttons; editing toggles the row
// into an inline form. We deliberately keep the UI tight (no drag-
// to-reorder, no preview pane) — the audience is < 10 ops users and
// the table will rarely exceed 50 rows.
//
// Inactive rows surface in a separate section so admins can resurrect
// disabled macros without including them in the picker.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CsrMacro,
  type MacroChannel,
  createMacro,
  deleteMacro,
  listMacros,
  patchMacro,
} from "@/lib/admin/csr-macros-api";

const MERGE_TOKENS = [
  "{{patient.firstName}}",
  "{{patient.lastName}}",
  "{{patient.fullName}}",
  "{{episode.dueDate}}",
  "{{episode.itemsList}}",
  "{{rep.firstName}}",
  "{{date.today}}",
  "{{date.tomorrow}}",
];

export function AdminMacrosPage() {
  return (
    <div className="space-y-6" data-testid="admin-macros-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Canned replies
        </h1>
        <p className="text-sm text-slate-600">
          Edit the picker that powers the in-thread reply composer. Bodies
          support merge tokens like{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            {"{{patient.firstName}}"}
          </code>
          ; tokens are substituted client-side at insert time.
        </p>
      </header>
      <NewMacroCard />
      <MacroList />
    </div>
  );
}

function MacroList() {
  const query = useQuery({
    queryKey: ["admin-csr-macros"],
    queryFn: () => listMacros({ includeInactive: true }),
  });

  const { active, inactive } = useMemo(() => {
    const list = query.data?.macros ?? [];
    return {
      active: list.filter((m) => m.isActive),
      inactive: list.filter((m) => !m.isActive),
    };
  }, [query.data]);

  if (query.isPending) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className="text-sm text-rose-700" role="alert">
        Couldn&apos;t load macros:{" "}
        {query.error instanceof Error ? query.error.message : "unknown error"}.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Section title="Active" rows={active} emptyText="No active macros." />
      {inactive.length > 0 && (
        <Section title="Disabled" rows={inactive} emptyText="" subtle />
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  emptyText,
  subtle,
}: {
  title: string;
  rows: CsrMacro[];
  emptyText: string;
  subtle?: boolean;
}) {
  return (
    <section>
      <h2
        className={`text-sm font-semibold uppercase tracking-wider mb-2 ${
          subtle ? "text-slate-400" : "text-slate-600"
        }`}
      >
        {title}
      </h2>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-500">{emptyText}</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <MacroRow key={m.id} item={m} subtle={subtle} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MacroRow({ item, subtle }: { item: CsrMacro; subtle?: boolean }) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["admin-csr-macros"] });
  const [editing, setEditing] = useState(false);

  const patch = useMutation({
    mutationFn: (body: Parameters<typeof patchMacro>[1]) =>
      patchMacro(item.id, body),
    onSuccess: () => {
      void invalidate();
      setEditing(false);
    },
  });
  const del = useMutation({
    mutationFn: () => deleteMacro(item.id),
    onSuccess: invalidate,
  });
  const reactivate = useMutation({
    mutationFn: () => patchMacro(item.id, { isActive: true }),
    onSuccess: invalidate,
  });

  if (editing) {
    return (
      <li>
        <MacroForm
          initial={item}
          submitLabel="Save"
          onSubmit={(body) => patch.mutate(body)}
          onCancel={() => setEditing(false)}
          submitting={patch.isPending}
          error={patch.error instanceof Error ? patch.error.message : null}
        />
      </li>
    );
  }

  return (
    <li
      className={`rounded-lg border bg-white p-3 ${
        subtle ? "border-slate-200 opacity-70" : "border-slate-200"
      }`}
      data-testid={`macro-row-${item.key}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-900">
              {item.label}
            </span>
            <code className="text-[11px] text-slate-500 bg-slate-100 px-1 py-0.5 rounded">
              {item.key}
            </code>
            {item.category && (
              <span className="text-[11px] text-slate-500">
                · {item.category}
              </span>
            )}
            <span className="text-[11px] text-slate-500">
              · {item.channels.join(", ")}
            </span>
          </div>
          <pre className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700">
            {item.body}
          </pre>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          {item.isActive ? (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => del.mutate()}
                disabled={del.isPending}
                className="rounded border border-rose-300 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60"
              >
                {del.isPending ? "Disabling…" : "Disable"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => reactivate.mutate()}
              disabled={reactivate.isPending}
              className="rounded border border-emerald-300 px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
            >
              {reactivate.isPending ? "Restoring…" : "Restore"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function NewMacroCard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const create = useMutation({
    mutationFn: (body: Parameters<typeof createMacro>[0]) => createMacro(body),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["admin-csr-macros"] });
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border-2 border-dashed border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        data-testid="macro-new-open"
      >
        + New macro
      </button>
    );
  }

  return (
    <MacroForm
      initial={null}
      submitLabel="Create"
      onSubmit={(body) =>
        create.mutate({
          key: body.key ?? "",
          label: body.label ?? "",
          category: body.category ?? null,
          body: body.body ?? "",
          channels: body.channels ?? ["sms", "email"],
          sortOrder: body.sortOrder ?? 100,
        })
      }
      onCancel={() => setOpen(false)}
      submitting={create.isPending}
      error={create.error instanceof Error ? create.error.message : null}
    />
  );
}

function MacroForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  submitting,
  error,
}: {
  initial: CsrMacro | null;
  submitLabel: string;
  onSubmit: (body: {
    key?: string;
    label?: string;
    category?: string | null;
    body?: string;
    channels?: MacroChannel[];
    sortOrder?: number;
  }) => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const [key, setKey] = useState(initial?.key ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [smsChecked, setSmsChecked] = useState(
    initial ? initial.channels.includes("sms") : true,
  );
  const [emailChecked, setEmailChecked] = useState(
    initial ? initial.channels.includes("email") : true,
  );
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 100);

  const channels = [
    smsChecked ? "sms" : null,
    emailChecked ? "email" : null,
  ].filter((c): c is MacroChannel => c !== null);

  const isNew = initial === null;

  function insertToken(tok: string) {
    setBody(
      (prev) =>
        `${prev}${prev.endsWith(" ") || prev.length === 0 ? "" : " "}${tok}`,
    );
  }

  return (
    <div className="rounded-lg border border-slate-300 bg-white p-4 space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Key (slug)
          </label>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={!isNew}
            aria-label="Key (slug)"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono disabled:bg-slate-50"
            placeholder="confirm-order"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Label
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Label"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Confirm — order placed"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Category (optional)
          </label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Category"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            placeholder="Shipping"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Sort order
          </label>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
            aria-label="Sort order"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-semibold text-slate-600 block mb-1">
          Channels
        </label>
        <div className="flex gap-3 text-sm">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={smsChecked}
              onChange={(e) => setSmsChecked(e.target.checked)}
            />
            SMS
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={emailChecked}
              onChange={(e) => setEmailChecked(e.target.checked)}
            />
            Email
          </label>
        </div>
      </div>
      <div>
        <label className="text-xs font-semibold text-slate-600 block mb-1">
          Body
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 4000))}
          rows={5}
          aria-label="Body"
          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
          placeholder="Hi {{patient.firstName}}, …"
        />
        <div className="text-[10px] text-slate-500 text-right">
          {body.length} / 4000
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {MERGE_TOKENS.map((tok) => (
            <button
              key={tok}
              type="button"
              onClick={() => insertToken(tok)}
              className="text-[11px] font-mono rounded bg-slate-100 px-2 py-0.5 hover:bg-slate-200"
            >
              {tok}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <div className="text-xs text-rose-700" role="alert">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="text-xs font-medium px-3 py-1.5 rounded text-slate-600 hover:text-slate-900"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (channels.length === 0) return;
            const payload: Parameters<typeof onSubmit>[0] = {
              label,
              category: category || null,
              body,
              channels,
              sortOrder,
            };
            if (isNew) payload.key = key;
            onSubmit(payload);
          }}
          disabled={
            submitting ||
            !label ||
            !body ||
            channels.length === 0 ||
            (isNew && !key)
          }
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}
