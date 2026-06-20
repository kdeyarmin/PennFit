// Dashboard "Finish setting up your workspace" card.
//
// A first-run nudge that pulls a new tenant through the onboarding
// checklist (/admin/setup) instead of dropping them on an empty dashboard
// with no next step. Fetches the per-tenant setup status and renders ONLY
// when core setup is incomplete — once everything required is done it
// disappears, so it never nags an established tenant. Fails silent: a load
// error or pending state renders nothing (the dashboard must not depend on
// it).

import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ListChecks } from "lucide-react";

import { fetchTenantSetup } from "@/lib/admin/tenant-setup-api";

export function SetupProgressCard() {
  const { data, isError } = useQuery({
    queryKey: ["admin-tenant-setup"],
    queryFn: fetchTenantSetup,
    staleTime: 60_000,
  });

  // Render nothing while loading, on error, or once core setup is done.
  if (isError || !data) return null;
  if (data.summary.allRequiredDone) return null;

  const { requiredDone, requiredTotal } = data.summary;
  const pct =
    requiredTotal === 0 ? 0 : Math.round((requiredDone / requiredTotal) * 100);
  // Surface the next few unfinished core steps as a teaser.
  const nextUp = data.items
    .filter((i) => i.required && i.status !== "complete")
    .slice(0, 3);

  return (
    <section
      className="rounded-xl border border-amber-200 bg-amber-50 p-5"
      data-testid="setup-progress-card"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <ListChecks className="h-5 w-5 text-amber-600 mt-0.5" aria-hidden />
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Finish setting up your workspace
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              {requiredDone} of {requiredTotal} core steps done. Configure your
              brand, numbers, email sender, and payments so everything runs
              under your own identity.
            </p>
          </div>
        </div>
        <Link
          href="/admin/setup"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
        >
          Go to setup
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-amber-200">
        <div
          className="h-full rounded-full bg-amber-600 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      {nextUp.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {nextUp.map((i) => (
            <li key={i.id}>
              <Link
                href={i.href ?? "/admin/setup"}
                className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
              >
                {i.title}
                <ArrowRight className="h-3 w-3" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
