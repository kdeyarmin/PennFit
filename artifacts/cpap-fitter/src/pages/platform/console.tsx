// Platform super-admin console (G4).
//
// The cross-tenant operator surface — distinct from the per-tenant admin
// console at /admin/*. A PLATFORM admin (membership in
// `resupply.platform_admins`) manages the platform itself: the tenant
// directory, tenant lifecycle (create / suspend / reactivate), per-tenant
// usage, and act-as-tenant impersonation for support.
//
// Routing layers mirror the admin console (console.tsx):
//   1. /platform/* funnels here from App.tsx.
//   2. <PlatformConsoleRoute> probes /resupply-api/auth/me (session);
//      redirects signed-out users to /admin/sign-in (platform admins are
//      auth users — they sign in through the same in-house auth).
//   3. <PlatformConsole> probes /resupply-api/platform/me; renders the
//      "not authorized" screen on 4xx, the console on success.
//
// Theme: the platform console reuses the admin design tokens, so it imports
// admin.css and wraps everything in `.admin-root` (hard rule R7 — admin
// tokens must stay scoped under that class).

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Redirect, Route, Switch, useLocation, useRoute } from "wouter";
import {
  Activity,
  Building2,
  CreditCard,
  ExternalLink,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  Menu,
  Plug,
  Rocket,
  Search,
  ServerCog,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  ApiError,
  getListTenantsQueryKey,
  getTenantFeatureFlagsQueryKey,
  getTenantQueryKey,
  useGetPlatformMe,
  useGetTenant,
  useListTenants,
  useCreateTenant,
  useSuspendTenant,
  useReactivateTenant,
  useImpersonateTenant,
  useTenantUsage,
  useTenantActivitySeries,
  useTenantFeatureFlags,
  useTenantFeatureFlagActivity,
  useToggleTenantFeatureFlag,
  type PlatformTenant,
  type TenantFeatureFlag,
} from "@workspace/api-client-react/admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AdminModal } from "@/components/admin/AdminModal";
import { CopyableId } from "@/components/admin/CopyableId";

import {
  clearPlatformConfig,
  fetchPlatformConfig,
  setPlatformConfig,
  type PlatformConfigSetting,
} from "@/lib/admin/platform-config-api";
import {
  fetchPlatformAnalytics,
  type PlatformAnalyticsResponse,
  type PlatformAnalyticsTenantRow,
} from "@/lib/admin/platform-analytics-api";
import {
  fetchFleetBillingSummary,
  fetchPlatformTenantBilling,
  formatMoney,
} from "@/lib/admin/platform-billing-api";
import {
  getPlatformSupportTicket,
  listPlatformSupportTickets,
  replyPlatformSupportTicket,
  setPlatformSupportStatus,
  statusLabel as supportStatusLabel,
  statusVariant as supportStatusVariant,
  type SupportMessage,
  type SupportTicket,
  type SupportTicketStatus,
} from "@/lib/admin/support-api";
import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card, KpiCard } from "@/components/admin/Card";
import { ConnectionTests } from "@/components/admin/ConnectionTests";
import { EmptyState } from "@/components/admin/EmptyState";
import { Input, Label } from "@/components/admin/Input";
import { PageHeader } from "@/components/admin/PageHeader";
import { Sparkline } from "@/components/admin/Sparkline";
import { Spinner } from "@/components/admin/Spinner";
import { Table, type Column } from "@/components/admin/Table";
import { authHooks } from "@/lib/admin/auth-hooks";
import { useDashboardIdentity } from "@/lib/admin/identity";
import { NotAuthorizedPage } from "@/pages/admin/not-authorized";
import { PlatformOutreachPage } from "@/pages/platform/outreach";
import { AdminPlatformBillingPage } from "@/pages/admin/admin-platform-billing";
import { AdminAccountSetupPage } from "@/pages/admin/account-setup";
import { PlatformSystemInfoPage } from "@/pages/admin/admin-settings";

// admin.css ships the design tokens (--penn-navy, --ink-*, --surface-*)
// the platform console reuses. Imported here so the styles ride the lazy
// platform chunk and don't bloat the storefront bundle (same pattern as
// the admin console barrel).
import "@/admin.css";

// Mirrors the DB CHECK `organizations_slug_format` and the server's
// createTenantBody Zod (tenants.ts): a URL-safe lowercase label.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function statusVariant(
  status: string,
): "success" | "danger" | "muted" | "neutral" {
  switch (status) {
    case "active":
      return "success";
    case "suspended":
      return "danger";
    case "archived":
      return "muted";
    default:
      return "neutral";
  }
}

// ── Confirmation dialog ────────────────────────────────────────────
// A shared guard for the platform's consequential actions. Suspending a
// tenant takes its custom domain offline and stops its crons;
// impersonation swaps the operator's session for an act-as-tenant one
// and navigates away — neither should fire on a stray click. Built on
// the shared AdminModal (Radix: Escape, focus-trap, scroll-lock).

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  intent = "primary",
  isPending,
  error,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  intent?: "primary" | "secondary";
  isPending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AdminModal title={title} onClose={onClose} className="max-w-md">
      <div className="space-y-4">
        <div
          className="text-sm leading-relaxed"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          {body}
        </div>
        {error && (
          <p className="text-xs" style={{ color: "hsl(354 75% 38%)" }}>
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            intent="ghost"
            size="sm"
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            intent={intent}
            size="sm"
            isLoading={isPending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </AdminModal>
  );
}

// A compact segmented control (shared by the tenant status filter). The
// active segment fills navy; the rest are quiet.
function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="inline-flex rounded-md overflow-hidden border"
      style={{ borderColor: "hsl(var(--line-1))" }}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className="px-3 py-1.5 text-xs font-medium whitespace-nowrap"
            style={{
              color: active ? "hsl(var(--surface-1))" : "hsl(var(--ink-2))",
              backgroundColor: active ? "hsl(var(--penn-navy))" : "transparent",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Create-tenant card ─────────────────────────────────────────────

function CreateTenantCard() {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const create = useCreateTenant();

  const slugValid = slug.length > 0 && slug.length <= 63 && SLUG_RE.test(slug);
  const canSubmit = slugValid && name.trim().length > 0 && !create.isPending;

  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 409) return "That slug is already taken.";
      const data = err.data as { error?: string } | undefined;
      if (data?.error === "invalid_tenant")
        return "Slug or name didn't pass validation.";
    }
    return "Couldn't create the tenant. Try again.";
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setNotice(null);
    create.mutate(
      { slug, name: name.trim() },
      {
        onSuccess: (res) => {
          setSlug("");
          setName("");
          setNotice(
            `Created “${res.tenant.slug}” (${res.flagsProvisioned} feature flags provisioned). Invite its first owner with the tenant:onboard CLI.`,
          );
          void queryClient.invalidateQueries({
            queryKey: getListTenantsQueryKey(),
          });
        },
      },
    );
  }

  return (
    <Card
      title="Create a tenant"
      subtitle="Creates the organization shell + its feature-flag catalog. Invite the tenant's first owner separately with the tenant:onboard CLI."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="tenant-slug">Slug</Label>
            <Input
              id="tenant-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="acme-sleep"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={slug.length > 0 && !slugValid}
            />
            <p className="text-xs mt-1" style={{ color: "hsl(var(--ink-3))" }}>
              Lowercase letters, digits, hyphens. Used in URLs.
            </p>
          </div>
          <div>
            <Label htmlFor="tenant-name">Name</Label>
            <Input
              id="tenant-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Sleep Supply"
            />
          </div>
        </div>
        {notice && (
          <p className="text-xs" style={{ color: "hsl(152 70% 24%)" }}>
            {notice}
          </p>
        )}
        {create.isError && (
          <p className="text-xs" style={{ color: "hsl(354 75% 38%)" }}>
            {errorMessage(create.error)}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={!canSubmit}
            isLoading={create.isPending}
          >
            Create tenant
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── Tenant directory ───────────────────────────────────────────────

function TenantDirectory() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, refetch } = useListTenants();
  const suspend = useSuspendTenant();
  const reactivate = useReactivateTenant();
  const impersonate = useImpersonateTenant();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  // The consequential actions (suspend / impersonate) go through a
  // confirmation step; reactivate is restorative and stays inline.
  const [confirm, setConfirm] = useState<{
    kind: "suspend" | "impersonate";
    tenant: PlatformTenant;
  } | null>(null);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
  }

  function runSuspend(t: PlatformTenant) {
    setActionError(null);
    setBusyId(t.id);
    suspend.mutate(t.id, {
      onSuccess: () => {
        invalidate();
        setConfirm(null);
      },
      onError: (err) => {
        setActionError(
          err instanceof ApiError && err.status === 400
            ? "The seed tenant can't be suspended."
            : "Couldn't suspend that tenant.",
        );
        setConfirm(null);
      },
      onSettled: () => setBusyId(null),
    });
  }

  function onReactivate(t: PlatformTenant) {
    setActionError(null);
    setBusyId(t.id);
    reactivate.mutate(t.id, {
      onSuccess: invalidate,
      onError: () => setActionError("Couldn't reactivate that tenant."),
      onSettled: () => setBusyId(null),
    });
  }

  function runImpersonate(t: PlatformTenant) {
    setActionError(null);
    setBusyId(t.id);
    impersonate.mutate(t.id, {
      onSuccess: () => {
        // The impersonate endpoint replaced the session cookie with an
        // act-as-tenant session. A full navigation to /admin re-reads the
        // new cookie and refetches every query under the target org.
        window.location.assign("/admin");
      },
      onError: () => {
        setActionError("Couldn't start impersonation.");
        setConfirm(null);
        setBusyId(null);
      },
    });
  }

  const allTenants = useMemo(() => data?.tenants ?? [], [data]);
  const counts = useMemo(() => {
    const c = { all: allTenants.length, active: 0, suspended: 0, archived: 0 };
    for (const t of allTenants) {
      if (t.status === "active") c.active += 1;
      else if (t.status === "suspended") c.suspended += 1;
      else if (t.status === "archived") c.archived += 1;
    }
    return c;
  }, [allTenants]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allTenants.filter((t) => {
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (!q) return true;
      return (
        t.slug.toLowerCase().includes(q) ||
        (t.name ?? "").toLowerCase().includes(q) ||
        (t.customDomain ?? "").toLowerCase().includes(q)
      );
    });
  }, [allTenants, query, statusFilter]);

  const columns = useMemo<Column<PlatformTenant>[]>(
    () => [
      {
        key: "name",
        header: "Tenant",
        render: (t) => (
          <Link href={`/platform/tenants/${t.id}`} className="block group">
            <div
              className="font-medium group-hover:underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {t.name ?? t.slug}
            </div>
            <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {t.slug}
            </div>
          </Link>
        ),
      },
      {
        key: "domain",
        header: "Custom domain",
        render: (t) =>
          t.customDomain ? (
            <span className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
              {t.customDomain}
              {t.customDomainStatus && t.customDomainStatus !== "active" ? (
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  {" "}
                  ({t.customDomainStatus})
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              —
            </span>
          ),
      },
      {
        key: "status",
        header: "Status",
        render: (t) => (
          <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
        ),
      },
      {
        key: "created",
        header: "Created",
        render: (t) => (
          <span
            className="text-xs tabular-nums"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {new Date(t.createdAt).toLocaleDateString()}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        className: "text-right",
        render: (t) => {
          const busy = busyId === t.id;
          return (
            <div className="flex items-center justify-end gap-2">
              <Link href={`/platform/tenants/${t.id}`}>
                <Button intent="ghost" size="sm">
                  View
                </Button>
              </Link>
              <Button
                intent="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setConfirm({ kind: "impersonate", tenant: t })}
              >
                Impersonate
              </Button>
              {t.status === "suspended" ? (
                <Button
                  intent="ghost"
                  size="sm"
                  disabled={busy}
                  isLoading={busy && reactivate.isPending}
                  onClick={() => onReactivate(t)}
                >
                  Reactivate
                </Button>
              ) : (
                <Button
                  intent="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: "suspend", tenant: t })}
                >
                  Suspend
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId, reactivate.isPending],
  );

  const statusOptions = useMemo(
    () => [
      { value: "all", label: `All ${counts.all}` },
      { value: "active", label: `Active ${counts.active}` },
      { value: "suspended", label: `Suspended ${counts.suspended}` },
      ...(counts.archived
        ? [{ value: "archived", label: `Archived ${counts.archived}` }]
        : []),
    ],
    [counts],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenants"
        description="Every organization on the platform. Search, drill into a tenant, or operate one as support."
      />
      <CreateTenantCard />
      <Card
        title="Directory"
        subtitle={
          isPending
            ? undefined
            : `${counts.active} active · ${counts.suspended} suspended` +
              (counts.archived ? ` · ${counts.archived} archived` : "")
        }
        action={
          !isPending && !isError ? (
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <Segmented
                ariaLabel="Filter by status"
                value={statusFilter}
                onChange={setStatusFilter}
                options={statusOptions}
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, slug, domain…"
                className="w-44"
                aria-label="Search tenants"
              />
            </div>
          ) : undefined
        }
      >
        {actionError && (
          <p className="text-xs mb-3" style={{ color: "hsl(354 75% 38%)" }}>
            {actionError}
          </p>
        )}
        {isPending ? (
          <Spinner label="Loading tenants…" />
        ) : isError ? (
          <EmptyState
            title="Couldn't load tenants."
            hint="A transient error — try again."
            action={
              <Button
                intent="secondary"
                size="sm"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <Table<PlatformTenant>
            columns={columns}
            rows={filtered}
            rowKey={(t) => t.id}
            emptyState={
              <EmptyState
                title={
                  allTenants.length === 0
                    ? "No tenants yet."
                    : "No tenants match your filters."
                }
                hint={
                  allTenants.length === 0
                    ? "Create the first tenant above."
                    : "Clear the search or status filter."
                }
              />
            }
          />
        )}
      </Card>

      {confirm?.kind === "suspend" && (
        <ConfirmDialog
          title="Suspend tenant?"
          confirmLabel="Suspend"
          intent="secondary"
          isPending={busyId === confirm.tenant.id && suspend.isPending}
          body={
            <>
              <strong style={{ color: "hsl(var(--ink-1))" }}>
                {confirm.tenant.name ?? confirm.tenant.slug}
              </strong>{" "}
              will go offline: its custom domain stops resolving (it falls back
              to the platform site) and its background jobs pause. You can
              reactivate it at any time.
            </>
          }
          onConfirm={() => runSuspend(confirm.tenant)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "impersonate" && (
        <ConfirmDialog
          title="Operate as this tenant?"
          confirmLabel="Start impersonation"
          isPending={busyId === confirm.tenant.id && impersonate.isPending}
          body={
            <>
              You&rsquo;ll get a short-lived, audited act-as-tenant session for{" "}
              <strong style={{ color: "hsl(var(--ink-1))" }}>
                {confirm.tenant.name ?? confirm.tenant.slug}
              </strong>{" "}
              and be taken to its admin console. Every action is attributed to
              you. End it from the admin console when you&rsquo;re done.
            </>
          }
          onConfirm={() => runImpersonate(confirm.tenant)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ── Analytics dashboard (cross-tenant aggregates — no PHI) ──────────

function fmtCount(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString();
}

function fmtUsd(cents: number | null | undefined, decimals = 0): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

const WINDOW_OPTIONS = [7, 30, 90] as const;

// Period-over-period change chip. A null delta ("no prior baseline") is
// rendered as muted text rather than a fabricated +100%.
function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct == null) {
    return (
      <span className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
        no prior data
      </span>
    );
  }
  const up = pct >= 0;
  const color = up ? "hsl(152 60% 30%)" : "hsl(354 70% 42%)";
  return (
    <span
      className="text-[11px] font-semibold tabular-nums"
      style={{ color }}
      title="vs. the previous equal-length period"
    >
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

// One labelled trend line: headline total + delta on the left, a
// dependency-free SVG sparkline on the right.
function TrendRow({
  label,
  total,
  values,
  delta,
  color,
}: {
  label: string;
  total: string;
  values: number[];
  delta: number | null;
  color?: string;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 py-3 border-t first:border-t-0"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="min-w-0">
        <div
          className="text-xs font-medium"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          {label}
        </div>
        <div className="flex items-baseline gap-2">
          <span
            className="text-lg font-semibold tabular-nums"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {total}
          </span>
          <DeltaBadge pct={delta} />
        </div>
      </div>
      <Sparkline
        values={values}
        width={160}
        height={36}
        color={color}
        ariaLabel={`${label} trend`}
      />
    </div>
  );
}

// A compact stat block for the MRR card (label over a big number).
function RevenueStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-[0.18em] font-semibold"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </div>
      <div
        className="text-2xl font-semibold tabular-nums leading-tight"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {value}
      </div>
      {hint && (
        <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

// Fleet recurring-revenue (MRR) card — the platform's own SaaS revenue,
// independent of the analytics window above. Billing may be unconfigured
// for a fresh fleet, in which case this degrades to an empty state.
function FleetRevenueCard() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["platform-billing-summary"],
    queryFn: fetchFleetBillingSummary,
  });

  return (
    <Card
      title="Recurring revenue (MRR)"
      subtitle="Platform subscription revenue across all tenants — what tenants pay to run on the platform (distinct from storefront GMV above)."
    >
      {isError ? (
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Couldn't load billing — it may not be configured for this fleet yet.
        </p>
      ) : isPending ? (
        <Spinner label="Loading revenue…" />
      ) : !data || data.payingTenants === 0 ? (
        <EmptyState
          title="No active subscriptions yet."
          hint="Assign tenants to a plan from the platform billing console."
        />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <RevenueStat
              label="MRR"
              value={`${formatMoney(data.mrrCents)}/mo`}
              hint={
                data.atRiskMrrCents > 0
                  ? `${formatMoney(data.atRiskMrrCents)} past-due (at risk)`
                  : `${formatMoney(data.addonMrrCents)} from add-ons`
              }
            />
            <RevenueStat
              label="ARPU"
              value={`${formatMoney(data.arpuCents)}/mo`}
              hint="per paying tenant"
            />
            <RevenueStat
              label="Paying tenants"
              value={data.payingTenants.toLocaleString()}
              hint={`${data.trialingTenants} trialing · ${data.unsubscribedTenants} unsubscribed`}
            />
          </div>
          {data.byPlan.length > 0 && (
            <div
              className="border-t pt-3"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <div
                className="text-[11px] font-medium mb-2"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                MRR by plan
              </div>
              <div className="space-y-1">
                {data.byPlan.map((p) => (
                  <div
                    key={p.planCode}
                    className="flex items-center justify-between text-xs"
                  >
                    <span style={{ color: "hsl(var(--ink-2))" }}>
                      {p.planName}{" "}
                      <span style={{ color: "hsl(var(--ink-3))" }}>
                        ({p.tenants})
                      </span>
                    </span>
                    <span
                      className="tabular-nums font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {formatMoney(p.mrrCents)}/mo
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// Client-side CSV cell guard: RFC-4180 quoting + formula-injection
// neutralisation (mirrors the backend safeCsvCell) so an exported
// leaderboard can't smuggle a `=`/`+`/`-`/`@` formula into a spreadsheet.
function csvCell(value: unknown): string {
  if (value == null) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadTenantsCsv(
  rows: PlatformAnalyticsTenantRow[],
  days: number,
): void {
  const header = [
    "Tenant",
    "Slug",
    "Status",
    `Revenue (${days}d, USD)`,
    `Paid orders (${days}d)`,
    `New patients (${days}d)`,
    "Patients (all-time)",
    "Orders (all-time)",
    "Conversations (all-time)",
  ];
  const lines = [
    header,
    ...rows.map((t) => [
      t.name ?? t.slug,
      t.slug,
      t.status,
      (t.windowGmvCents / 100).toFixed(2),
      String(t.windowOrders),
      String(t.windowNewPatients),
      t.patients == null ? "" : String(t.patients),
      t.orders == null ? "" : String(t.orders),
      t.conversations == null ? "" : String(t.conversations),
    ]),
  ];
  const csv = lines.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fleet-tenants-${days}d-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Surfaces tenants that need an operator's eyes — currently the suspended
// ones (offline until reactivated). Renders nothing when all is well, so
// it stays out of the way on a healthy fleet.
function NeedsAttentionCard({
  tenants,
}: {
  tenants: PlatformAnalyticsTenantRow[];
}) {
  const queryClient = useQueryClient();
  const reactivate = useReactivateTenant();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suspended = useMemo(
    () => tenants.filter((t) => t.status === "suspended"),
    [tenants],
  );
  if (suspended.length === 0) return null;

  function onReactivate(id: string) {
    setError(null);
    setBusyId(id);
    reactivate.mutate(id, {
      onSuccess: () => {
        // Refresh both the dashboard analytics (this list) and the
        // directory so the tenant drops out of "needs attention".
        void queryClient.invalidateQueries({
          queryKey: ["platform-analytics"],
        });
        void queryClient.invalidateQueries({
          queryKey: getListTenantsQueryKey(),
        });
      },
      onError: () => setError("Couldn't reactivate that tenant."),
      onSettled: () => setBusyId(null),
    });
  }

  return (
    <Card
      title="Needs attention"
      subtitle={`${suspended.length} suspended tenant${
        suspended.length === 1 ? "" : "s"
      } — offline until reactivated.`}
    >
      {error && (
        <p className="text-xs mb-2" style={{ color: "hsl(354 75% 38%)" }}>
          {error}
        </p>
      )}
      <ul className="space-y-1">
        {suspended.map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between gap-3 rounded-md px-3 py-2 border"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <Link href={`/platform/tenants/${t.id}`} className="min-w-0 group">
              <span
                className="text-sm font-medium block truncate group-hover:underline"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {t.name ?? t.slug}
              </span>
              <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                {t.slug}
              </span>
            </Link>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant="danger">suspended</Badge>
              <Button
                intent="ghost"
                size="sm"
                isLoading={busyId === t.id && reactivate.isPending}
                onClick={() => onReactivate(t.id)}
              >
                Reactivate
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PlatformDashboard() {
  const [days, setDays] = useState<number>(30);
  const { data, isPending, isError, refetch, isFetching } =
    useQuery<PlatformAnalyticsResponse>({
      queryKey: ["platform-analytics", days],
      queryFn: () => fetchPlatformAnalytics(days),
    });

  const columns = useMemo<Column<PlatformAnalyticsTenantRow>[]>(
    () => [
      {
        key: "name",
        header: "Tenant",
        render: (t) => (
          <Link href={`/platform/tenants/${t.id}`} className="block group">
            <div
              className="font-medium group-hover:underline"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {t.name ?? t.slug}
            </div>
            <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {t.slug}
            </div>
          </Link>
        ),
        sortable: true,
        sortValue: (t) => (t.name ?? t.slug).toLowerCase(),
      },
      {
        key: "status",
        header: "Status",
        render: (t) => (
          <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
        ),
        sortable: true,
        sortValue: (t) => t.status,
      },
      {
        key: "gmv",
        header: "Revenue",
        className: "text-right tabular-nums",
        render: (t) => fmtUsd(t.windowGmvCents),
        sortable: true,
        sortValue: (t) => t.windowGmvCents,
      },
      {
        key: "orders",
        header: "Paid orders",
        className: "text-right tabular-nums",
        render: (t) => fmtCount(t.windowOrders),
        sortable: true,
        sortValue: (t) => t.windowOrders,
      },
      {
        key: "newPatients",
        header: "New patients",
        className: "text-right tabular-nums",
        render: (t) => fmtCount(t.windowNewPatients),
        sortable: true,
        sortValue: (t) => t.windowNewPatients,
      },
      {
        key: "patients",
        header: "Patients (all-time)",
        className: "text-right tabular-nums",
        render: (t) => fmtCount(t.patients),
        sortable: true,
        sortValue: (t) => t.patients ?? -1,
      },
    ],
    [],
  );

  const win = data?.window;
  const totals = data?.totals;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Fleet-wide activity across every tenant. Aggregate counts and revenue only — no patient data is shown here. To see a tenant's actual records, impersonate it from the Tenants tab (audited)."
        actions={
          <>
            <div
              className="inline-flex rounded-md overflow-hidden border"
              style={{ borderColor: "hsl(var(--line-1))" }}
              role="group"
              aria-label="Time window"
            >
              {WINDOW_OPTIONS.map((opt) => {
                const active = opt === days;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setDays(opt)}
                    aria-pressed={active}
                    className="px-3 py-1.5 text-xs font-medium"
                    style={{
                      color: active
                        ? "hsl(var(--surface-1))"
                        : "hsl(var(--ink-2))",
                      backgroundColor: active
                        ? "hsl(var(--penn-navy))"
                        : "transparent",
                    }}
                  >
                    {opt}d
                  </button>
                );
              })}
            </div>
            <Button
              intent="secondary"
              size="sm"
              isLoading={isFetching}
              onClick={() => void refetch()}
            >
              Refresh
            </Button>
          </>
        }
      />

      {isError ? (
        <Card title="Couldn't load analytics">
          <EmptyState
            title="The analytics query failed."
            hint="A transient error — try again."
            action={
              <Button
                intent="secondary"
                size="sm"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {/* Headline KPI tiles */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Active tenants"
              value={isPending ? "" : fmtCount(totals?.tenants.active)}
              isLoading={isPending}
              hint={
                totals
                  ? `${totals.tenants.total} total · ${totals.tenants.suspended} suspended` +
                    (win && win.newTenants > 0
                      ? ` · +${win.newTenants} new`
                      : "")
                  : undefined
              }
            />
            <KpiCard
              label={`Revenue · ${days}d`}
              tone="gold"
              value={isPending ? "" : fmtUsd(win?.gmvCents ?? 0)}
              isLoading={isPending}
              hint={
                win
                  ? `${win.newOrders.toLocaleString()} paid orders this period`
                  : undefined
              }
            />
            <KpiCard
              label={`New patients · ${days}d`}
              value={isPending ? "" : fmtCount(win?.newPatients)}
              isLoading={isPending}
              hint={
                totals?.patients != null
                  ? `${totals.patients.toLocaleString()} all-time`
                  : undefined
              }
            />
            <KpiCard
              label={`Conversations · ${days}d`}
              value={isPending ? "" : fmtCount(win?.newConversations)}
              isLoading={isPending}
              hint={
                totals?.conversations != null
                  ? `${totals.conversations.toLocaleString()} all-time`
                  : undefined
              }
            />
          </div>

          {data && <NeedsAttentionCard tenants={data.tenants} />}

          <FleetRevenueCard />

          {isPending || !data ? (
            <Card title="Fleet trends">
              <Spinner label="Loading analytics…" />
            </Card>
          ) : (
            <>
              <Card
                title="Fleet trends"
                subtitle={`Daily totals across all tenants for the last ${days} days. Δ compares this period to the one before it.`}
              >
                <TrendRow
                  label="Revenue (GMV)"
                  total={fmtUsd(data.window.gmvCents)}
                  values={data.series.gmvCents.map((c) => c / 100)}
                  delta={data.window.delta.gmvCents}
                  color="hsl(var(--penn-gold-deep))"
                />
                <TrendRow
                  label="New patients"
                  total={data.window.newPatients.toLocaleString()}
                  values={data.series.newPatients}
                  delta={data.window.delta.newPatients}
                />
                <TrendRow
                  label="Paid orders"
                  total={data.window.newOrders.toLocaleString()}
                  values={data.series.newOrders}
                  delta={data.window.delta.newOrders}
                />
                <TrendRow
                  label="Conversations"
                  total={data.window.newConversations.toLocaleString()}
                  values={data.series.newConversations}
                  delta={data.window.delta.newConversations}
                />
              </Card>

              <Card
                title="Tenant leaderboard"
                subtitle={`Ranked by revenue over the last ${days} days. Click a column to re-sort.`}
                action={
                  data.tenants.length > 0 ? (
                    <Button
                      intent="secondary"
                      size="sm"
                      onClick={() => downloadTenantsCsv(data.tenants, days)}
                    >
                      Export CSV
                    </Button>
                  ) : undefined
                }
              >
                <Table<PlatformAnalyticsTenantRow>
                  columns={columns}
                  rows={data.tenants}
                  rowKey={(t) => t.id}
                  initialSort={{ key: "gmv", dir: "desc" }}
                  emptyState={<EmptyState title="No tenants yet." />}
                />
              </Card>

              <p className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
                Generated {new Date(data.generatedAt).toLocaleString()} · all
                times UTC-bucketed
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Global integrations (platform infra credentials) ───────────────

function configStatus(s: PlatformConfigSetting): {
  label: string;
  variant: "success" | "muted" | "neutral";
} {
  if (s.source === "db") return { label: "Set", variant: "success" };
  if (s.source === "env")
    return { label: "From environment", variant: "muted" };
  return { label: "Not set", variant: "neutral" };
}

function ConfigSettingRow({ setting }: { setting: PlatformConfigSetting }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["platform-config"] });
  }

  const save = useMutation({
    mutationFn: () => setPlatformConfig(setting.key, value),
    onSuccess: () => {
      setValue("");
      setError(null);
      invalidate();
    },
    onError: () => setError("Couldn't save that value."),
  });
  const clear = useMutation({
    mutationFn: () => clearPlatformConfig(setting.key),
    onSuccess: () => {
      // Clear any stale "couldn't clear" message so a successful retry
      // doesn't leave the old error visible.
      setError(null);
      invalidate();
    },
    onError: () => setError("Couldn't clear that value."),
  });

  const status = configStatus(setting);
  const applyBadge =
    setting.applyMode === "live" ? "Applies live" : "Applies on next deploy";

  return (
    <div
      className="py-3 border-t first:border-t-0"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div
            className="text-sm font-medium"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {setting.label}
          </div>
          <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            {setting.description}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          {setting.hint && (
            <span
              className="text-xs font-mono"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              {setting.hint}
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <Input
          type={setting.secret ? "password" : "text"}
          value={value}
          placeholder={setting.placeholder ?? "Enter a value…"}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 min-w-[12rem]"
        />
        <Button
          intent="secondary"
          size="sm"
          disabled={value.trim().length === 0 || save.isPending}
          isLoading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        {setting.source === "db" && (
          <Button
            intent="ghost"
            size="sm"
            disabled={clear.isPending}
            isLoading={clear.isPending}
            onClick={() => clear.mutate()}
          >
            Clear
          </Button>
        )}
        <span className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
          {applyBadge}
        </span>
      </div>
      {error && (
        <p className="text-xs mt-1" style={{ color: "hsl(354 75% 38%)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function GlobalIntegrations() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["platform-config"],
    queryFn: fetchPlatformConfig,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Global integrations"
        description="Platform-wide infrastructure credentials — the AI vendors and the platform's own Twilio, Telnyx, SendGrid, and Stripe. Shared by every tenant. A tenant's OWN business accounts (its therapy-cloud and clearinghouse logins) live in that tenant's own settings."
      />
      {data?.overlayDisabled && (
        <Card title="Overlay disabled">
          <p className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
            APP_CONFIG_OVERLAY_DISABLED is set, so saved values are NOT applied
            to the running process. Unset it to resume using saved
            configuration.
          </p>
        </Card>
      )}
      {isPending ? (
        <Spinner label="Loading configuration…" />
      ) : isError ? (
        <EmptyState
          title="Couldn't load configuration."
          hint="A transient error — try again."
          action={
            <Button intent="secondary" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          {(data?.categories ?? []).map((cat) => (
            <Card key={cat.category} title={cat.category}>
              {cat.settings.map((s) => (
                <ConfigSettingRow key={s.key} setting={s} />
              ))}
            </Card>
          ))}
          {data?.webhookReference?.endpoints.length ? (
            <Card title="Telephony webhook URLs">
              <p
                className="text-xs mb-2"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Paste these into each vendor portal (Twilio for voice/SMS,
                Telnyx for fax).
              </p>
              {data.webhookReference.endpoints.map((e) => (
                <div
                  key={e.id}
                  className="py-2 border-t first:border-t-0"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <div
                    className="text-xs font-medium"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {e.label}
                  </div>
                  <div
                    className="text-xs font-mono break-all"
                    style={{ color: "hsl(var(--ink-2))" }}
                  >
                    {e.url}
                  </div>
                </div>
              ))}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── Support queue (cross-tenant tickets the bot escalated) ─────────

const SUPPORT_FILTERS: ReadonlyArray<{
  value: SupportTicketStatus | "all";
  label: string;
}> = [
  { value: "awaiting_platform", label: "Needs reply" },
  { value: "awaiting_tenant", label: "Waiting on tenant" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function SupportMessageRow({ m }: { m: SupportMessage }) {
  const label =
    m.authorRole === "bot"
      ? "Support bot"
      : m.authorRole === "platform"
        ? "You (support)"
        : "Tenant";
  return (
    <div
      className="rounded-lg px-3 py-2 border"
      style={{
        borderColor: "hsl(var(--line-1))",
        backgroundColor:
          m.authorRole === "tenant"
            ? "hsl(var(--surface-2))"
            : "hsl(var(--penn-navy) / 0.06)",
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className="text-[11px] font-semibold"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          {label}
        </span>
        {m.authorRole === "bot" && <Badge variant="info">AI</Badge>}
        <span className="text-[10px]" style={{ color: "hsl(var(--ink-3))" }}>
          {new Date(m.createdAt).toLocaleString()}
        </span>
      </div>
      <p
        className="text-sm whitespace-pre-wrap leading-snug"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {m.body}
      </p>
    </div>
  );
}

function PlatformTicketThread({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [reply, setReply] = useState("");
  const detail = useQuery({
    queryKey: ["platform-support-ticket", id],
    queryFn: () => getPlatformSupportTicket(id),
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ["platform-support-ticket", id],
    });
    void queryClient.invalidateQueries({ queryKey: ["platform-support"] });
  };
  const send = useMutation({
    mutationFn: () => replyPlatformSupportTicket(id, reply.trim()),
    onSuccess: () => {
      setReply("");
      invalidate();
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: SupportTicketStatus) =>
      setPlatformSupportStatus(id, status),
    onSuccess: invalidate,
  });

  if (detail.isPending) return <Spinner label="Loading ticket…" />;
  if (detail.isError || !detail.data) {
    return <EmptyState title="Couldn't load that ticket." hint="Try again." />;
  }
  const { ticket, messages } = detail.data;
  const closed = ticket.status === "resolved" || ticket.status === "closed";

  return (
    <Card
      title={ticket.subject}
      subtitle={
        ticket.tenant
          ? `${ticket.tenant.name ?? ticket.tenant.slug} · ${ticket.createdByEmail ?? "unknown"}`
          : (ticket.createdByEmail ?? undefined)
      }
      action={
        <Badge variant={supportStatusVariant(ticket.status)}>
          {supportStatusLabel(ticket.status)}
        </Badge>
      }
    >
      <div className="space-y-3">
        {messages.map((m) => (
          <SupportMessageRow key={m.id} m={m} />
        ))}
      </div>
      <div
        className="mt-4 pt-4 border-t space-y-2"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <textarea
          className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "hsl(var(--surface-1))",
            color: "hsl(var(--ink-1))",
          }}
          rows={3}
          maxLength={6000}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Reply to the tenant…"
        />
        <div className="flex items-center justify-between gap-2">
          {closed ? (
            <Button
              intent="ghost"
              size="sm"
              isLoading={setStatus.isPending}
              onClick={() => setStatus.mutate("awaiting_platform")}
            >
              Reopen
            </Button>
          ) : (
            <Button
              intent="ghost"
              size="sm"
              isLoading={setStatus.isPending}
              onClick={() => setStatus.mutate("resolved")}
            >
              Mark resolved
            </Button>
          )}
          <Button
            size="sm"
            disabled={reply.trim().length === 0 || send.isPending}
            isLoading={send.isPending}
            onClick={() => send.mutate()}
          >
            Send reply
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PlatformSupport() {
  const [filter, setFilter] = useState<SupportTicketStatus | "all">(
    "awaiting_platform",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["platform-support", filter],
    queryFn: () =>
      listPlatformSupportTickets(filter === "all" ? undefined : filter),
  });

  const tickets = list.data?.tickets ?? [];
  const activeId = selectedId ?? tickets[0]?.id ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Support queue"
        description="Tickets tenants filed across the fleet. The intake bot auto-answers how-to questions; anything it escalates lands here as “Needs reply”."
        actions={
          <div
            className="inline-flex rounded-md overflow-hidden border flex-wrap"
            style={{ borderColor: "hsl(var(--line-1))" }}
            role="group"
            aria-label="Filter tickets"
          >
            {SUPPORT_FILTERS.map((f) => {
              const active = f.value === filter;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => {
                    setFilter(f.value);
                    setSelectedId(null);
                  }}
                  aria-pressed={active}
                  className="px-3 py-1.5 text-xs font-medium"
                  style={{
                    color: active
                      ? "hsl(var(--surface-1))"
                      : "hsl(var(--ink-2))",
                    backgroundColor: active
                      ? "hsl(var(--penn-navy))"
                      : "transparent",
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[360px_1fr] items-start">
        <Card title="Tickets">
          {list.isPending ? (
            <Spinner label="Loading…" />
          ) : tickets.length === 0 ? (
            <EmptyState title="No tickets here." hint="Nothing in this view." />
          ) : (
            <ul className="space-y-1">
              {tickets.map((t: SupportTicket) => {
                const active = t.id === activeId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(t.id)}
                      className="w-full text-left rounded-md px-3 py-2 border"
                      style={{
                        borderColor: active
                          ? "hsl(var(--penn-navy))"
                          : "hsl(var(--line-1))",
                        backgroundColor: active
                          ? "hsl(var(--penn-navy) / 0.06)"
                          : "transparent",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="text-sm font-medium truncate"
                          style={{ color: "hsl(var(--ink-1))" }}
                        >
                          {t.subject}
                        </span>
                        <Badge variant={supportStatusVariant(t.status)}>
                          {supportStatusLabel(t.status)}
                        </Badge>
                      </div>
                      <div
                        className="text-[11px]"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {(t.tenant?.name ?? t.tenant?.slug ?? "tenant") +
                          " · " +
                          new Date(t.lastActivityAt).toLocaleDateString()}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {activeId ? (
          <PlatformTicketThread id={activeId} />
        ) : (
          <Card title="No ticket selected">
            <EmptyState
              title="Select a ticket to view the conversation."
              hint="Reply, resolve, or reopen from here."
            />
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Tenant detail (drill-down) ─────────────────────────────────────

function MetaItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-[0.16em] font-semibold mb-1"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </div>
      <div className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
        {children}
      </div>
    </div>
  );
}

// One feature-flag row with an accessible toggle. Non-manageable flags
// (seeded by a newer build than this deploy) render disabled — mirrors
// the per-tenant Control Center posture.
function FeatureFlagRow({
  tenantId,
  flag,
}: {
  tenantId: string;
  flag: TenantFeatureFlag;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const toggle = useToggleTenantFeatureFlag(tenantId, {
    mutation: {
      onSuccess: () => {
        setError(null);
        void queryClient.invalidateQueries({
          queryKey: getTenantFeatureFlagsQueryKey(tenantId),
        });
      },
      onError: () => setError("Couldn't update that flag."),
    },
  });
  const disabled = !flag.manageable || toggle.isPending;
  return (
    <div
      className="py-3 border-t first:border-t-0 flex items-start justify-between gap-4"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="min-w-0">
        <div
          className="text-sm font-medium font-mono"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {flag.key}
        </div>
        {flag.description && (
          <div
            className="text-xs mt-0.5"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {flag.description}
          </div>
        )}
        {!flag.manageable && (
          <div
            className="text-[11px] mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Seeded by a newer build — not toggleable from here yet.
          </div>
        )}
        {error && (
          <div
            className="text-[11px] mt-1"
            style={{ color: "hsl(354 75% 38%)" }}
          >
            {error}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={flag.enabled}
        aria-label={`Toggle ${flag.key}`}
        disabled={disabled}
        onClick={() => toggle.mutate({ key: flag.key, enabled: !flag.enabled })}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          backgroundColor: flag.enabled
            ? "hsl(var(--penn-navy))"
            : "hsl(var(--surface-3))",
        }}
      >
        <span
          className="inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform"
          style={{
            transform: flag.enabled ? "translateX(18px)" : "translateX(2px)",
          }}
        />
      </button>
    </div>
  );
}

function TenantFeatureFlagsCard({ tenantId }: { tenantId: string }) {
  const { data, isPending, isError, refetch } = useTenantFeatureFlags(tenantId);
  const [query, setQuery] = useState("");
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, TenantFeatureFlag[]>();
    for (const f of data?.flags ?? []) {
      if (
        q &&
        !f.key.toLowerCase().includes(q) &&
        !f.description.toLowerCase().includes(q) &&
        !f.category.toLowerCase().includes(q)
      ) {
        continue;
      }
      const arr = m.get(f.category) ?? [];
      arr.push(f);
      m.set(f.category, arr);
    }
    return [...m.entries()];
  }, [data, query]);

  const hasFlags = (data?.flags.length ?? 0) > 0;

  return (
    <Card
      title="Feature flags"
      subtitle="Toggle this tenant's features without impersonating — mirrors the tenant's own Control Center, and the change shows up in its toggle activity."
      action={
        hasFlags ? (
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter flags…"
            className="w-40"
            aria-label="Filter feature flags"
          />
        ) : undefined
      }
    >
      {isPending ? (
        <Spinner label="Loading flags…" />
      ) : isError ? (
        <EmptyState
          title="Couldn't load feature flags."
          hint="A transient error — try again."
          action={
            <Button intent="secondary" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : !hasFlags ? (
        <EmptyState
          title="No feature flags."
          hint="This tenant hasn't been provisioned a flag catalog yet."
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          title="No flags match your filter."
          hint="Clear the filter to see the full catalog."
        />
      ) : (
        <div className="space-y-5">
          {grouped.map(([category, flags]) => (
            <div key={category}>
              <div
                className="text-[10px] uppercase tracking-[0.18em] font-semibold mb-1"
                style={{ color: "hsl(var(--penn-gold-deep))" }}
              >
                {category}
              </div>
              <div>
                {flags.map((f) => (
                  <FeatureFlagRow key={f.key} tenantId={tenantId} flag={f} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Recent feature-flag toggle history for the tenant — who flipped what,
// when, and which way. Reads the per-tenant toggle ledger (the same
// `feature_flag_events` the tenant's own Control Center surfaces), so a
// platform-side change is auditable here too.
function RecentFlagActivityCard({ tenantId }: { tenantId: string }) {
  const { data, isPending, isError, refetch } =
    useTenantFeatureFlagActivity(tenantId);
  const activity = data?.activity ?? [];

  return (
    <Card
      title="Recent flag changes"
      subtitle="The last toggles for this tenant — from its own Control Center and from here."
    >
      {isPending ? (
        <Spinner label="Loading activity…" />
      ) : isError ? (
        <EmptyState
          title="Couldn't load activity."
          hint="A transient error — try again."
          action={
            <Button intent="secondary" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : activity.length === 0 ? (
        <EmptyState
          title="No toggles yet."
          hint="Feature-flag changes for this tenant will show up here."
        />
      ) : (
        <ul className="space-y-0">
          {activity.map((a, i) => (
            <li
              key={`${a.occurredAt}-${a.key}-${i}`}
              className="py-2.5 border-t first:border-t-0 flex items-start justify-between gap-4"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-sm font-mono"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {a.key}
                  </span>
                  <Badge variant={a.to ? "success" : "muted"}>
                    {a.to ? "enabled" : "disabled"}
                  </Badge>
                </div>
                <div
                  className="text-[11px] mt-0.5"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {a.operatorEmail ?? "system"}
                </div>
              </div>
              <span
                className="text-[11px] tabular-nums whitespace-nowrap"
                style={{ color: "hsl(var(--ink-3))" }}
                title={new Date(a.occurredAt).toLocaleString()}
              >
                {new Date(a.occurredAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function billingStatusVariant(
  status: string,
): "success" | "info" | "danger" | "muted" | "neutral" {
  switch (status) {
    case "active":
      return "success";
    case "trialing":
      return "info";
    case "past_due":
    case "unpaid":
      return "danger";
    case "canceled":
    case "cancelled":
      return "muted";
    default:
      return "neutral";
  }
}

// The tenant's platform subscription at a glance — plan, status, monthly
// price, renewal, last invoice, add-on count. Reads the same per-tenant
// billing the platform Billing console renders (shared query key, so it's
// cached/deduped). Deep edits stay on /platform/billing.
function TenantBillingCard({ tenantId }: { tenantId: string }) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["platform-billing", "tenants"],
    queryFn: fetchPlatformTenantBilling,
  });
  const row = data?.tenants.find((t) => t.id === tenantId);
  const sub = row?.billing.subscription ?? null;
  const monthly = sub
    ? (sub.customMonthlyPriceCents ?? sub.plan.monthlyPriceCents)
    : null;
  const displayStatus = sub ? (sub.stripeStatus ?? sub.status) : "";

  return (
    <Card
      title="Plan & billing"
      subtitle="What this tenant pays to run on the platform."
      action={
        <Link href="/platform/billing">
          <Button intent="ghost" size="sm">
            Manage
          </Button>
        </Link>
      }
    >
      {isPending ? (
        <Spinner label="Loading billing…" />
      ) : isError ? (
        <EmptyState
          title="Couldn't load billing."
          hint="It may not be configured for this fleet yet."
          action={
            <Button intent="secondary" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : !sub ? (
        <EmptyState
          title="No subscription."
          hint="Assign a plan from the Billing console."
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span
              className="text-base font-semibold"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {sub.plan.name}
            </span>
            <Badge variant={billingStatusVariant(displayStatus)}>
              {displayStatus.replace(/_/g, " ")}
            </Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetaItem label="Monthly">
              {monthly != null ? `${formatMoney(monthly)}/mo` : "—"}
            </MetaItem>
            <MetaItem label="Renews">
              {sub.currentPeriodEnd
                ? new Date(sub.currentPeriodEnd).toLocaleDateString()
                : "—"}
            </MetaItem>
            <MetaItem label="Last invoice">
              {sub.lastInvoiceStatus
                ? sub.lastInvoiceStatus.replace(/_/g, " ")
                : "—"}
            </MetaItem>
            <MetaItem label="Add-ons">
              {row?.billing.addons.length ?? 0}
            </MetaItem>
          </div>
        </div>
      )}
    </Card>
  );
}

// Per-tenant daily trend sparklines (last 30 days) — the same metrics the
// fleet dashboard charts, scoped to one tenant. Reuses TrendRow/Sparkline.
function TenantActivityCard({ tenantId }: { tenantId: string }) {
  const { data, isPending, isError, refetch } = useTenantActivitySeries(
    tenantId,
    30,
  );
  return (
    <Card
      title="Activity · 30d"
      subtitle="Daily new patients, paid orders, and conversations. Δ compares the last 30 days to the prior 30."
    >
      {isPending ? (
        <Spinner label="Loading activity…" />
      ) : isError ? (
        <EmptyState
          title="Couldn't load activity."
          hint="A transient error — try again."
          action={
            <Button intent="secondary" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      ) : data ? (
        <>
          <TrendRow
            label="Revenue (GMV)"
            total={fmtUsd(data.window.gmvCents)}
            values={data.series.gmvCents.map((c) => c / 100)}
            delta={data.window.delta.gmvCents}
            color="hsl(var(--penn-gold-deep))"
          />
          <TrendRow
            label="New patients"
            total={data.window.newPatients.toLocaleString()}
            values={data.series.newPatients}
            delta={data.window.delta.newPatients}
          />
          <TrendRow
            label="Paid orders"
            total={data.window.newOrders.toLocaleString()}
            values={data.series.newOrders}
            delta={data.window.delta.newOrders}
          />
          <TrendRow
            label="Conversations"
            total={data.window.newConversations.toLocaleString()}
            values={data.series.newConversations}
            delta={data.window.delta.newConversations}
          />
        </>
      ) : null}
    </Card>
  );
}

function TenantDetailPage() {
  const [, params] = useRoute("/platform/tenants/:id");
  const id = params?.id ?? "";
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useGetTenant(id, {
    query: {
      enabled: id.length > 0,
      retry: (failureCount, err) => {
        const status = err instanceof ApiError ? err.status : 0;
        if (status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  });
  const usage = useTenantUsage(id, { query: { enabled: id.length > 0 } });
  const suspend = useSuspendTenant();
  const reactivate = useReactivateTenant();
  const impersonate = useImpersonateTenant();
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"suspend" | "impersonate" | null>(
    null,
  );

  function invalidateTenant() {
    void queryClient.invalidateQueries({ queryKey: getTenantQueryKey(id) });
    void queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
  }

  const status = error instanceof ApiError ? error.status : 0;
  if (isError) {
    const notFound = status === 404;
    return (
      <div className="space-y-6">
        <Link
          href="/platform/tenants"
          className="text-xs font-medium"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          ← All tenants
        </Link>
        <Card title={notFound ? "Tenant not found" : "Couldn't load tenant"}>
          <EmptyState
            title={notFound ? "No tenant with that id." : "The query failed."}
            hint={
              notFound
                ? "It may have been removed. Head back to the directory."
                : "A transient error — try again."
            }
            action={
              notFound ? undefined : (
                <Button
                  intent="secondary"
                  size="sm"
                  onClick={() => void refetch()}
                >
                  Retry
                </Button>
              )
            }
          />
        </Card>
      </div>
    );
  }

  const tenant = data?.tenant;

  function runReactivate() {
    if (!tenant) return;
    setActionError(null);
    reactivate.mutate(tenant.id, {
      onSuccess: invalidateTenant,
      onError: () => setActionError("Couldn't reactivate that tenant."),
    });
  }
  function runSuspend() {
    if (!tenant) return;
    setActionError(null);
    suspend.mutate(tenant.id, {
      onSuccess: () => {
        invalidateTenant();
        setConfirm(null);
      },
      onError: (err) => {
        setActionError(
          err instanceof ApiError && err.status === 400
            ? "The seed tenant can't be suspended."
            : "Couldn't suspend that tenant.",
        );
        setConfirm(null);
      },
    });
  }
  function runImpersonate() {
    if (!tenant) return;
    setActionError(null);
    impersonate.mutate(tenant.id, {
      onSuccess: () => window.location.assign("/admin"),
      onError: () => {
        setActionError("Couldn't start impersonation.");
        setConfirm(null);
      },
    });
  }

  return (
    <div className="space-y-6">
      <Link
        href="/platform/tenants"
        className="inline-block text-xs font-medium"
        style={{ color: "hsl(var(--penn-navy))" }}
      >
        ← All tenants
      </Link>

      {isPending || !tenant ? (
        <Card title="Loading tenant…">
          <Spinner label="Loading tenant…" />
        </Card>
      ) : (
        <>
          <Card>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h1
                    className="text-xl font-semibold leading-tight"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {tenant.name ?? tenant.slug}
                  </h1>
                  <Badge variant={statusVariant(tenant.status)}>
                    {tenant.status}
                  </Badge>
                </div>
                <div
                  className="text-xs mt-1 flex items-center gap-3 flex-wrap"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <CopyableId value={tenant.slug} title="Copy slug" />
                  {tenant.customDomain && (
                    <a
                      href={`https://${tenant.customDomain}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 hover:underline"
                      style={{ color: "hsl(var(--penn-navy))" }}
                    >
                      Open storefront
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  intent="secondary"
                  size="sm"
                  onClick={() => setConfirm("impersonate")}
                >
                  Impersonate
                </Button>
                {tenant.status === "suspended" ? (
                  <Button
                    intent="ghost"
                    size="sm"
                    isLoading={reactivate.isPending}
                    onClick={runReactivate}
                  >
                    Reactivate
                  </Button>
                ) : (
                  <Button
                    intent="ghost"
                    size="sm"
                    onClick={() => setConfirm("suspend")}
                  >
                    Suspend
                  </Button>
                )}
              </div>
            </div>
            {actionError && (
              <p className="text-xs mt-3" style={{ color: "hsl(354 75% 38%)" }}>
                {actionError}
              </p>
            )}
            <div
              className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mt-5 pt-5 border-t"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <MetaItem label="Custom domain">
                {tenant.customDomain ? (
                  <span>
                    {tenant.customDomain}
                    {tenant.customDomainStatus &&
                    tenant.customDomainStatus !== "active" ? (
                      <span style={{ color: "hsl(var(--ink-3))" }}>
                        {" "}
                        ({tenant.customDomainStatus})
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span style={{ color: "hsl(var(--ink-3))" }}>—</span>
                )}
              </MetaItem>
              <MetaItem label="From address">
                {tenant.fromEmail ? (
                  <span>
                    {tenant.fromName ? `${tenant.fromName} · ` : ""}
                    {tenant.fromEmail}
                  </span>
                ) : (
                  <span style={{ color: "hsl(var(--ink-3))" }}>
                    Platform default
                  </span>
                )}
              </MetaItem>
              <MetaItem label="Created">
                {new Date(tenant.createdAt).toLocaleDateString()}
              </MetaItem>
              <MetaItem label="Last updated">
                {tenant.updatedAt
                  ? new Date(tenant.updatedAt).toLocaleDateString()
                  : "—"}
              </MetaItem>
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard
              label="Patients"
              value={
                usage.isPending ? "" : fmtCount(usage.data?.usage.patients)
              }
              isLoading={usage.isPending}
              hint="all-time"
            />
            <KpiCard
              label="Orders"
              tone="gold"
              value={usage.isPending ? "" : fmtCount(usage.data?.usage.orders)}
              isLoading={usage.isPending}
              hint="all-time"
            />
            <KpiCard
              label="Conversations"
              value={
                usage.isPending ? "" : fmtCount(usage.data?.usage.conversations)
              }
              isLoading={usage.isPending}
              hint="all-time"
            />
          </div>

          <TenantActivityCard tenantId={tenant.id} />

          <TenantBillingCard tenantId={tenant.id} />

          <TenantFeatureFlagsCard tenantId={tenant.id} />

          <RecentFlagActivityCard tenantId={tenant.id} />

          <p className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
            Counts are aggregates only — no patient records cross this surface.
            To see a tenant's actual data, use audited impersonation above.
          </p>
        </>
      )}

      {confirm === "suspend" && tenant && (
        <ConfirmDialog
          title="Suspend tenant?"
          confirmLabel="Suspend"
          intent="secondary"
          isPending={suspend.isPending}
          body={
            <>
              <strong style={{ color: "hsl(var(--ink-1))" }}>
                {tenant.name ?? tenant.slug}
              </strong>{" "}
              will go offline: its custom domain stops resolving and its
              background jobs pause. You can reactivate it at any time.
            </>
          }
          onConfirm={runSuspend}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "impersonate" && tenant && (
        <ConfirmDialog
          title="Operate as this tenant?"
          confirmLabel="Start impersonation"
          isPending={impersonate.isPending}
          body={
            <>
              You&rsquo;ll get a short-lived, audited act-as-tenant session for{" "}
              <strong style={{ color: "hsl(var(--ink-1))" }}>
                {tenant.name ?? tenant.slug}
              </strong>{" "}
              and be taken to its admin console. Every action is attributed to
              you.
            </>
          }
          onConfirm={runImpersonate}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ── Shell ──────────────────────────────────────────────────────────

// The platform console's grouped sidebar nav. Each entry is one route in
// the <Switch> below; the groups give the eight surfaces a hierarchy the
// old single horizontal tab-strip couldn't (it scrolled off-screen on
// narrow viewports). Keep the hrefs in sync with the routes.
const PLATFORM_NAV_GROUPS: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<{ href: string; label: string; icon: LucideIcon }>;
}> = [
  {
    label: "Overview",
    items: [{ href: "/platform", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Tenants",
    items: [{ href: "/platform/tenants", label: "Directory", icon: Building2 }],
  },
  {
    label: "Growth",
    items: [
      { href: "/platform/outreach", label: "Outreach", icon: Megaphone },
      { href: "/platform/billing", label: "Billing", icon: CreditCard },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/platform/support", label: "Support", icon: LifeBuoy },
      {
        href: "/platform/integrations",
        label: "Global integrations",
        icon: Plug,
      },
      {
        href: "/platform/connection-tests",
        label: "Connection tests",
        icon: Activity,
      },
    ],
  },
  {
    label: "Deployment",
    items: [
      { href: "/platform/account-setup", label: "Account setup", icon: Rocket },
      { href: "/platform/system", label: "System info", icon: ServerCog },
    ],
  },
];

function navItemActive(itemHref: string, location: string): boolean {
  // Dashboard ("/platform") must match exactly so it isn't lit up on every
  // child route; the rest also match their sub-routes (e.g. the tenant
  // directory stays active on a tenant-detail page).
  if (itemHref === "/platform") return location === "/platform";
  return location === itemHref || location.startsWith(`${itemHref}/`);
}

// A keyboard-navigable "jump to any tenant" box in the sidebar — the
// fastest path to a tenant from anywhere in the console once the fleet
// grows past a screenful. Reuses the directory's tenant list (same query
// key, so it's deduped/cached). Arrow keys move the highlight, Enter
// opens, Escape clears.
function TenantQuickSwitcher({ onNavigate }: { onNavigate: () => void }) {
  const [, navigate] = useLocation();
  const { data } = useListTenants();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K focuses the switcher from anywhere. This component renders
  // twice (desktop sidebar + mobile drawer), but only the VISIBLE instance
  // should grab focus — a `display:none` element has a null offsetParent,
  // so the hidden copy quietly no-ops.
  useEffect(() => {
    function onShortcut(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const el = inputRef.current;
        if (el && el.offsetParent !== null) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      }
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (data?.tenants ?? [])
      .filter(
        (t) =>
          t.slug.toLowerCase().includes(q) ||
          (t.name ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [data, query]);

  function go(id: string) {
    setQuery("");
    setActiveIdx(0);
    onNavigate();
    navigate(`/platform/tenants/${id}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setQuery("");
      setActiveIdx(0);
      return;
    }
    if (matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[activeIdx];
      if (m) go(m.id);
    }
  }

  return (
    <div className="px-3 pt-3">
      <div className="relative">
        <Search
          className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5"
          style={{ color: "hsl(var(--ink-3))" }}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Jump to tenant…"
          aria-label="Jump to tenant"
          title="Jump to tenant (⌘K / Ctrl+K)"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-md border pl-8 pr-9 py-1.5 text-xs outline-none focus:ring-2"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "hsl(var(--surface-1))",
            color: "hsl(var(--ink-1))",
          }}
        />
        <kbd
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono px-1 py-0.5 rounded border pointer-events-none"
          style={{
            borderColor: "hsl(var(--line-1))",
            color: "hsl(var(--ink-3))",
            backgroundColor: "hsl(var(--surface-2))",
          }}
          aria-hidden="true"
        >
          ⌘K
        </kbd>
      </div>
      {matches.length > 0 && (
        <ul
          className="mt-1 rounded-md border overflow-hidden"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "hsl(var(--surface-1))",
          }}
        >
          {matches.map((t, i) => {
            const active = i === activeIdx;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => go(t.id)}
                  aria-current={active ? "true" : undefined}
                  className="w-full text-left px-2.5 py-1.5"
                  style={{
                    backgroundColor: active
                      ? "hsl(var(--penn-navy) / 0.08)"
                      : "transparent",
                  }}
                >
                  <span
                    className="block text-xs font-medium truncate"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {t.name ?? t.slug}
                  </span>
                  <span
                    className="block text-[10px] font-mono truncate"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {t.slug}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SidebarContent({
  location,
  email,
  onSignOut,
  onNavigate,
}: {
  location: string;
  email: string | null;
  onSignOut: () => void;
  onNavigate: () => void;
}) {
  // "Needs reply" support count drives a badge on the Support nav item so
  // an operator sees the queue depth without opening it. Cached + shared
  // with the Support page's own list (cheap, refetched lazily).
  const supportNeedsReply =
    useQuery({
      queryKey: ["platform-support", "awaiting_platform"],
      queryFn: () => listPlatformSupportTickets("awaiting_platform"),
      staleTime: 60_000,
    }).data?.tickets.length ?? 0;

  return (
    <>
      <div
        className="flex items-center justify-between px-4 py-4 border-b"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-sm font-bold tracking-tight truncate"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            CareMetric Breathe
          </span>
          <Badge variant="info">Platform</Badge>
        </div>
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onNavigate}
          className="lg:hidden"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <TenantQuickSwitcher onNavigate={onNavigate} />

      <nav
        aria-label="Platform navigation"
        className="flex-1 overflow-y-auto px-2 py-3 space-y-4"
      >
        {PLATFORM_NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div
              className="px-2 mb-1 text-[10px] uppercase tracking-[0.16em] font-semibold"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = navItemActive(item.href, location);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors hover:bg-[hsl(var(--surface-3))]"
                      style={{
                        color: active
                          ? "hsl(var(--surface-1))"
                          : "hsl(var(--ink-2))",
                        backgroundColor: active
                          ? "hsl(var(--penn-navy))"
                          : undefined,
                      }}
                    >
                      <Icon
                        className="h-4 w-4 shrink-0 opacity-90"
                        aria-hidden="true"
                      />
                      <span className="truncate">{item.label}</span>
                      {item.href === "/platform/support" &&
                        supportNeedsReply > 0 && (
                          <span
                            className="ml-auto inline-flex items-center justify-center rounded-full text-[10px] font-semibold tabular-nums px-1.5 min-w-[1.25rem] h-5"
                            style={{
                              backgroundColor: active
                                ? "hsl(var(--surface-1))"
                                : "hsl(var(--penn-gold))",
                              color: active
                                ? "hsl(var(--penn-navy))"
                                : "hsl(var(--penn-onyx))",
                            }}
                            aria-label={`${supportNeedsReply} awaiting reply`}
                          >
                            {supportNeedsReply > 99 ? "99+" : supportNeedsReply}
                          </span>
                        )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div
        className="border-t px-3 py-3 space-y-2"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <Link
          href="/admin"
          onClick={onNavigate}
          className="block text-xs font-medium"
          style={{ color: "hsl(var(--penn-navy))" }}
        >
          ← Admin console
        </Link>
        {email && (
          <div
            className="text-[11px] truncate"
            style={{ color: "hsl(var(--ink-3))" }}
            title={email}
          >
            {email}
          </div>
        )}
        <Button intent="ghost" size="sm" onClick={onSignOut} className="px-0">
          Sign out
        </Button>
      </div>
    </>
  );
}

function PlatformShell({
  email,
  children,
}: {
  email: string | null;
  children: React.ReactNode;
}) {
  const identity = useDashboardIdentity();
  const [location] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const signOut = () => {
    void identity.signOut();
  };

  return (
    <div
      className="admin-root min-h-screen lg:flex"
      style={{ backgroundColor: "hsl(var(--surface-1))" }}
    >
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:flex lg:flex-col w-64 shrink-0 sticky top-0 h-screen border-r"
        style={{
          borderColor: "hsl(var(--line-1))",
          backgroundColor: "hsl(var(--surface-2))",
        }}
      >
        <SidebarContent
          location={location}
          email={email}
          onSignOut={signOut}
          onNavigate={() => {}}
        />
      </aside>

      {/* Mobile drawer */}
      {mobileNavOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0"
            style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
            onClick={() => setMobileNavOpen(false)}
          />
          <div
            className="absolute inset-y-0 left-0 w-72 max-w-[80%] flex flex-col border-r shadow-xl"
            style={{
              borderColor: "hsl(var(--line-1))",
              backgroundColor: "hsl(var(--surface-2))",
            }}
          >
            <SidebarContent
              location={location}
              email={email}
              onSignOut={signOut}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar */}
        <header
          className="lg:hidden border-b flex items-center justify-between px-4 py-3"
          style={{
            borderColor: "hsl(var(--line-1))",
            backgroundColor: "hsl(var(--surface-2))",
          }}
        >
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
            className="inline-flex items-center justify-center rounded-md p-1.5"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="flex items-center gap-2">
            <span
              className="text-sm font-bold tracking-tight"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              CareMetric Breathe
            </span>
            <Badge variant="info">Platform</Badge>
          </div>
          <div className="w-7" />
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-8 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}

function PlatformConnectionTests() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Connection tests"
        description="Send a real test email, SMS, voice call, or AI chat to confirm the platform's SendGrid / Twilio / AI vendor credentials actually work."
      />
      <ConnectionTests />
    </div>
  );
}

// ── Gates ──────────────────────────────────────────────────────────

function PlatformConsole() {
  const { data, isPending, isError, error } = useGetPlatformMe({
    query: {
      // A 401/403 is terminal ("not a platform admin"), not a blip — don't
      // burn retries on it (same posture as AdminConsole's useGetAdminMe).
      retry: (failureCount, err) => {
        const status = err instanceof ApiError ? err.status : 0;
        if (status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  });

  if (isError) {
    const status = error instanceof ApiError ? error.status : 0;
    const reason: "not-configured" | "transient" | "not-authorized" =
      status === 503
        ? "not-configured"
        : status === 0 || (status >= 500 && status < 600)
          ? "transient"
          : "not-authorized";
    return <NotAuthorizedPage reason={reason} />;
  }

  if (isPending) {
    return (
      <div className="admin-root min-h-screen flex items-center justify-center">
        <Spinner label="Confirming platform access…" />
      </div>
    );
  }

  return (
    <PlatformShell email={data?.email ?? null}>
      <Switch>
        <Route path="/platform" component={PlatformDashboard} />
        <Route path="/platform/tenants" component={TenantDirectory} />
        <Route path="/platform/tenants/:id" component={TenantDetailPage} />
        <Route path="/platform/outreach" component={PlatformOutreachPage} />
        <Route path="/platform/billing" component={AdminPlatformBillingPage} />
        <Route path="/platform/support" component={PlatformSupport} />
        {/* Legacy "Fleet overview" URL — folded into the Dashboard. */}
        <Route path="/platform/overview">
          <Redirect to="/platform" replace />
        </Route>
        <Route path="/platform/integrations" component={GlobalIntegrations} />
        <Route
          path="/platform/connection-tests"
          component={PlatformConnectionTests}
        />
        <Route
          path="/platform/account-setup"
          component={AdminAccountSetupPage}
        />
        <Route path="/platform/system" component={PlatformSystemInfoPage} />
        <Route>
          <Redirect to="/platform" replace />
        </Route>
      </Switch>
    </PlatformShell>
  );
}

// Probes /resupply-api/auth/me; redirects to /admin/sign-in when no
// session is present (platform admins authenticate through the shared
// in-house admin auth).
export function PlatformConsoleRoute() {
  const { data, isPending } = authHooks.useSession();
  if (isPending) {
    return (
      <div className="admin-root min-h-screen flex items-center justify-center">
        <Spinner label="Checking sign-in…" />
      </div>
    );
  }
  if (!data) return <Redirect to="/admin/sign-in" />;
  return <PlatformConsole />;
}
