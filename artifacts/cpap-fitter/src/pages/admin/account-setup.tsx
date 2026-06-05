// Settings -> Account Setup — new-account / production launch checklist.
//
// Two tabs:
//   * Required — the launch spine (core env, DB schema, first admin,
//     and the operator-run migrate / preflight / smoke-test steps).
//   * Optional — feature-gated vendor integrations that degrade
//     gracefully when unset.
//
// Auto-detected rows reflect LIVE server state (from
// /resupply-api/admin/account-setup) and refresh on reload. Rows the
// server can't introspect — the steps an operator runs by hand — come
// back with status "manual"; those are ticked off here and remembered
// in this browser via localStorage (the page is used before the DB is
// even set up, so manual ticks deliberately don't depend on a table).

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CheckSquare,
  Circle,
  ClipboardCheck,
  Copy,
  ExternalLink,
  HelpCircle,
  RefreshCw,
  Square,
} from "lucide-react";

import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  fetchAccountSetup,
  type AccountSetupItem,
  type AccountSetupResponse,
} from "@/lib/admin/account-setup-api";

const STORAGE_KEY = "pennfit.account-setup.manual.v1";

type ManualState = Record<string, boolean>;

function loadManual(): ManualState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as ManualState;
    }
    return {};
  } catch {
    return {};
  }
}

function saveManual(state: ManualState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage full / disabled — non-fatal, ticks just won't persist.
  }
}

function isComplete(item: AccountSetupItem, manual: ManualState): boolean {
  if (item.status === "manual") return Boolean(manual[item.id]);
  return item.status === "complete";
}

export function AdminAccountSetupPage() {
  const query = useQuery({
    queryKey: ["admin-account-setup"],
    queryFn: fetchAccountSetup,
  });

  const [manual, setManual] = useState<ManualState>(() => loadManual());
  const toggleManual = useCallback((id: string) => {
    setManual((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveManual(next);
      return next;
    });
  }, []);

  return (
    <div className="space-y-6 max-w-5xl" data-testid="admin-account-setup-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight flex items-center gap-2"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          <ClipboardCheck className="h-6 w-6" aria-hidden />
          Account Setup
        </h1>
        <p className="text-sm text-slate-600">
          Everything needed to stand up a fresh PennFit deployment. Required
          items check themselves off as the server detects them; operator-run
          steps are ticked here and remembered in this browser. Mirrors the
          production-launch runbook.
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Checking setup status…" />
      ) : query.isError ? (
        <ErrorPanel
          error={query.error}
          onRetry={() => void query.refetch()}
          title="Couldn't load the setup checklist"
        />
      ) : query.data ? (
        <Body
          data={query.data}
          manual={manual}
          onToggle={toggleManual}
          onRefresh={() => void query.refetch()}
          isRefreshing={query.isFetching}
        />
      ) : null}
    </div>
  );
}

function Body({
  data,
  manual,
  onToggle,
  onRefresh,
  isRefreshing,
}: {
  data: AccountSetupResponse;
  manual: ManualState;
  onToggle: (id: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  const [tab, setTab] = useState<"required" | "optional">("required");

  const required = useMemo(
    () => data.items.filter((i) => i.tab === "required"),
    [data.items],
  );
  const optional = useMemo(
    () => data.items.filter((i) => i.tab === "optional"),
    [data.items],
  );

  const requiredDone = required.filter((i) => isComplete(i, manual)).length;
  const optionalDone = optional.filter((i) => i.status === "complete").length;
  const allRequiredDone =
    required.length > 0 && requiredDone === required.length;

  const active = tab === "required" ? required : optional;

  return (
    <div className="space-y-5">
      <section
        className={`rounded-xl border p-5 ${
          allRequiredDone
            ? "border-emerald-200 bg-emerald-50"
            : "border-slate-200 bg-white"
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-slate-900">
              {allRequiredDone
                ? "All required items complete"
                : "Required setup in progress"}
            </h2>
            <p className="text-xs text-slate-600">
              {data.environment ? `Environment: ${data.environment}. ` : ""}
              Last checked {new Date(data.generatedAt).toLocaleString()}.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`}
              aria-hidden
            />
            {isRefreshing ? "Checking…" : "Re-check"}
          </button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <ProgressMeter
            label="Required"
            done={requiredDone}
            total={required.length}
            tone="navy"
          />
          <ProgressMeter
            label="Optional integrations configured"
            done={optionalDone}
            total={optional.length}
            tone="slate"
          />
        </div>
      </section>

      <div
        className="flex gap-1 border-b border-slate-200"
        role="tablist"
        aria-label="Setup checklist tabs"
      >
        <TabButton
          active={tab === "required"}
          onClick={() => setTab("required")}
        >
          Required
          <Count value={`${requiredDone}/${required.length}`} />
        </TabButton>
        <TabButton
          active={tab === "optional"}
          onClick={() => setTab("optional")}
        >
          Optional
          <Count value={`${optionalDone}/${optional.length}`} />
        </TabButton>
      </div>

      <div className="space-y-6">
        {groupItems(active).map(({ group, items }) => (
          <GroupSection
            key={group}
            group={group}
            items={items}
            manual={manual}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

function ProgressMeter({
  label,
  done,
  total,
  tone,
}: {
  label: string;
  done: number;
  total: number;
  tone: "navy" | "slate";
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const barColor =
    tone === "navy" ? "hsl(var(--penn-navy))" : "rgb(100 116 139)";
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-medium text-slate-600">{label}</span>
        <span className="text-xs font-bold tabular-nums text-slate-900">
          {done}/{total}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors ${
        active
          ? "border-current text-slate-900"
          : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
      style={active ? { color: "hsl(var(--ink-1))" } : undefined}
    >
      {children}
    </button>
  );
}

function Count({ value }: { value: string }) {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600">
      {value}
    </span>
  );
}

function GroupSection({
  group,
  items,
  manual,
  onToggle,
}: {
  group: string;
  items: AccountSetupItem[];
  manual: ManualState;
  onToggle: (id: string) => void;
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
        {group}
      </h3>
      <ul className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            checked={isComplete(item, manual)}
            onToggle={() => onToggle(item.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function ItemRow({
  item,
  checked,
  onToggle,
}: {
  item: AccountSetupItem;
  checked: boolean;
  onToggle: () => void;
}) {
  const isManual = item.status === "manual";
  return (
    <li className="flex gap-3 p-4">
      <div className="pt-0.5">
        {isManual ? (
          <ManualToggle
            checked={checked}
            onToggle={onToggle}
            label={item.title}
          />
        ) : (
          <AutoStatusIcon item={item} />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-sm font-semibold ${
              checked ? "text-slate-900" : "text-slate-900"
            }`}
          >
            {item.title}
          </span>
          <StatusPill item={item} checked={checked} />
        </div>
        <p className="text-xs text-slate-600">{item.description}</p>
        {item.detail && <p className="text-xs text-slate-500">{item.detail}</p>}
        {item.command && <CommandBlock command={item.command} />}
        {item.docHref && <DocLink href={item.docHref} />}
      </div>
    </li>
  );
}

function ManualToggle({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Mark “${label}” done`}
      onClick={onToggle}
      className="text-slate-400 hover:text-emerald-600 transition-colors"
    >
      {checked ? (
        <CheckSquare className="h-5 w-5 text-emerald-600" aria-hidden />
      ) : (
        <Square className="h-5 w-5" aria-hidden />
      )}
    </button>
  );
}

function AutoStatusIcon({ item }: { item: AccountSetupItem }) {
  if (item.status === "complete") {
    return (
      <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-label="Done" />
    );
  }
  if (item.status === "unknown") {
    return (
      <HelpCircle className="h-5 w-5 text-slate-400" aria-label="Unverified" />
    );
  }
  // incomplete
  if (item.tab === "required") {
    return (
      <AlertTriangle
        className="h-5 w-5 text-amber-500"
        aria-label="Needs setup"
      />
    );
  }
  return <Circle className="h-5 w-5 text-slate-300" aria-label="Not set up" />;
}

function StatusPill({
  item,
  checked,
}: {
  item: AccountSetupItem;
  checked: boolean;
}) {
  const { label, cls } = pillFor(item, checked);
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

function pillFor(
  item: AccountSetupItem,
  checked: boolean,
): { label: string; cls: string } {
  if (item.status === "manual") {
    return checked
      ? { label: "Done", cls: "bg-emerald-100 text-emerald-800" }
      : { label: "Action", cls: "bg-blue-100 text-blue-800" };
  }
  if (item.status === "complete") {
    return { label: "Done", cls: "bg-emerald-100 text-emerald-800" };
  }
  if (item.status === "unknown") {
    return { label: "Unverified", cls: "bg-slate-100 text-slate-600" };
  }
  // incomplete
  if (item.tab === "required") {
    return { label: "Needs setup", cls: "bg-amber-100 text-amber-800" };
  }
  return { label: "Not set up", cls: "bg-slate-100 text-slate-600" };
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [command]);

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-100 font-mono whitespace-pre">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
        aria-label="Copy command"
      >
        <Copy className="h-3 w-3" aria-hidden />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function DocLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"
    >
      <ExternalLink className="h-3 w-3" aria-hidden />
      Open runbook
    </a>
  );
}

function groupItems(
  items: AccountSetupItem[],
): Array<{ group: string; items: AccountSetupItem[] }> {
  const order: string[] = [];
  const map = new Map<string, AccountSetupItem[]>();
  for (const item of items) {
    const existing = map.get(item.group);
    if (existing) {
      existing.push(item);
    } else {
      map.set(item.group, [item]);
      order.push(item.group);
    }
  }
  return order.map((group) => ({ group, items: map.get(group) ?? [] }));
}
