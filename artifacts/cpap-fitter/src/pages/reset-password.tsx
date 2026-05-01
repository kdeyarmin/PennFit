// Reset-password landing for the cpap-fitter shop. Consumes a
// `?token=…` URL param. On success the server has revoked every
// active session for the user, so we redirect back to /sign-in
// instead of auto-signing-in.

import { useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { AuthError } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/auth-hooks";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function readTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

export function ResetPasswordPage() {
  const token = useMemo(readTokenFromUrl, []);
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
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg shadow-sm border bg-white p-6 space-y-4"
      >
        <h1 className="text-xl font-semibold">Choose a new password</h1>

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
          />
          <span className="block text-xs mt-1 text-muted-foreground">
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
          />
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
          disabled={reset.isPending || !token}
          className="w-full rounded-md bg-[hsl(var(--penn-navy-deep))] text-white font-semibold py-2 text-sm"
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
    </div>
  );
}
