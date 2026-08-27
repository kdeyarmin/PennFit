// Shared UI primitives for the provider e-signature portal.
//
// The portal is intentionally self-contained and styled with the
// standard Tailwind palette (slate / blue / emerald / amber / red)
// rather than the storefront's shadcn tokens or the admin theme — so it
// can never clobber either (see CLAUDE.md "Admin theme stays scoped").
// Everything renders inside a `.provider-portal` namespace wrapper.

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, ShieldCheck } from "lucide-react";

import { providerAuthHooks } from "@/lib/provider/provider-auth";
import {
  getProviderOrgs,
  selectProviderOrg,
  ProviderApiError,
  type ProviderOrgMembership,
} from "@/lib/provider/provider-api";
import { isPlatformHomeHost } from "@/lib/platform-host";
import { PLATFORM_NAME } from "@/lib/branding";
import { formatAppDateTime } from "@/lib/utils";

/** Pure gate: chrome switcher only on platform home with 2+ memberships. */
export function shouldShowProviderOrgSwitcher(
  isPlatformHost: boolean,
  orgCount: number,
): boolean {
  return isPlatformHost && orgCount > 1;
}

/**
 * Other linked DMEs with a verified portal URL, excluding the practice
 * that owns the current hostname. Used for tenant-host honesty chrome
 * (deep-link only — brand host still wins for PHI on this host).
 */
export function otherTenantPortalLinks(
  orgs: readonly ProviderOrgMembership[],
  currentHostname: string,
): ProviderOrgMembership[] {
  const bare = currentHostname
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  return orgs.filter((o) => {
    if (!o.hasVerifiedPortal || !o.portalUrl) return false;
    try {
      const host = new URL(o.portalUrl).hostname
        .toLowerCase()
        .replace(/^www\./, "");
      return host !== bare;
    } catch {
      return false;
    }
  });
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  const styles: Record<string, string> = {
    primary:
      "bg-blue-700 text-white hover:bg-blue-800 disabled:bg-blue-300 shadow-sm",
    secondary:
      "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:opacity-60",
    ghost: "bg-transparent text-slate-600 hover:bg-slate-100",
    danger:
      "bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:opacity-60",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${styles[variant]} ${className}`}
      {...props}
    />
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-amber-100 text-amber-800 ring-amber-200",
    signed: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    declined: "bg-red-100 text-red-700 ring-red-200",
    void: "bg-slate-100 text-slate-600 ring-slate-200",
    expired: "bg-slate-100 text-slate-600 ring-slate-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${
        map[status] ?? "bg-slate-100 text-slate-600 ring-slate-200"
      }`}
    >
      {status}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-slate-500">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
      {label ? <span className="text-sm">{label}</span> : null}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {children}
    </div>
  );
}

/** Top-level provider navigation: Documents (e-sign queue) and My
 *  patients (RTM dashboard). Highlights the active section. */
function ProviderNav() {
  const [location] = useLocation();
  const tabs: { href: string; label: string; active: boolean }[] = [
    {
      href: "/provider",
      label: "Documents",
      active:
        location === "/provider" ||
        location === "/" ||
        location.startsWith("/provider/sign"),
    },
    {
      href: "/provider/referrals",
      label: "Referrals",
      active: location.startsWith("/provider/referrals"),
    },
    {
      href: "/provider/patients",
      label: "My patients",
      active: location.startsWith("/provider/patients"),
    },
  ];
  return (
    <nav className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center gap-1 px-4">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
              t.active
                ? "border-blue-700 text-blue-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** Authenticated-page chrome: header with brand, provider name, sign-out. */
export function ProviderShell({
  providerName,
  children,
}: {
  providerName?: string | null;
  children: ReactNode;
}) {
  const signOut = providerAuthHooks.useSignOut();
  return (
    <div className="provider-portal min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3.5">
          <Link
            href="/provider"
            className="flex items-center gap-2.5 font-semibold text-slate-900"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-700 text-white">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm">Provider Portal</span>
              <span className="text-[11px] font-normal uppercase tracking-wider text-slate-400">
                {PLATFORM_NAME}
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <ProviderOrgSwitcher />
            <ProviderTenantOrgLinks />
            {providerName ? (
              <span className="hidden text-sm text-slate-600 sm:inline">
                {providerName}
              </span>
            ) : null}
            <Button
              variant="ghost"
              onClick={() =>
                signOut.mutate(undefined, {
                  onSettled: () => {
                    window.location.assign("/provider/sign-in");
                  },
                })
              }
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <ProviderNav />
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}

/**
 * Platform-host only: re-select which linked DME's queue/RTM the session
 * pin resolves. Hidden on tenant brand hosts (brand always wins for PHI)
 * and when the provider has fewer than two memberships.
 */
function ProviderOrgSwitcher() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onPlatform = isPlatformHomeHost();

  const orgs = useQuery({
    queryKey: ["provider", "orgs"],
    queryFn: getProviderOrgs,
    enabled: onPlatform,
    retry: false,
    staleTime: 30_000,
  });

  const list = orgs.data?.orgs ?? [];
  if (!shouldShowProviderOrgSwitcher(onPlatform, list.length)) {
    return null;
  }

  const activeOrgId =
    orgs.data?.activeOrgId ??
    list.find((o) => o.isActive)?.orgId ??
    list[0]!.orgId;

  async function onChange(orgId: string) {
    if (orgId === activeOrgId || busy) return;
    setError(null);
    setBusy(true);
    try {
      await selectProviderOrg(orgId);
      await queryClient.invalidateQueries({ queryKey: ["provider"] });
    } catch (err) {
      setError(
        err instanceof ProviderApiError
          ? err.message
          : "Could not switch practice.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-[12rem] flex-col items-end gap-0.5 sm:max-w-[14rem]">
      <label className="sr-only" htmlFor="provider-org-switcher">
        Active DME practice
      </label>
      <select
        id="provider-org-switcher"
        data-testid="provider-org-switcher"
        className="w-full truncate rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-800 disabled:opacity-60"
        disabled={busy || orgs.isFetching}
        value={activeOrgId}
        onChange={(e) => void onChange(e.target.value)}
      >
        {list.map((org) => (
          <option key={org.dmeLinkId} value={org.orgId}>
            {org.name}
          </option>
        ))}
      </select>
      {error ? (
        <span className="text-[10px] text-red-600" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Tenant brand host only: deep-links to *other* linked practices' verified
 * portals. Does not call /orgs/select — brand host still owns PHI here;
 * leaving means a new host (and usually a fresh sign-in).
 */
function ProviderTenantOrgLinks() {
  const onPlatform = isPlatformHomeHost();
  const orgs = useQuery({
    queryKey: ["provider", "orgs"],
    queryFn: getProviderOrgs,
    enabled: !onPlatform,
    retry: false,
    staleTime: 30_000,
  });

  if (onPlatform) return null;
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  const others = otherTenantPortalLinks(orgs.data?.orgs ?? [], hostname);
  if (others.length === 0) return null;

  return (
    <div
      className="hidden max-w-[11rem] flex-col items-end sm:flex"
      data-testid="provider-tenant-org-links"
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
        Other practices
      </span>
      <ul className="mt-0.5 space-y-0.5 text-right">
        {others.map((org) => (
          <li key={org.dmeLinkId}>
            <a
              href={org.portalUrl!}
              className="block truncate text-xs font-medium text-blue-700 hover:underline"
              title={`Open ${org.name} (you'll sign in on that domain)`}
            >
              {org.name}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Centered card layout for the sign-in / MFA screens. */
export function ProviderAuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="provider-portal flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-10 text-slate-900">
      <div className="mb-6 flex items-center gap-2.5 font-semibold">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-700 text-white">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-base">Provider Portal</span>
          <span className="text-[11px] font-normal uppercase tracking-wider text-slate-400">
            {PLATFORM_NAME}
          </span>
        </span>
      </div>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return formatAppDateTime(value, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
