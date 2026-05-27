// Reset-password page — consumes a `?token=…` URL param and lets
// the user choose a new password.
//
// Success state is "redirect to /sign-in" — the server has
// revoked every active session for the user, so even a tab that
// was already signed in is now logged out.

import "@/admin.css";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { authErrorMessage } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/admin/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";

const basePath = "/admin";

function readTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

// Strip ?token=... from the address bar so the single-use secret
// doesn't linger in browser history, autocomplete, or screenshots.
function stripTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("token")) return;
    params.delete("token");
    const qs = params.toString();
    const next =
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", next);
  } catch {
    // History API not available: no-op.
  }
}

export function ResetPasswordPage() {
  const token = useMemo(readTokenFromUrl, []);
  useEffect(stripTokenFromUrl, []);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(
    token
      ? null
      : "This page expects a reset link from your email. Check your inbox and click the link there.",
  );
  const reset = authHooks.useResetPassword();
  const [, setLocation] = useLocation();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Skip a second submission while the first is still in flight.
    // The button is also disabled on isPending, but a fast double-
    // click can fire two onSubmits before React re-renders.
    if (reset.isPending) return;
    setSubmitError(null);
    if (password !== confirm) {
      setSubmitError("The two passwords don't match.");
      return;
    }
    reset.mutate(
      { token, password },
      {
        onSuccess: () => setLocation("/admin/sign-in"),
        onError: (err) => {
          setSubmitError(
            authErrorMessage(err, {
              action: "reset your password",
              subject: "reset link",
              fallback: "Could not reset your password.",
            }),
          );
        },
      },
    );
  }

  return (
    <AuthLayout variant="admin">
      <form
        onSubmit={onSubmit}
        className="admin-root w-full max-w-sm rounded-lg shadow-sm border p-6 space-y-4 bg-white"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <h1
          className="text-xl font-semibold"
          style={{ color: "hsl(var(--penn-navy-deep))" }}
        >
          Choose a new password
        </h1>

        <label className="block text-sm">
          <span className="font-medium">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          />
          <span
            className="block text-xs mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            At least 12 characters.
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Confirm new password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          />
        </label>

        {submitError && (
          <p
            role="alert"
            className="text-sm rounded-md px-3 py-2"
            style={{
              backgroundColor: "hsl(0 70% 96%)",
              color: "hsl(0 70% 30%)",
            }}
          >
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={reset.isPending || !token}
          className="w-full rounded-md text-white font-semibold py-2 text-sm"
          style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
        >
          {reset.isPending ? "Saving…" : "Set new password"}
        </button>

        <p className="text-xs text-center">
          <Link
            href={`${basePath}/sign-in`}
            style={{ color: "hsl(var(--penn-navy-deep))" }}
            className="underline"
          >
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
