// Resupply admin sign-in page.
//
// Two-step flow:
//   1. Email + password → POST /resupply-api/auth/sign-in.
//      If the response is `{ ok: true }` we're done — redirect.
//      If the response is `{ ok: true, mfaRequired: true,
//      challengeToken }`, advance the form to the code step.
//   2. 6-digit TOTP code → POST /resupply-api/auth/sign-in/verify-mfa.
//      On success, redirect.
//
// Admins who haven't enrolled MFA only ever see step 1.
//
// Post-sign-in destination: callers append ?redirect=<path> — both the
// platform console and the admin console do, when they bounce a signed-out
// visitor here — so sign-in returns the operator to whatever they clicked
// toward instead of always dumping them on /admin. Without it, the Breathe
// footer's "Super admin login" → /platform link deposited people in the
// TENANT console, which read as the link being broken. The target is
// sanitized against open redirects in lib/admin/sign-in-redirect.ts.
//
// No "Sign up" link — staff are invited via /admin/team. The
// admin route emails a 7-day password_reset link, which lands
// on /reset-password.

import "@/admin.css";

import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { AuthError, authErrorMessage } from "@workspace/resupply-auth-react";

import { useQueryClient } from "@tanstack/react-query";

import { authHooks, SESSION_QUERY_KEY } from "@/lib/admin/auth-hooks";
import { readAdminRedirectTarget } from "@/lib/admin/sign-in-redirect";
import { AuthLayout } from "@/components/auth-layout";

const basePath = "/admin";

type Step = { kind: "password" } | { kind: "mfa"; challengeToken: string };

export function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [usingRecoveryCode, setUsingRecoveryCode] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const signIn = authHooks.useSignIn();
  const verifyMfa = authHooks.useVerifySignInMfa();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  // Captured once on mount so it survives the password → MFA step change
  // and any re-render in between.
  const [redirectTarget] = useState(readAdminRedirectTarget);

  /**
   * Hand the destination gate a CLEAN session cache, then navigate.
   *
   * Whoever bounced us here (ConsoleRoute / PlatformConsoleRoute) already ran
   * `useSession`, and `fetchMe` returns null on 401 — so the cache holds a
   * *successful* `data: null`. That gate then unmounted, leaving the entry
   * INACTIVE, and React Query does not refetch an inactive query on
   * invalidation; it only marks it stale. So `useSignIn`'s invalidate isn't
   * enough: remounting the gate would read the stale null with
   * `isPending: false` and redirect straight back here, stranding a
   * successfully signed-in operator on this form.
   *
   * Removing the entry outright means the gate remounts with no data at all —
   * a genuine pending state — so it shows its spinner and waits for the fresh
   * /me instead of bouncing. Covered by lib/admin/session-gate-refresh.test.
   */
  function goToDestination() {
    queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
    setLocation(redirectTarget);
  }

  function onPasswordSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: (result) => {
          if (result.mfaRequired) {
            setStep({ kind: "mfa", challengeToken: result.challengeToken });
            setCode("");
          } else {
            goToDestination();
          }
        },
        onError: (err) => {
          setSubmitError(
            authErrorMessage(err, {
              action: "sign you in",
              subject: "password",
              fallback: "Sign-in failed.",
            }),
          );
        },
      },
    );
  }

  function onMfaSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind !== "mfa") return;
    setSubmitError(null);
    const payload = usingRecoveryCode
      ? {
          challengeToken: step.challengeToken,
          recoveryCode: recoveryCode.trim(),
        }
      : { challengeToken: step.challengeToken, code: code.trim() };
    verifyMfa.mutate(payload, {
      onSuccess: () => goToDestination(),
      onError: (err) => {
        // If the challenge expired or is otherwise invalid, kick
        // the user back to step 1 so they can re-enter their
        // password (the challenge is single-use anyway).
        if (
          err instanceof AuthError &&
          (err.code === "mfa_challenge_expired" ||
            err.code === "mfa_challenge_invalid")
        ) {
          setStep({ kind: "password" });
          setPassword("");
          setSubmitError(err.userMessage);
          return;
        }
        setSubmitError(
          authErrorMessage(err, {
            action: "verify it's you",
            subject: "code",
            fallback: "Verification failed.",
          }),
        );
      },
    });
  }

  return (
    <AuthLayout variant="admin">
      {step.kind === "password" ? (
        <form
          onSubmit={onPasswordSubmit}
          className="admin-root w-full max-w-sm rounded-lg shadow-sm border p-6 space-y-4 bg-white"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <div>
            <h1
              className="text-xl font-semibold"
              style={{ color: "hsl(var(--penn-navy-deep))" }}
            >
              Sign in
            </h1>
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              Resupply admin console
            </p>
          </div>

          <label className="block text-sm">
            <span className="font-medium">Email</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (submitError) setSubmitError(null);
              }}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: "hsl(var(--line-1))" }}
            />
          </label>

          <label className="block text-sm">
            <span className="font-medium">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (submitError) setSubmitError(null);
              }}
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
            disabled={signIn.isPending}
            className="w-full rounded-md text-white font-semibold py-2 text-sm"
            style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
          >
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-xs text-center">
            <Link
              href={`${basePath}/forgot-password`}
              style={{ color: "hsl(var(--penn-navy-deep))" }}
              className="underline"
            >
              Forgot your password?
            </Link>
          </p>
        </form>
      ) : (
        <form
          onSubmit={onMfaSubmit}
          className="admin-root w-full max-w-sm rounded-lg shadow-sm border p-6 space-y-4 bg-white"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <div>
            <h1
              className="text-xl font-semibold"
              style={{ color: "hsl(var(--penn-navy-deep))" }}
            >
              Verify it's you
            </h1>
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              {usingRecoveryCode
                ? "Enter one of the backup recovery codes from when you enrolled."
                : "Enter the 6-digit code from your authenticator app."}
            </p>
          </div>

          {usingRecoveryCode ? (
            <label className="block text-sm">
              <span className="font-medium">Recovery code</span>
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                maxLength={32}
                className="mt-1 w-full rounded-md border px-3 py-2 text-base font-mono tracking-widest text-center"
                style={{ borderColor: "hsl(var(--line-1))" }}
                placeholder="ABCD-EFGH"
                autoFocus
              />
            </label>
          ) : (
            <label className="block text-sm">
              <span className="font-medium">Authenticator code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                maxLength={6}
                className="mt-1 w-full rounded-md border px-3 py-2 text-base font-mono tracking-widest text-center"
                style={{ borderColor: "hsl(var(--line-1))" }}
                autoFocus
              />
            </label>
          )}

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
            disabled={
              verifyMfa.isPending ||
              (usingRecoveryCode
                ? recoveryCode.trim().length < 4
                : code.length !== 6)
            }
            className="w-full rounded-md text-white font-semibold py-2 text-sm"
            style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
          >
            {verifyMfa.isPending ? "Verifying…" : "Verify and sign in"}
          </button>

          <button
            type="button"
            onClick={() => {
              setUsingRecoveryCode((v) => !v);
              setCode("");
              setRecoveryCode("");
              setSubmitError(null);
            }}
            className="w-full rounded-md py-2 text-xs underline"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {usingRecoveryCode
              ? "Use my authenticator app instead"
              : "Use a recovery code instead"}
          </button>

          <button
            type="button"
            onClick={() => {
              setStep({ kind: "password" });
              setPassword("");
              setCode("");
              setRecoveryCode("");
              setUsingRecoveryCode(false);
              setSubmitError(null);
            }}
            className="w-full rounded-md py-2 text-xs underline"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Cancel and use a different account
          </button>
        </form>
      )}
    </AuthLayout>
  );
}
