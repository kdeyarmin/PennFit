// Forgot-password landing for the cpap-fitter shop. Server contract
// is "always 200, no enumeration" — success and unknown-email both
// flow through onSuccess and we render the generic success state.
// The one exception is a 5xx from /auth/forgot-password: the backend
// is unreachable, the email wasn't queued, and the shopper would
// otherwise wait forever for a reset link that never arrives. In
// that case we surface the shared server-trouble notice (see
// `serverUnavailableMessage` in @workspace/resupply-auth-react).
// Any non-5xx error path still folds into the generic success state
// to preserve the no-enumeration contract.

import { useState, type FormEvent } from "react";
import { Link } from "wouter";

import { authHooks } from "@/lib/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";

import { decideForgotPasswordErrorOutcome } from "./forgot-password.helpers";

// Re-exported so existing imports of this branch from "./forgot-password"
// (and the source-grep tests that lock the page to the shared helper)
// keep working — the actual implementation lives in the .ts helper
// module so tests can pull it in without dragging JSX through the
// import graph.
export { decideForgotPasswordErrorOutcome } from "./forgot-password.helpers";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

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
        onSuccess: () => setDone(true),
        onError: (err) => {
          const outcome = decideForgotPasswordErrorOutcome(err);
          if (outcome.kind === "show-error") {
            setSubmitError(outcome.message);
            return;
          }
          // Preserve the no-enumeration contract: any non-5xx error
          // still surfaces the generic success state.
          setDone(true);
        },
      },
    );
  }

  return (
    <AuthLayout variant="customer">
      <div className="w-full max-w-sm rounded-lg shadow-sm border bg-white p-6 space-y-4">
        <h1 className="text-xl font-semibold">Reset your password</h1>

        {done ? (
          <>
            <p className="text-sm">
              If an account exists for that email, we've sent a link to reset
              the password. The link expires in one hour.
            </p>
            <p className="text-xs text-muted-foreground">
              Didn't get it? Check your spam folder, or try again with the email
              you signed up with.
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
              Enter your email and we'll send you a link to set a new password.
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
              disabled={forgot.isPending}
              className="w-full rounded-md bg-[hsl(var(--penn-navy-deep))] text-white font-semibold py-2 text-sm disabled:opacity-60"
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
    </AuthLayout>
  );
}
