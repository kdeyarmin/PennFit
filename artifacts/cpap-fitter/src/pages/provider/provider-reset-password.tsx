// Provider portal set-password / reset-password landing.
//
// Provider invites mint a password_reset token and used to deep-link to
// the PATIENT storefront `/reset-password`, which on success dumped
// clinicians onto `/sign-in` with patient order-history copy. This page
// uses the provider auth mount and returns them to `/provider/sign-in`.
// There is intentionally no self-service "forgot password" for providers
// (recovery goes through the practice coordinator) — the no-token state
// tells them to request a fresh invite rather than linking to a patient
// forgot-password flow.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { authErrorMessage } from "@workspace/resupply-auth-react";

import { providerAuthHooks } from "@/lib/provider/provider-auth";
import { Button, Card, ErrorNote, ProviderAuthLayout } from "./provider-ui";

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

function readTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

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

export function ProviderResetPassword() {
  const token = useMemo(readTokenFromUrl, []);
  useEffect(stripTokenFromUrl, []);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const reset = providerAuthHooks.useResetPassword();
  const [, setLocation] = useLocation();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (reset.isPending) return;
    setSubmitError(null);
    if (password !== confirm) {
      setSubmitError("The two passwords don't match.");
      return;
    }
    reset.mutate(
      { token, password },
      {
        onSuccess: () =>
          setLocation("/provider/sign-in?reset=success", { replace: true }),
        onError: (err) => {
          setSubmitError(
            authErrorMessage(err, {
              action: "set your password",
              subject: "invite link",
              fallback: "Could not set your password.",
            }),
          );
        },
      },
    );
  }

  return (
    <ProviderAuthLayout>
      {!token ? (
        <Card className="w-full max-w-sm p-6 space-y-4">
          <h1 className="text-xl font-bold text-slate-900">
            Invite link required
          </h1>
          <ErrorNote>
            This page needs the set-password link from your invite email. The
            link may have expired, or this page was opened without it. Ask the
            practice to send a fresh invite.
          </ErrorNote>
          <p className="text-xs text-center text-slate-500">
            <Link href="/provider/sign-in" className="underline text-blue-700">
              Back to provider sign in
            </Link>
          </p>
        </Card>
      ) : (
        <form onSubmit={onSubmit} className="w-full max-w-sm">
          <Card className="p-6 space-y-4">
            <h1 className="text-xl font-bold text-slate-900">
              Choose a password
            </h1>
            <p className="text-sm text-slate-500">
              Set a password for the provider portal, then sign in with your
              work email.
            </p>

            <label className="block text-sm">
              <span className="font-medium text-slate-800">New password</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
              <span className="block text-xs mt-1 text-slate-500">
                At least 12 characters.
              </span>
            </label>

            <label className="block text-sm">
              <span className="font-medium text-slate-800">
                Confirm new password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={inputClass}
              />
            </label>

            {submitError ? <ErrorNote>{submitError}</ErrorNote> : null}

            <Button
              type="submit"
              disabled={reset.isPending || !token}
              className="w-full"
            >
              {reset.isPending ? "Saving…" : "Set password"}
            </Button>

            <p className="text-xs text-center text-slate-500">
              <Link
                href="/provider/sign-in"
                className="underline text-blue-700"
              >
                Back to provider sign in
              </Link>
            </p>
          </Card>
        </form>
      )}
    </ProviderAuthLayout>
  );
}
