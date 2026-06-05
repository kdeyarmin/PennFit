// /admin/system/configuration — super-admin System Configuration.
//
// Enter and rotate integration credentials + platform secrets that
// historically lived only as Railway env vars (AI vendors, Twilio,
// SendGrid, Stripe, therapy-cloud OAuth, Office Ally).
//
// super_admin only — the nav entry is gated on `system.config.manage`
// and the backend returns 403 to every other role.
//
// Secret handling: the server NEVER returns secret plaintext. Each
// secret shows a masked last-4 hint; saving is write-only (the field
// clears on success and we re-fetch the masked state). Non-secret
// config (URLs, IDs) is shown in full so it can be verified.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  KeyRound,
  RotateCcw,
  Save,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import {
  type AppConfigActivity,
  type AppConfigSettingView,
  clearConfigValue,
  getSystemConfig,
  getSystemConfigActivity,
  setConfigValue,
} from "@/lib/admin/app-config-api";

const queryKey = ["admin", "system", "config"] as const;
const activityKey = ["admin", "system", "config", "activity"] as const;

export function AdminSystemConfigurationPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: getSystemConfig,
  });
  const [search, setSearch] = useState("");
  const [onlyUnset, setOnlyUnset] = useState(false);

  const categories = data?.categories ?? [];
  const allSettings = categories.flatMap((c) => c.settings);
  const configuredCount = allSettings.filter((s) => s.configured).length;

  const q = search.trim().toLowerCase();
  const visibleCategories = categories
    .map((cat) => ({
      category: cat.category,
      total: cat.settings.length,
      configured: cat.settings.filter((s) => s.configured).length,
      settings: cat.settings.filter((s) => {
        if (onlyUnset && s.configured) return false;
        if (!q) return true;
        return (
          s.label.toLowerCase().includes(q) ||
          s.key.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q)
        );
      }),
    }))
    .filter((cat) => cat.settings.length > 0);

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header className="space-y-1">
        <h1
          className="text-2xl font-semibold flex items-center gap-2"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          <SlidersHorizontal className="h-6 w-6" /> System Configuration
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Enter and rotate integration credentials and platform secrets.
          Restricted to super-admins.
        </p>
      </header>

      <SecurityNotice overlayDisabled={data?.overlayDisabled ?? false} />

      {isPending ? (
        <Spinner label="Loading configuration…" />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[220px]">
              <Input
                type="search"
                placeholder="Filter settings by name or key…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Filter settings"
              />
            </div>
            <label
              className="flex items-center gap-1.5 text-sm select-none"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              <input
                type="checkbox"
                checked={onlyUnset}
                onChange={(e) => setOnlyUnset(e.target.checked)}
              />
              Only unset
            </label>
            <span
              className="text-xs whitespace-nowrap"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {configuredCount} of {allSettings.length} configured
            </span>
          </div>

          {visibleCategories.length === 0 ? (
            <Card>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                No settings match the current filter.
              </p>
            </Card>
          ) : (
            visibleCategories.map((cat) => (
              <Card
                key={cat.category}
                title={cat.category}
                subtitle={`${cat.configured} of ${cat.total} configured`}
              >
                <div>
                  {cat.settings.map((s) => (
                    <SettingRow key={s.key} setting={s} />
                  ))}
                </div>
              </Card>
            ))
          )}
          <RecentActivity />
        </>
      )}
    </div>
  );
}

function SecurityNotice({ overlayDisabled }: { overlayDisabled: boolean }) {
  return (
    <div
      className="rounded-lg border px-4 py-3 text-sm space-y-1.5"
      style={{
        backgroundColor: "hsl(38 95% 48% / 0.08)",
        borderColor: "hsl(38 95% 48% / 0.35)",
        color: "hsl(var(--ink-2))",
      }}
      role="note"
    >
      <p
        className="font-semibold flex items-center gap-1.5"
        style={{ color: "hsl(38 80% 28%)" }}
      >
        <ShieldAlert className="h-4 w-4" /> How values are stored
      </p>
      <ul className="list-disc pl-5 space-y-1">
        <li>
          Saved values are kept server-side (service-role only) and{" "}
          <strong>never shown back in the browser</strong>. Secrets display a
          masked last-4 hint only.
        </li>
        <li>
          A saved value <strong>takes precedence over</strong> the matching
          Railway environment variable. Use <em>Clear</em> to fall back to the
          environment.
        </li>
        <li>
          <Badge variant="neutral">Applies live</Badge> settings (therapy cloud)
          take effect within seconds.{" "}
          <Badge variant="muted">Applies on next deploy</Badge> settings are
          picked up at the next service restart.
        </li>
      </ul>
      {overlayDisabled && (
        <p
          className="flex items-center gap-1.5 font-medium"
          style={{ color: "hsl(354 75% 38%)" }}
        >
          <AlertTriangle className="h-4 w-4" /> The configuration overlay is
          currently DISABLED (APP_CONFIG_OVERLAY_DISABLED). Saved values are
          stored but will not be applied until it is re-enabled.
        </p>
      )}
    </div>
  );
}

function SourceBadge({ setting }: { setting: AppConfigSettingView }) {
  if (setting.source === "db") {
    return <Badge variant="success">Saved here</Badge>;
  }
  if (setting.source === "env") {
    return <Badge variant="info">From environment</Badge>;
  }
  return <Badge variant="muted">Not set</Badge>;
}

function ApplyModeBadge({ setting }: { setting: AppConfigSettingView }) {
  return setting.applyMode === "live" ? (
    <Badge variant="neutral">Applies live</Badge>
  ) : (
    <Badge variant="muted">Applies on next deploy</Badge>
  );
}

function SettingRow({ setting }: { setting: AppConfigSettingView }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey });
    void qc.invalidateQueries({ queryKey: activityKey });
  };

  const save = useMutation({
    mutationFn: () => setConfigValue(setting.key, value),
    onSuccess: () => {
      setValue("");
      invalidate();
    },
  });

  const clear = useMutation({
    mutationFn: () => clearConfigValue(setting.key),
    onSuccess: invalidate,
  });

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && !save.isPending;

  return (
    <div
      className="grid gap-3 border-t pt-3.5 pb-3.5 first:border-t-0 first:pt-0 md:grid-cols-[minmax(0,1fr)_320px] md:items-start"
      style={{ borderColor: "hsl(var(--line-2))" }}
    >
      {/* Left — identity + help */}
      <div className="space-y-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium" style={{ color: "hsl(var(--ink-1))" }}>
            {setting.label}
          </span>
          {setting.secret && (
            <KeyRound
              className="h-3.5 w-3.5"
              style={{ color: "hsl(var(--ink-3))" }}
              aria-label="secret"
            />
          )}
          <SourceBadge setting={setting} />
          <ApplyModeBadge setting={setting} />
        </div>
        <code className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {setting.key}
        </code>
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {setting.description}
        </p>
        {setting.hint && (
          <p className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
            Current:{" "}
            <span className="font-mono" style={{ color: "hsl(var(--ink-1))" }}>
              {setting.hint}
            </span>
            {setting.source === "db" && setting.envProvided && (
              <span style={{ color: "hsl(var(--ink-3))" }}>
                {" "}
                · also set in environment (overridden)
              </span>
            )}
            {setting.source === "db" && setting.updatedByEmail && (
              <span style={{ color: "hsl(var(--ink-3))" }}>
                {" "}
                · by {setting.updatedByEmail}
              </span>
            )}
          </p>
        )}
        {setting.formatValid === false && (
          <p
            className="text-xs flex items-center gap-1"
            style={{ color: "hsl(38 80% 28%)" }}
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            Format looks unexpected
            {setting.formatHint ? ` — expected ${setting.formatHint}` : ""}.
          </p>
        )}
      </div>

      {/* Right — edit controls */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Input
            type={setting.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              setting.placeholder ??
              (setting.configured ? "Enter a new value to replace" : "Not set")
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`New value for ${setting.label}`}
          />
          <Button
            intent="secondary"
            size="sm"
            disabled={!canSave}
            isLoading={save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="h-3.5 w-3.5" /> Save
          </Button>
        </div>
        <div className="flex items-center gap-3 min-h-[18px]">
          {setting.source === "db" && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs hover:underline disabled:opacity-50"
              style={{ color: "hsl(354 75% 38%)" }}
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              <RotateCcw className="h-3 w-3" /> Clear saved value
            </button>
          )}
          {save.isSuccess && !save.isPending && (
            <span
              className="inline-flex items-center gap-1 text-xs font-medium"
              style={{ color: "hsl(152 70% 24%)" }}
            >
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
          {save.isError && (
            <span className="text-xs" style={{ color: "hsl(354 75% 38%)" }}>
              {errorMessage(save.error)}
            </span>
          )}
          {clear.isError && (
            <span className="text-xs" style={{ color: "hsl(354 75% 38%)" }}>
              {errorMessage(clear.error)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function RecentActivity() {
  const { data } = useQuery({
    queryKey: activityKey,
    queryFn: () => getSystemConfigActivity(15),
  });
  const rows = data?.activity ?? [];
  return (
    <Card title="Recent activity">
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No configuration changes recorded yet.
        </p>
      ) : (
        <ul className="divide-y" style={{ borderColor: "hsl(var(--line-2))" }}>
          {rows.map((a, i) => (
            <li
              key={`${a.key}-${a.occurredAt}-${i}`}
              className="px-5 py-2.5 text-sm flex items-center justify-between gap-3"
            >
              <span style={{ color: "hsl(var(--ink-2))" }}>
                <ActivityVerb a={a} />{" "}
                <span
                  className="font-medium"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {a.label}
                </span>{" "}
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  ({a.category})
                </span>
              </span>
              <span
                className="text-xs whitespace-nowrap"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {a.operatorEmail ?? "system"} ·{" "}
                {new Date(a.occurredAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ActivityVerb({ a }: { a: AppConfigActivity }) {
  if (a.action === "clear") {
    return <span style={{ color: "hsl(354 75% 38%)" }}>Cleared</span>;
  }
  return (
    <span style={{ color: "hsl(152 70% 24%)" }}>
      {a.hadPrevious ? "Updated" : "Set"}
    </span>
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return "Something went wrong. Try again.";
}
