// Forgot-password page. Server contract is "always 200, no
// enumeration" — we render the success state regardless of whether
// the email matches an account. The one exception is a 5xx from
// /auth/forgot-password: the credentials store is unreachable, the
// email wasn't queued, and the user would otherwise wait forever
// for a reset link that never arrives. In that case we show the
// same server-status copy the rest of the admin auth surface uses
// (see ./sign-in.tsx, ./reset-password.tsx, ./change-password.tsx).

import "@/admin.css";

import { useState, type FormEvent } from "react";
import { Link } from "wouter";

import { AuthError } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/admin/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";

const basePath = "/admin";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const forgot = authHooks.useForgotPassword();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    forgot.mutate(
      { email: email.trim() },
      {
        // The server's normal contract is "always 200, no
        // enumeration" — so success and unknown-email both flow
        // through onSuccess and we render the generic success
        // state. A 5xx means the credentials store is actually
        // down, the email wasn't queued, and the user would
        // otherwise wait forever for a reset link that never
        // arrives. Surface the same server-status copy used on
        // sign-in / change-password / reset-password so the
        // messaging is consistent across the auth surface.
        onSuccess: () => setDone(true),
        onError: (err) => {
          if (err instanceof AuthError && err.status >= 500) {
            setSubmitError(
              "We can't reach the credentials store right now, so we" +
                " couldn't send a reset link. This is a server problem," +
                " not your email. Please try again in a minute — if it" +
                " keeps failing, check status.pennpaps.com.",
            );
            return;
          }
          // Any non-5xx error path still gets folded into the
          // generic success state to preserve the no-enumeration
          // contract.
          setDone(true);
        },
      },
    );
  }

  return (
    <AuthLayout variant="admin">
      <div
        className="admin-root w-full max-w-sm rounded-lg shadow-sm border p-6 space-y-4 bg-white"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <h1
          className="text-xl font-semibold"
          style={{ color: "hsl(var(--penn-navy-deep))" }}
        >
          Reset your password
        </h1>

        {done ? (
          <>
            <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
              If an account exists for that email, we've sent a link to reset
              the password. The link expires in one hour.
            </p>
            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Didn't get it? Check your spam folder, or try again with the email
              you signed up with.
            </p>
            <Link
              href={`${basePath}/sign-in`}
              className="text-xs underline block mt-2"
              style={{ color: "hsl(var(--penn-navy-deep))" }}
            >
              Back to sign in
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
              Enter the email address associated with your account and we'll
              send a link to set a new password.
            </p>

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
              disabled={forgot.isPending}
              className="w-full rounded-md text-white font-semibold py-2 text-sm"
              style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
            >
              {forgot.isPending ? "Sending…" : "Send reset link"}
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
        )}
      </div>
    </AuthLayout>
  );
}
