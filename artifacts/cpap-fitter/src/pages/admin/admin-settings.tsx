// /admin/settings — read-only environment + deployment metadata.
//
// All data comes from /admin/system-info. Env-var values are never
// returned by the backend; this page only renders presence ("is this
// set?") booleans plus a few benign-to-display values (Postgres
// version, server time, uptime, public URLs).
//
// Why a Settings page exists separately from Operations:
//   * Operations is action-oriented: vendor health (am I broken
//     right now?) and dispatcher buttons.
//   * Settings is configuration-oriented: deployment metadata,
//     allowlist sizes, encryption-key presence, etc. — the kind
//     of stuff ops checks during incident triage or onboarding a
//     new admin.

import { useQuery } from "@tanstack/react-query";

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
    migrationCount: number;
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
  encryption: {
    phiKeyConfigured: boolean;
    phoneHmacKeyConfigured: boolean;
  };
}

async function fetchSystemInfo(): Promise<SystemInfo> {
  const res = await fetch("/resupply-api/admin/system-info", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load system info (${res.status})`);
  return (await res.json()) as SystemInfo;
}

export function AdminSettingsPage() {
  const query = useQuery({
    queryKey: ["admin-system-info"],
    queryFn: fetchSystemInfo,
  });

  return (
    <div className="space-y-6 max-w-5xl" data-testid="admin-settings-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Settings
        </h1>
        <p className="text-sm text-slate-600">
          Deployment metadata, vendor configuration, and encryption-key
          presence. Read-only — env-var values are never surfaced; only "is this
          set?" booleans plus a few benign-to-display fields.
        </p>
      </header>
      {query.isPending ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : query.isError ? (
        <div className="text-sm text-rose-700" role="alert">
          Couldn&apos;t load system info:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}.
        </div>
      ) : query.data ? (
        <Body data={query.data} />
      ) : null}
    </div>
  );
}

function Body({ data }: { data: SystemInfo }) {
  const uptimeLabel = formatUptime(data.server.uptimeSeconds);
  const lastMigration = data.database.lastMigrationAt
    ? new Date(data.database.lastMigrationAt).toLocaleString()
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
            ["Migrations applied", String(data.database.migrationCount)],
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

      <Card title="Encryption keys">
        <DefList
          rows={[
            ["PHI encryption key", flag(data.encryption.phiKeyConfigured)],
            ["Phone HMAC key", flag(data.encryption.phoneHmacKeyConfigured)],
          ]}
        />
        <p className="text-xs text-slate-500 mt-2">
          Both keys MUST be set in production. The dashboard displays presence
          only — never the key value or any fingerprint.
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
