import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  useGetAdminMe,
  useGetDashboardSummary,
} from "@workspace/api-client-react/admin";
import { KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { SetupProgressCard } from "@/components/admin/SetupProgressCard";
import { FitterInviteQuickSend } from "@/components/admin/FitterInviteQuickSend";
import { fetchTenantSetup } from "@/lib/admin/tenant-setup-api";
import { shouldRedirectToSetup } from "@/lib/admin/onboarding-redirect";
import { TodayWorklistSection } from "@/pages/admin/admin-today";

const ONBOARDING_REDIRECT_KEY = "cmb-onboarding-redirected";

/**
 * Whether to offer the quick fitter-invite sender at all.
 *
 * Home is the one page every staff member lands on, so an unconditional
 * action card here reaches people the action doesn't apply to:
 *
 *  - `POST /admin/fitter-invites` gates on `conversations.manage`, which
 *    the `clinician` bucket (DB role `rt`) does NOT hold — an RT would
 *    type a patient's number, press send, and get a 403.
 *  - Fitter invites live in the "Storefront & leads" nav section, gated
 *    by `module.storefront`. A tenant that switched that module off has
 *    the sidebar entry hidden and the route replaced by a "turned off"
 *    notice, so offering the same action on Home contradicts it.
 *
 * Permissions fail CLOSED (absent ⇒ hidden, matching how the sidebar
 * filters entries), while disabled features fail OPEN (absent/empty
 * means nothing is hidden — the same direction AppShell takes, so a
 * flag-table blip shows the full console rather than an empty one).
 */
export function canQuickSendFitterInvite(me: {
  permissions?: string[];
  disabledFeatures?: string[];
}): boolean {
  const permissions = me.permissions ?? [];
  const disabled = me.disabledFeatures ?? [];
  return (
    permissions.includes("conversations.manage") &&
    !disabled.includes("module.storefront")
  );
}

// Send a brand-new tenant to the guided setup checklist once, on their first
// dashboard landing of the session — so onboarding can't be silently skipped.
// Conservative + loop-proof: only fires when nothing is configured yet, and
// the once-flag is set before navigating (if it can't be persisted we bail,
// so a redirect we can't remember never loops).
function useOnboardingRedirect() {
  const [, navigate] = useLocation();
  const { data } = useQuery({
    queryKey: ["admin-tenant-setup"],
    queryFn: fetchTenantSetup,
    staleTime: 60_000,
  });

  useEffect(() => {
    let alreadyRedirected = false;
    try {
      alreadyRedirected =
        sessionStorage.getItem(ONBOARDING_REDIRECT_KEY) === "1";
    } catch {
      // sessionStorage unavailable (private mode) — handled below.
    }
    if (!shouldRedirectToSetup(data?.summary, alreadyRedirected)) return;
    try {
      sessionStorage.setItem(ONBOARDING_REDIRECT_KEY, "1");
    } catch {
      // Can't persist the once-flag → don't redirect (an unremembered
      // redirect could loop).
      return;
    }
    navigate("/admin/setup");
  }, [data, navigate]);
}

// Admin Home landing. This is the single start-of-day screen — it merges
// what used to be three overlapping surfaces (the old /admin dashboard,
// /admin/today, and /admin/work-queue) into one page:
//   1. KPI count tiles (orientation) — from /dashboard/summary, a single
//      COUNT(*)-only query, no PHI across the boundary.
//   2. Today's worklist — top items across every queue (rendered by
//      <TodayWorklistSection/>, which owns its own fetch).
//   3. Quick links — pre-filtered queue deep links.
// Plus one action, not just a view: <FitterInviteQuickSend/> sends a
// patient the AI mask-fitting link from Home, so the most-repeated staff
// task doesn't start with a navigation.
// The /admin/today and /admin/work-queue routes now redirect here.
//
// Each KPI tile is wrapped in a Link to a pre-filtered queue view —
// admins can click "Awaiting admin" and land directly on the filtered
// conversations list rather than re-typing the filter. The destination
// always honours an existing query string the page understands; if a
// page doesn't take that exact filter today, the link still navigates
// to the page so the admin can refine from there.

type KpiLink = {
  label: string;
  value: number | "—";
  hint: string;
  href: string;
  testId: string;
};

// Shown only while the workspace still looks empty (no conversations,
// episodes, fulfillments, or paused patients) — i.e. a brand-new tenant who
// hasn't done anything yet. It points straight at the three core "first
// real action" entry points so the aha-moment is one click away rather than
// buried in the nav. Disappears on its own once the tenant has any activity.
const FIRST_ACTIONS: ReadonlyArray<{
  title: string;
  blurb: string;
  href: string;
  cta: string;
}> = [
  {
    title: "Take an order",
    blurb:
      "Ring up a cash or insurance order at the front desk — no storefront setup needed.",
    href: "/admin/shop/counter-orders",
    cta: "Open the front desk",
  },
  {
    title: "Bring in your patients",
    blurb:
      "Import your roster from PacWare or any CSV (fill-only — it never overwrites).",
    href: "/admin/pacware",
    cta: "Import patients",
  },
];

function FirstActionsCard({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <section
      className="bg-white border rounded-lg p-5"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="dashboard-first-actions"
    >
      <h2
        className="text-base font-semibold mb-1"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        Get started — try your first action
      </h2>
      <p className="text-sm mb-4" style={{ color: "hsl(var(--ink-2))" }}>
        Your workspace is ready to use right now. Pick one to see the app in
        action — you can finish branding and settings later.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIRST_ACTIONS.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="block rounded-lg border p-4 transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a24a] focus-visible:ring-offset-2"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <div
              className="text-sm font-semibold"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {a.title}
            </div>
            <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-2))" }}>
              {a.blurb}
            </p>
            <span className="mt-2 inline-block text-xs font-semibold text-blue-700">
              {a.cta} →
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function DashboardPage() {
  const { data, isPending, isError, error, refetch } = useGetDashboardSummary();
  const { data: adminMe } = useGetAdminMe();
  useOnboardingRedirect();
  const showQuickSend = canQuickSendFitterInvite(adminMe ?? {});

  const kpis: KpiLink[] = [
    {
      label: "Active conversations",
      value: data?.activeConversations ?? "—",
      hint: "Open, awaiting customer, or awaiting reply",
      href: "/admin/conversations?status=open",
      testId: "kpi-active-conversations",
    },
    {
      label: "Awaiting reply",
      value: data?.awaitingAdmin ?? "—",
      hint: "Parked for a customer-service reply",
      href: "/admin/conversations?status=awaiting_admin",
      testId: "kpi-awaiting-admin",
    },
    {
      label: "Overdue episodes",
      value: data?.overdueEpisodes ?? "—",
      hint: "Past due and still awaiting action",
      href: "/admin/episodes?status=overdue",
      testId: "kpi-overdue-episodes",
    },
    {
      label: "Fulfillments this week",
      value: data?.fulfillmentsThisWeek ?? "—",
      hint: "created in last 7 days",
      href: "/admin/episodes?status=fulfilled",
      testId: "kpi-fulfillments-week",
    },
    {
      label: "Paused patients",
      value: data?.pausedPatients ?? "—",
      hint: "Currently paused",
      href: "/admin/patients?status=paused",
      testId: "kpi-paused-patients",
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Home
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Your day at a glance — live counters, today&apos;s worklist, and quick
          links into each queue.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <SetupProgressCard />

      {showQuickSend && <FitterInviteQuickSend />}

      <FirstActionsCard
        show={
          !!data &&
          !data.activeConversations &&
          !data.awaitingAdmin &&
          !data.overdueEpisodes &&
          !data.fulfillmentsThisWeek &&
          !data.pausedPatients
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((k) => (
          <Link
            key={k.testId}
            href={k.href}
            className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a24a] focus-visible:ring-offset-2 transition-shadow hover:shadow-md"
            data-testid={k.testId}
          >
            <KpiCard
              label={k.label}
              value={k.value}
              isLoading={isPending}
              hint={k.hint}
            />
          </Link>
        ))}
      </div>

      <TodayWorklistSection />

      <section
        className="bg-white border rounded-lg p-5"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <h2
          className="text-base font-semibold mb-3"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Quick links
        </h2>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <li>
            <Link
              href="/admin/conversations?status=awaiting_admin"
              className="underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Conversations awaiting admin →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/episodes?status=overdue"
              className="underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Overdue episode queue →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/patients?status=active"
              className="underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Active patients →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/shop/abandoned-carts"
              className="underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              Abandoned shop carts →
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
