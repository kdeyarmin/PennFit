// Customer self-serve sign-up page for the cpap-fitter shop.
//
// resupply-api mounts /api/auth with `allowSignUp: true`. The admin auth
// router under /resupply-api/auth disables public signup, so this is the
// supported path for new shoppers.
//
// Server response is "always 200, no enumeration" — we render a
// friendly success state regardless of whether the email was new
// or already existed (in which case no email goes out for an
// already-verified account).

import { useState, type FormEvent } from "react";
import { Link } from "wouter";

import { authErrorMessage } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";
import { PasswordInput } from "@/components/password-input";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignUpPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const signUp = authHooks.useSignUp();

  // Mismatch is treated as an inline form error rather than a server
  // submission. We also gate the submit button on it so a user can't
  // get a misleading "could not create the account" toast for what
  // is really a typo. The mismatch warning only appears AFTER the
  // confirm field has content — typing the password first shouldn't
  // immediately flag the empty confirm field as wrong.
  const passwordsMismatch =
    confirmPassword.length > 0 && confirmPassword !== password;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    if (passwordsMismatch || confirmPassword !== password) {
      setSubmitError("Passwords don't match.");
      return;
    }
    signUp.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => setSubmitted(true),
        onError: (err) => {
          setSubmitError(
            authErrorMessage(err, {
              action: "create your account",
              subject: "email or password",
              fallback: "Could not create the account.",
            }),
          );
        },
      },
    );
  }

  if (submitted) {
    return (
      <AuthLayout variant="customer">
        <div className="w-full max-w-sm rounded-lg shadow-sm border bg-white p-6 space-y-3 text-sm">
          <h1 className="text-xl font-semibold">Check your email</h1>
          <p>
            We've sent a verification link to <strong>{email}</strong>. Click it
            to finish setting up your account. The link expires in 24 hours.
          </p>
          <p className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <strong>Don't see it within a few minutes?</strong> Check your spam
            or junk folder — verification emails sometimes land there.
          </p>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href={`${basePath}/sign-in`}
              className="underline text-[hsl(var(--penn-navy-deep))]"
            >
              Sign in
            </Link>
            .
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout variant="customer">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg shadow-sm border bg-white p-6 space-y-4"
      >
        <div>
          <h1 className="text-xl font-semibold">Create your account</h1>
          <p className="text-sm text-muted-foreground">
            Save your shipping info, view past orders, and manage your
            subscriptions.
          </p>
        </div>

        <label className="block text-sm">
          <span className="font-medium">Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium">Password</span>
          <PasswordInput
            autoComplete="new-password"
            minLength={12}
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            showStrength
            helperText="At least 12 characters. Longer is stronger — passphrases of 4+ random words work great."
            inputTestId="signup-password-input"
          />
        </label>

        <label className="block text-sm">
          <span className="font-medium">Confirm password</span>
          <PasswordInput
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              if (submitError) setSubmitError(null);
            }}
            inputTestId="signup-confirm-password-input"
            aria-invalid={passwordsMismatch || undefined}
          />
          {passwordsMismatch && (
            <span
              className="block text-xs mt-1 text-rose-700"
              role="alert"
              data-testid="signup-confirm-mismatch"
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
          disabled={signUp.isPending || passwordsMismatch}
          className="w-full rounded-md bg-[hsl(var(--penn-navy-deep))] text-white font-semibold py-2 text-sm disabled:opacity-60"
        >
          {signUp.isPending ? "Creating account…" : "Create account"}
        </button>

        <p className="text-xs text-center">
          Already have an account?{" "}
          <Link
            href={`${basePath}/sign-in`}
            className="underline text-[hsl(var(--penn-navy-deep))]"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
