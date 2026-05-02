// Forgot-password landing for the cpap-fitter shop. Server returns
// 200 regardless of whether the email matches an account — no
// enumeration — so we always render the success state on
// settlement.

import { useState, type FormEvent } from "react";
import { Link } from "wouter";

import { authHooks } from "@/lib/auth-hooks";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const forgot = authHooks.useForgotPassword();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    forgot.mutate(
      { email: email.trim() },
      { onSettled: () => setDone(true) },
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-lg shadow-sm border bg-white p-6 space-y-4">
        <h1 className="text-xl font-semibold">Reset your password</h1>

        {done ? (
          <>
            <p className="text-sm">
              If an account exists for that email, we've sent a link to reset
              the password. The link expires in one hour.
            </p>
            <p className="text-xs text-muted-foreground">
              Didn't get it? Check your spam folder, or try again with the
              email you signed up with.
            </p>
            <Link
              href={`${basePath}/sign-in`}
              className="text-xs underline text-[hsl(var(--penn-navy-deep))] block mt-2"
            >
              Back to sign in
            </Link>
          </>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <p className="text-sm">
              Enter your email and we'll send you a link to set a new
              password.
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
              />
            </label>

            <button
              type="submit"
              disabled={forgot.isPending}
              className="w-full rounded-md bg-[hsl(var(--penn-navy-deep))] text-white font-semibold py-2 text-sm"
            >
              {forgot.isPending ? "Sending…" : "Send reset link"}
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
        )}
      </div>
    </div>
  );
}
