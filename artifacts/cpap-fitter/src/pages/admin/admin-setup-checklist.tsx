// /admin/setup — the PER-TENANT onboarding checklist.
//
// What a freshly signed-up tenant owner uses to finish standing up their
// workspace: branding, custom domain, phone / SMS / fax numbers, email
// sender, payments, team, and catalog. Each row links to the page that
// configures it and reflects LIVE status from
// /resupply-api/admin/organization/setup-checklist. Distinct from the
// platform deployment checklist (account-setup.tsx, platform super-admins).

import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  ListChecks,
} from "lucide-react";

import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  fetchTenantSetup,
  type TenantSetupItem,
  type TenantSetupResponse,
} from "@/lib/admin/tenant-setup-api";

export function AdminSetupChecklistPage() {
  const query = useQuery({
    queryKey: ["admin-tenant-setup"],
    queryFn: fetchTenantSetup,
  });

  return (
    <div className="admin-root">
      <div
        className="space-y-6 max-w-4xl"
        data-testid="admin-setup-checklist-page"
      >
        <PageHeader
          icon={ClipboardCheck}
          title="Set up your workspace"
          description="Finish configuring your account so patient messaging, email, payments, and your storefront all run under your own brand. Each step links to the page that completes it."
        />
        {query.isPending ? (
          <Spinner label="Checking your setup…" />
        ) : query.isError ? (
          <ErrorPanel
            error={query.error}
            onRetry={() => void query.refetch()}
            title="Couldn't load your setup checklist"
          />
        ) : query.data ? (
          <Body data={query.data} />
        ) : null}
      </div>
    </div>
  );
}

function Body({ data }: { data: TenantSetupResponse }) {
  const { requiredDone, requiredTotal, allRequiredDone } = data.summary;
  const pct =
    requiredTotal === 0 ? 0 : Math.round((requiredDone / requiredTotal) * 100);

  return (
    <div className="space-y-5">
      <section
        className={`rounded-xl border p-5 ${
          allRequiredDone
            ? "border-emerald-200 bg-emerald-50"
            : "border-slate-200 bg-white"
        }`}
      >
        <div className="flex items-center gap-3">
          <ListChecks
            className={allRequiredDone ? "text-emerald-600" : "text-slate-500"}
            aria-hidden
          />
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              {allRequiredDone
                ? "Core setup complete — nice work!"
                : "Finish your core setup"}
            </h2>
            <p className="text-xs text-slate-600">
              {requiredDone} of {requiredTotal} core steps done. Recommended
              steps below are optional but worth doing.
            </p>
          </div>
        </div>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              backgroundColor: allRequiredDone
                ? "rgb(16 185 129)"
                : "hsl(var(--penn-navy))",
            }}
          />
        </div>
      </section>

      <div className="space-y-6">
        {groupItems(data.items).map(({ group, items }) => (
          <section key={group}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
              {group}
            </h3>
            <ul className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
              {items.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function ItemRow({ item }: { item: TenantSetupItem }) {
  const done = item.status === "complete";
  return (
    <li className="flex gap-3 p-4">
      <div className="pt-0.5">
        {done ? (
          <CheckCircle2
            className="h-5 w-5 text-emerald-600"
            aria-label="Done"
          />
        ) : (
          <Circle
            className="h-5 w-5 text-slate-300"
            aria-label="Not done yet"
          />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-slate-900">
            {item.title}
          </span>
          <StatusPill item={item} />
        </div>
        <p className="text-xs text-slate-600">{item.description}</p>
        {item.detail && <p className="text-xs text-slate-500">{item.detail}</p>}
        {item.href && (
          <Link
            href={item.href}
            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
          >
            {done ? "Review" : "Set this up"}
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        )}
      </div>
    </li>
  );
}

function StatusPill({ item }: { item: TenantSetupItem }) {
  if (item.status === "complete") {
    return (
      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
        Done
      </span>
    );
  }
  if (item.status === "action") {
    return (
      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-800">
        To do
      </span>
    );
  }
  // incomplete
  return item.required ? (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
      Needed
    </span>
  ) : (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
      Recommended
    </span>
  );
}

function groupItems(
  items: TenantSetupItem[],
): Array<{ group: string; items: TenantSetupItem[] }> {
  const order: string[] = [];
  const map = new Map<string, TenantSetupItem[]>();
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
