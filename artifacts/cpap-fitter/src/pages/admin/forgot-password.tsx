// Forgot-password page. Server contract is "always 200, no
// enumeration" — we render the success state regardless of whether
// the email matches an account.

import "@/admin.css";

import { useState, type FormEvent } from "react";
import { Link } from "wouter";

import { authHooks } from "@/lib/admin/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";

const basePath = "/admin";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const forgot = authHooks.useForgotPassword();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    forgot.mutate(
      { email: email.trim() },
      {
        // Server returns 200 even on unknown emails / malformed
        // input. We always render the success state — the
        // alternative would leak which addresses have accounts.
        onSettled: () => setDone(true),
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
