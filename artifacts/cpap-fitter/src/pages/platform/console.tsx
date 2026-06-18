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

import { useMemo, useState } from "react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";

import {
  ApiError,
  getListTenantsQueryKey,
  useGetPlatformMe,
  useListTenants,
  useCreateTenant,
  useSuspendTenant,
  useReactivateTenant,
  useImpersonateTenant,
  type PlatformTenant,
} from "@workspace/api-client-react/admin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
  formatMoney,
} from "@/lib/admin/platform-billing-api";
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

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() });
  }

  function onSuspend(t: PlatformTenant) {
    setActionError(null);
    setBusyId(t.id);
    suspend.mutate(t.id, {
      onSuccess: invalidate,
      onError: (err) => {
        setActionError(
          err instanceof ApiError && err.status === 400
            ? "The seed tenant can't be suspended."
            : "Couldn't suspend that tenant.",
        );
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

  function onImpersonate(t: PlatformTenant) {
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
        setBusyId(null);
      },
    });
  }

  const columns = useMemo<Column<PlatformTenant>[]>(
    () => [
      {
        key: "name",
        header: "Tenant",
        render: (t) => (
          <div>
            <div className="font-medium" style={{ color: "hsl(var(--ink-1))" }}>
              {t.name ?? t.slug}
            </div>
            <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {t.slug}
            </div>
          </div>
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
              <Button
                intent="secondary"
                size="sm"
                disabled={busy}
                isLoading={busy && impersonate.isPending}
                onClick={() => onImpersonate(t)}
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
                  isLoading={busy && suspend.isPending}
                  onClick={() => onSuspend(t)}
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
    [busyId, impersonate.isPending, suspend.isPending, reactivate.isPending],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenants"
        description="Every organization on the platform. Create, suspend, or operate one as support."
      />
      <CreateTenantCard />
      <Card title="Directory">
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
            rows={data?.tenants ?? []}
            rowKey={(t) => t.id}
            emptyState={
              <EmptyState
                title="No tenants yet."
                hint="Create the first tenant above."
              />
            }
          />
        )}
      </Card>
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
    `Orders (${days}d)`,
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
          <div>
            <div className="font-medium" style={{ color: "hsl(var(--ink-1))" }}>
              {t.name ?? t.slug}
            </div>
            <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {t.slug}
            </div>
          </div>
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
        header: "Orders",
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
                  label="New orders"
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

// ── Shell ──────────────────────────────────────────────────────────

function PlatformShell({
  email,
  children,
}: {
  email: string | null;
  children: React.ReactNode;
}) {
  const identity = useDashboardIdentity();
  return (
    <div
      className="admin-root min-h-screen"
      style={{ backgroundColor: "hsl(var(--surface-1))" }}
    >
      <header
        className="border-b"
        style={{
          borderColor: "hsl(var(--line-1))",
          backgroundColor: "hsl(var(--surface-2))",
        }}
      >
        <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span
              className="text-sm font-bold tracking-tight"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              CareMetric Breathe
            </span>
            <Badge variant="info">Platform</Badge>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="text-xs font-medium"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              Admin console
            </Link>
            {email && (
              <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                {email}
              </span>
            )}
            <Button
              intent="ghost"
              size="sm"
              onClick={() => {
                void identity.signOut();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <PlatformNav />
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}

const PLATFORM_NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/platform", label: "Dashboard" },
  { href: "/platform/tenants", label: "Tenants" },
  { href: "/platform/integrations", label: "Global integrations" },
  { href: "/platform/connection-tests", label: "Connection tests" },
];

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

function PlatformNav() {
  const [location] = useLocation();
  return (
    <nav
      className="border-b"
      style={{
        borderColor: "hsl(var(--line-1))",
        backgroundColor: "hsl(var(--surface-1))",
      }}
      aria-label="Platform navigation"
    >
      <div className="mx-auto max-w-5xl px-4 flex items-center gap-1">
        {PLATFORM_NAV.map((item) => {
          const active =
            item.href === "/platform"
              ? location === "/platform"
              : location === item.href || location.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className="text-xs font-medium px-3 py-2.5 -mb-px border-b-2"
              style={{
                color: active ? "hsl(var(--penn-navy))" : "hsl(var(--ink-3))",
                borderColor: active ? "hsl(var(--penn-navy))" : "transparent",
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
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
        {/* Legacy "Fleet overview" URL — folded into the Dashboard. */}
        <Route path="/platform/overview">
          <Redirect to="/platform" replace />
        </Route>
        <Route path="/platform/integrations" component={GlobalIntegrations} />
        <Route
          path="/platform/connection-tests"
          component={PlatformConnectionTests}
        />
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
