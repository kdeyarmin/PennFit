// Change-password screen for the admin console.
//
// Reached in two ways:
//   1. Forced — after first sign-in with an admin-set password, the
//      server's /auth/me returns mustChangePassword:true and
//      ConsoleRoute (see ./console.tsx) redirects here before the
//      AdminConsole gate mounts. The user can't escape into the rest
//      of the app until they pick a new password.
//   2. Optional — any signed-in admin can navigate here directly to
//      rotate their password.
//
// The endpoint requires the user to type the CURRENT password
// (defense against an attacker who walked up to an unlocked
// session), then sets a new one and revokes every OTHER session for
// the user.

import "@/admin.css";

import { useState, type FormEvent } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";

import {
  authErrorMessage,
  SESSION_QUERY_KEY,
  type AuthMe,
} from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/admin/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";

const basePath = "/admin";

export function ChangePasswordPage() {
  const session = authHooks.useSession();
  const change = authHooks.useChangePassword();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Wait until the session probe resolves; this screen is only useful
  // for a signed-in user. A signed-out probe (data === null) is
  // bounced to the sign-in page — visiting /admin/change-password
  // directly from a logged-out tab is a no-op otherwise.
  if (session.isPending) return null;
  if (!session.data) return <Redirect to={`${basePath}/sign-in`} />;

  const forced = session.data.mustChangePassword;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    if (password !== confirm) {
      setSubmitError("The two new passwords don't match.");
      return;
    }
    if (password === currentPassword) {
      setSubmitError("Your new password must be different from the current one.");
      return;
    }
    change.mutate(
      { currentPassword, newPassword: password },
      {
        onSuccess: () => {
          setDone(true);
          // Optimistically flip the cached /me payload so ConsoleRoute
          // doesn't race the next /me refetch and bounce the user
          // straight back to this screen on navigation. The hook's
          // own onSuccess will still invalidate and refetch /me to
          // confirm the server state.
          const prev = qc.getQueryData<AuthMe | null>(SESSION_QUERY_KEY);
          if (prev) {
            qc.setQueryData<AuthMe | null>(SESSION_QUERY_KEY, {
              ...prev,
              mustChangePassword: false,
            });
          }
          // The server cleared must_change. Send the user into the
          // console; ConsoleRoute will no longer bounce them back here.
          setLocation(basePath);
        },
        onError: (err) => {
          setSubmitError(
            authErrorMessage(err, {
              action: "change your password",
              subject: "password",
              fallback: "Could not change your password.",
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
        <div>
          <h1
            className="text-xl font-semibold"
            style={{ color: "hsl(var(--penn-navy-deep))" }}
          >
            {forced ? "Choose a new password" : "Change your password"}
          </h1>
          {forced && (
            <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-2))" }}>
              An administrator set a temporary password for you. Pick a new
              one to continue.
            </p>
          )}
        </div>

        <label className="block text-sm">
          <span className="font-medium">Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          />
        </label>

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
          disabled={change.isPending || done}
          className="w-full rounded-md text-white font-semibold py-2 text-sm"
          style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
        >
          {change.isPending ? "Saving…" : "Set new password"}
        </button>

        {!forced && (
          <p className="text-xs text-center">
            <Link
              href={basePath}
              style={{ color: "hsl(var(--penn-navy-deep))" }}
              className="underline"
            >
              Back to the console
            </Link>
          </p>
        )}
      </form>
    </AuthLayout>
  );
}
