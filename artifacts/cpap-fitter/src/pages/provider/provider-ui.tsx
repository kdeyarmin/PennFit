// Shared UI primitives for the provider e-signature portal.
//
// The portal is intentionally self-contained and styled with the
// standard Tailwind palette (slate / blue / emerald / amber / red)
// rather than the storefront's shadcn tokens or the admin theme — so it
// can never clobber either (see CLAUDE.md "Admin theme stays scoped").
// Everything renders inside a `.provider-portal` namespace wrapper.

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "wouter";
import { LogOut, ShieldCheck } from "lucide-react";

import { providerAuthHooks } from "@/lib/provider/provider-auth";

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
                Penn Home Medical Supply
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-3">
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
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
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
            Penn Home Medical Supply
          </span>
        </span>
      </div>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
