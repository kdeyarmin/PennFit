// Reset-password landing for the cpap-fitter shop. Consumes a
// `?token=…` URL param. On success the server has revoked every
// active session for the user, so we redirect back to /sign-in
// instead of auto-signing-in.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { AuthError } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";
import { PasswordInput } from "@/components/password-input";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function readTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

// Strip ?token=... from the address bar so it doesn't persist in
// browser history, autocomplete, shareable URLs, or screenshots.
// Single-use server tokens are still consumed, but they shouldn't
// linger as a recoverable secret after the page handles them.
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

  // Inline mismatch warning that mirrors the sign-up form: only
  // shown after the confirm field has content, so the field doesn't
  // flag itself as wrong on first focus.
  const passwordsMismatch = confirm.length > 0 && confirm !== password;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Skip a second submission while the first is still in flight —
    // the button is also disabled on isPending, but a quick double-
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
        onSuccess: () => setLocation("/sign-in"),
        onError: (err) => {
          setSubmitError(
            err instanceof AuthError
              ? err.userMessage
              : "Could not reset your password.",
          );
        },
      },
    );
  }

  return (
    <AuthLayout variant="customer">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg shadow-sm border bg-white p-6 space-y-4"
      >
        <h1 className="text-xl font-semibold">Choose a new password</h1>

        <label className="block text-sm">
          <span className="font-medium">New password</span>
          <PasswordInput
            autoComplete="new-password"
            minLength={12}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            showStrength
            helperText="At least 12 characters. Longer is stronger — passphrases of 4+ random words work great."
            inputTestId="reset-password-input"
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium">Confirm new password</span>
          <PasswordInput
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            inputTestId="reset-confirm-password-input"
            aria-invalid={passwordsMismatch || undefined}
          />
          {passwordsMismatch && (
            <span
              className="block text-xs mt-1 text-rose-700"
              role="alert"
              data-testid="reset-confirm-mismatch"
            >
              Passwords don&apos;t match.
            </span>
          )}
        </label>

        {submitError && (
          <p
            role="alert"
            className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-900"
          >
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={reset.isPending || !token || passwordsMismatch}
          className="w-full rounded-md bg-[hsl(var(--penn-navy-deep))] text-white font-semibold py-2 text-sm disabled:opacity-60"
        >
          {reset.isPending ? "Saving…" : "Set new password"}
        </button>

        <p className="text-xs text-center">
          <Link
            href={`${basePath}/sign-in`}
            className="underline text-[hsl(var(--penn-navy-deep))]"
          >
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
