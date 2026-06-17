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
  fetchFleetOverview,
  fetchPlatformConfig,
  setPlatformConfig,
  type FleetTenant,
  type PlatformConfigSetting,
} from "@/lib/admin/platform-config-api";
import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ConnectionTests } from "@/components/admin/ConnectionTests";
import { EmptyState } from "@/components/admin/EmptyState";
import { Input, Label } from "@/components/admin/Input";
import { PageHeader } from "@/components/admin/PageHeader";
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

// ── Fleet overview (cross-tenant aggregates — no PHI) ──────────────

function fmtCount(v: number | null | undefined): string {
  return v == null ? "—" : v.toLocaleString();
}

function FleetOverview() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["platform-overview"],
    queryFn: fetchFleetOverview,
  });

  const columns = useMemo<Column<FleetTenant>[]>(
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
        key: "status",
        header: "Status",
        render: (t) => (
          <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
        ),
      },
      {
        key: "patients",
        header: "Patients",
        className: "text-right tabular-nums",
        render: (t) => fmtCount(t.usage.patients),
      },
      {
        key: "orders",
        header: "Orders",
        className: "text-right tabular-nums",
        render: (t) => fmtCount(t.usage.orders),
      },
      {
        key: "conversations",
        header: "Conversations",
        className: "text-right tabular-nums",
        render: (t) => fmtCount(t.usage.conversations),
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fleet overview"
        description="Headline activity across every tenant. Aggregate counts only — no patient data is shown here. To see a tenant's actual records, impersonate it from the Tenants tab (audited)."
      />
      <Card title="All tenants">
        {isPending ? (
          <Spinner label="Loading fleet…" />
        ) : isError ? (
          <EmptyState
            title="Couldn't load the fleet overview."
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
          <Table<FleetTenant>
            columns={columns}
            rows={data?.tenants ?? []}
            rowKey={(t) => t.id}
            emptyState={<EmptyState title="No tenants yet." />}
          />
        )}
      </Card>
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
  { href: "/platform", label: "Tenants" },
  { href: "/platform/overview", label: "Fleet overview" },
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
              ? location === "/platform" || location === "/platform/tenants"
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
        <Route path="/platform" component={TenantDirectory} />
        <Route path="/platform/tenants" component={TenantDirectory} />
        <Route path="/platform/overview" component={FleetOverview} />
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
