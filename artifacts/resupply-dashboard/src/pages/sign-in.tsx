// Resupply admin sign-in page.
//
// Posts the email + password to /resupply-api/auth/sign-in. On
// success, redirects to the dashboard root; the /me probe in
// <ConsoleRoute> handles the role check from there.
//
// No "Sign up" link — staff are invited via /admin/team. The
// admin route emails a 7-day password_reset link, which lands
// on /reset-password.

import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { AuthError } from "@workspace/resupply-auth-react";

import { authHooks } from "../lib/auth-hooks";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const signIn = authHooks.useSignIn();
  const [, setLocation] = useLocation();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => setLocation("/"),
        onError: (err) => {
          setSubmitError(
            err instanceof AuthError ? err.userMessage : "Sign-in failed.",
          );
        },
      },
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-lg shadow-sm border p-6 space-y-4 bg-white"
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
    </div>
  );
}
