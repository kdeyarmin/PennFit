// Sign-in page for the cpap-fitter shop.
//
// On success we redirect to /account so a returning shopper
// lands on their order history. New customers should use
// /sign-up instead — there's a link below the form.

import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { AuthError } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";
import { PasswordInput } from "@/components/password-input";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Read the post-redirect success flag from the URL. Two flows land here:
//   ?reset=success    — user just set a new password (sessions revoked)
//   ?verified=success — user just clicked the email verification link
// Returning null when neither is present keeps the banner suppressed in
// the steady-state sign-in view.
function readSuccessFlag(): "reset" | "verified" | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("reset") === "success") return "reset";
  if (params.get("verified") === "success") return "verified";
  return null;
}

export function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Only read the URL on mount — once the user starts interacting we
  // don't want the banner to flicker back as the form re-renders.
  const [successFlag] = useState(readSuccessFlag);
  const signIn = authHooks.useSignIn();
  const [, setLocation] = useLocation();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => setLocation("/account"),
        onError: (err) => {
          setSubmitError(
            err instanceof AuthError ? err.userMessage : "Sign-in failed.",
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
        <div>
          <h1 className="text-xl font-semibold">Sign in</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to view your orders and saved shipping info.
          </p>
        </div>

        {successFlag === "reset" && (
          <p
            role="status"
            data-testid="signin-reset-success"
            className="text-sm rounded-md px-3 py-2 bg-emerald-50 text-emerald-900"
          >
            Your password has been updated. Sign in with your new password.
          </p>
        )}
        {successFlag === "verified" && (
          <p
            role="status"
            data-testid="signin-verified-success"
            className="text-sm rounded-md px-3 py-2 bg-emerald-50 text-emerald-900"
          >
            Your email is verified. Sign in to continue.
          </p>
        )}

        <div>
          <label htmlFor="signin-email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="signin-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label htmlFor="signin-password" className="block text-sm font-medium">
            Password
          </label>
          <PasswordInput
            id="signin-password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            inputTestId="signin-password-input"
          />
        </div>

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
          disabled={signIn.isPending}
          className="w-full rounded-md bg-[hsl(var(--penn-navy-deep))] text-white font-semibold py-2 text-sm disabled:opacity-60"
        >
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </button>

        <div className="text-xs text-center space-y-1">
          <p>
            <Link
              href={`${basePath}/forgot-password`}
              className="underline text-[hsl(var(--penn-navy-deep))]"
            >
              Forgot your password?
            </Link>
          </p>
          <p>
            New here?{" "}
            <Link
              href={`${basePath}/sign-up`}
              className="underline text-[hsl(var(--penn-navy-deep))]"
            >
              Create an account
            </Link>
          </p>
        </div>
      </form>
    </AuthLayout>
  );
}
