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
// No "Sign up" link — staff are invited via /admin/team. The
// admin route emails a 7-day password_reset link, which lands
// on /reset-password.

import "@/admin.css";

import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { AuthError } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/admin/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";

const basePath = "/admin";

type Step =
  | { kind: "password" }
  | { kind: "mfa"; challengeToken: string };

export function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const signIn = authHooks.useSignIn();
  const verifyMfa = authHooks.useVerifySignInMfa();
  const [, setLocation] = useLocation();

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
            setLocation("/admin");
          }
        },
        onError: (err) => {
          setSubmitError(
            err instanceof AuthError ? err.userMessage : "Sign-in failed.",
          );
        },
      },
    );
  }

  function onMfaSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind !== "mfa") return;
    setSubmitError(null);
    verifyMfa.mutate(
      { challengeToken: step.challengeToken, code: code.trim() },
      {
        onSuccess: () => setLocation("/admin"),
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
            err instanceof AuthError ? err.userMessage : "Verification failed.",
          );
        },
      },
    );
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
              onChange={(e) => setEmail(e.target.value)}
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
              onChange={(e) => setPassword(e.target.value)}
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
              Enter the 6-digit code from your authenticator app.
            </p>
          </div>

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
            disabled={verifyMfa.isPending || code.length !== 6}
            className="w-full rounded-md text-white font-semibold py-2 text-sm"
            style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
          >
            {verifyMfa.isPending ? "Verifying…" : "Verify and sign in"}
          </button>

          <button
            type="button"
            onClick={() => {
              setStep({ kind: "password" });
              setPassword("");
              setCode("");
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
