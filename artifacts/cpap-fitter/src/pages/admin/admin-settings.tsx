// /admin/settings (tenant) + the platform System-info page.
//
// This file exports TWO pages that share the system-info fetch helpers:
//
//   * AdminSettingsPage — the tenant /admin/settings page. Deployment
//     metadata is GLOBAL (it describes the whole CareMetric Breathe
//     deployment, not one tenant), so it now lives on the platform
//     super-admin console; the only thing a tenant admin manages here is
//     the client-only Demo mode toggle, which stays so it's reachable
//     from inside the tenant console.
//   * PlatformSystemInfoPage — read-only environment + deployment
//     metadata, mounted on the platform super-admin console
//     (/platform/system). All data comes from /admin/system-info.
//     Env-var VALUES are never returned by the backend; it renders
//     presence ("is this set?") booleans plus a few benign-to-display
//     values (Postgres version, server time, uptime, public URLs).
//
// Why deployment metadata is configuration-oriented (vs Operations,
// which is action-oriented vendor health): it's the kind of thing ops
// checks during incident triage or when onboarding a new admin.

import { useQuery } from "@tanstack/react-query";
import { useDemoMode } from "@/demo/DemoModeProvider";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { PageHeader } from "@/components/admin/PageHeader";

interface SystemInfo {
  server: {
    now: string;
    nodeVersion: string;
    pgVersion: string | null;
    uptimeSeconds: number;
    gitSha: string | null;
    nodeEnv: string | null;
  };
  database: {
    migrationCount: number | null;
    lastMigrationAt: string | null;
  };
  publicUrls: {
    shop: string | null;
    voice: string | null;
    dashboard: string | null;
  };
  auth: {
    adminAllowlistCount: number;
    agentAllowlistCount: number;
    legacyAdminAllowlistCount: number;
  };
  vendors: Record<string, Record<string, boolean>>;
  secrets: {
    linkHmacKeyConfigured: boolean;
  };
}

// Runtime shape guard. The renderer (`Body`) derefs every one of these
// nested objects directly, so a 200 response that is missing any of them
// would throw a raw `TypeError: Cannot read properties of undefined` mid-
// render — which bubbles to the top-level ErrorBoundary and shows the
// patient-facing "Something went wrong" screen instead of this page's own
// graceful inline error. This happens whenever the endpoint returns a
// well-formed-but-wrong body, e.g. the client-side demo sandbox's
// empty-object (`{}`) fallback for unhandled API GETs, or future backend
// shape drift (see the `encryption`-key regression that motivated
// admin-settings.render.test.tsx). Validating here turns that class of
// failure into `query.isError`, which renders the platform System-info
// page recoverably instead of crashing into the global ErrorBoundary.
export function isSystemInfo(value: unknown): value is SystemInfo {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  return (
    isObject(o.server) &&
    isObject(o.database) &&
    isObject(o.publicUrls) &&
    isObject(o.auth) &&
    isObject(o.vendors) &&
    isObject(o.secrets)
  );
}

export async function fetchSystemInfo(): Promise<SystemInfo> {
  const res = await fetch("/resupply-api/admin/system-info", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load system info (${res.status})`);
  const body = (await res.json()) as unknown;
  if (!isSystemInfo(body)) {
    throw new Error("System info response was missing expected fields");
  }
  return body;
}

// Tenant /admin/settings — just the client-only Demo mode toggle.
// Deployment metadata is global and lives on the platform console (see
// PlatformSystemInfoPage); a tenant admin has nothing deployment-level
// to configure here. Keeping the toggle on its own page (with no data
// fetch) means it can never be trapped behind a failed system-info load.
export function AdminSettingsPage() {
  return (
    <div className="space-y-6 max-w-5xl" data-testid="admin-settings-page">
      <PageHeader
        title="Settings"
        description="Toggle the client-only demo sandbox. Deployment metadata and vendor configuration live on the platform super-admin console."
      />
      <DemoModeCard />
    </div>
  );
}

// Platform /platform/system — read-only deployment metadata. Mounted on
// the super-admin console, gated by requirePlatformAdmin upstream.
export function PlatformSystemInfoPage() {
  const query = useQuery({
    queryKey: ["admin-system-info"],
    queryFn: fetchSystemInfo,
  });

  return (
    <div className="space-y-6 max-w-5xl" data-testid="platform-system-info-page">
      <PageHeader
        title="System info"
        description={`Deployment metadata, vendor configuration, and secret presence. Read-only — env-var values are never surfaced; only "is this set?" booleans plus a few benign-to-display fields.`}
      />
      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <ErrorPanel
          error={query.error}
          onRetry={() => void query.refetch()}
          title="Couldn't load system info"
        />
      ) : query.data ? (
        <Body data={query.data} />
      ) : null}
    </div>
  );
}

// Demo / live mode toggle. Demo mode is a CLIENT-ONLY sandbox (see
// src/demo/*): when ON, a fetch interceptor answers every same-origin
// API call from in-browser fixtures instead of the real backend, so the
// whole site renders simulated data with no PHI and no orders placed.
// This card is the single place to flip it — it replaces the old global
// page banner. Flipping reloads the page so every data consumer (React
// Query caches, the in-memory demo store, the auth probe) re-resolves
// against the chosen source.
function DemoModeCard() {
  const { isDemo, enterDemo, exitDemo } = useDemoMode();

  return (
    <Card title="Demo mode">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-slate-700">
            {isDemo ? (
              <>
                <span className="font-semibold text-amber-700">On</span> — the
                site is showing simulated data. Nothing is real and no orders
                are placed.
              </>
            ) : (
              <>
                <span className="font-semibold text-emerald-700">Off</span> —
                the site is showing live data.
              </>
            )}
          </p>
          <p className="text-xs text-slate-500 max-w-xl">
            Demo mode is a client-only sandbox stored in this browser. Toggling
            it reloads the page so every surface re-resolves against the chosen
            data source. It never touches the live backend or real customer
            data.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isDemo}
          aria-label="Toggle demo mode"
          onClick={isDemo ? exitDemo : enterDemo}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-amber-500 ${
            isDemo ? "bg-amber-500" : "bg-slate-300"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              isDemo ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
    </Card>
  );
}

function Body({ data }: { data: SystemInfo }) {
  const uptimeLabel = formatUptime(data.server.uptimeSeconds);
  // Migration bookkeeping lives in a schema only the deploy migrator
  // can reach — null means "not tracked here", which must not render
  // as the alarming "0 / never".
  const migrationsApplied =
    data.database.migrationCount === null
      ? "Not tracked here — see deploy logs or the Supabase dashboard"
      : String(data.database.migrationCount);
  const lastMigration = data.database.lastMigrationAt
    ? new Date(data.database.lastMigrationAt).toLocaleString()
    : data.database.migrationCount === null
      ? "Not tracked here"
      : "never";

  return (
    <div className="space-y-6">
      <Card title="Server">
        <DefList
          rows={[
            ["Environment", data.server.nodeEnv ?? "(unset)"],
            ["Server time (UTC)", new Date(data.server.now).toISOString()],
            ["Uptime", uptimeLabel],
            ["Node version", data.server.nodeVersion],
            ["Postgres version", data.server.pgVersion ?? "unknown"],
            ["Git commit", data.server.gitSha ?? "(not provided)"],
          ]}
        />
      </Card>

      <Card title="Database">
        <DefList
          rows={[
            ["Migrations applied", migrationsApplied],
            ["Last migration", lastMigration],
          ]}
        />
      </Card>

      <Card title="Public URLs">
        <DefList
          rows={[
            ["Shop", data.publicUrls.shop ?? "(unset)"],
            ["Voice / dashboard fallback", data.publicUrls.voice ?? "(unset)"],
            ["Admin dashboard", data.publicUrls.dashboard ?? "(unset)"],
          ]}
        />
      </Card>

      <Card title="Admin allowlists (env vars)">
        <DefList
          rows={[
            [
              "Admin emails",
              `${data.auth.adminAllowlistCount} bootstrap admin${data.auth.adminAllowlistCount === 1 ? "" : "s"}`,
            ],
            [
              "Agent emails",
              `${data.auth.agentAllowlistCount} bootstrap agent${data.auth.agentAllowlistCount === 1 ? "" : "s"}`,
            ],
            ...((data.auth.legacyAdminAllowlistCount > 0
              ? [
                  [
                    "Legacy RESUPPLY_OPERATOR_EMAILS",
                    `${data.auth.legacyAdminAllowlistCount} entries (deprecated — rename to RESUPPLY_ADMIN_EMAILS)`,
                  ] as [string, string],
                ]
              : []) as Array<[string, string]>),
          ]}
        />
        <p className="text-xs text-slate-500 mt-2">
          DB-backed members managed via{" "}
          <a className="underline decoration-dotted" href="/admin/team">
            /admin/team
          </a>{" "}
          layer on top of these env-var bootstrap lists.
        </p>
      </Card>

      <VendorCard vendors={data.vendors} />

      <Card title="Secrets">
        <DefList
          rows={[["Link HMAC key", flag(data.secrets.linkHmacKeyConfigured)]]}
        />
        <p className="text-xs text-slate-500 mt-2">
          Signs short-lived patient links in SMS/email reminders. MUST be set in
          production. The dashboard displays presence only — never the key value
          or any fingerprint.
        </p>
      </Card>
    </div>
  );
}

function flag(b: boolean): string {
  return b ? "✓ configured" : "⚠ not configured";
}

function VendorCard({ vendors }: { vendors: SystemInfo["vendors"] }) {
  const sections = Object.entries(vendors);
  return (
    <Card title="Vendors">
      <div className="grid sm:grid-cols-2 gap-3">
        {sections.map(([name, flags]) => (
          <div
            key={name}
            className="rounded border border-slate-200 bg-slate-50 p-3"
          >
            <div className="text-sm font-semibold text-slate-900 capitalize mb-1">
              {name.replace(/([A-Z])/g, " $1").trim()}
            </div>
            <ul className="text-xs space-y-0.5">
              {Object.entries(flags).map(([k, v]) => (
                <li key={k} className="flex justify-between gap-2">
                  <span className="text-slate-600">
                    {k.replace(/([A-Z])/g, " $1").trim()}
                  </span>
                  <span
                    className={
                      v ? "text-emerald-700 font-semibold" : "text-amber-700"
                    }
                  >
                    {v ? "✓" : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function DefList({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-600">{k}</dt>
          <dd className="font-mono text-slate-900 break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}
