// Sign-in page for the cpap-fitter shop.
//
// On success we redirect to the sanitized ?redirect= target (so a
// shopper bounced here mid-checkout returns to /shop/cart?resume=1, and
// the header/account/orders CTAs return where they came from), falling
// back to /account for a returning shopper landing on their order
// history. New customers should use /sign-up instead — link below.

import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";

import { authErrorMessage } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";
import { PasswordInput } from "@/components/password-input";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Read the post-redirect success flag from the URL. Two flows land here:
//   ?reset=success    — user just set a new password (sessions revoked)
//   ?verified=success — user just clicked the email verification link
// Returning null when neither is present keeps the banner suppressed in
/**
 * Reads a short success flag from the current page's query string for UI banners.
 *
 * Checks the URL search params and returns a flag when a recognized success parameter is present.
 *
 * @returns `"reset"` if the query contains `reset=success`, `"verified"` if it contains `verified=success`, or `null` when neither is present or when not running in a browser (SSR).
 */
function readSuccessFlag(): "reset" | "verified" | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("reset") === "success") return "reset";
  if (params.get("verified") === "success") return "verified";
  return null;
}

// Read and sanitize the post-sign-in redirect target. Callers append
// ?redirect=<path> (user-menu "Sign in", /account + /shop/orders CTAs,
// and the mid-checkout cart bounce that sends ?redirect=/shop/cart?resume=1)
// so the shopper lands back where they were instead of always on /account.
// We honor ONLY same-origin absolute paths: a single leading "/" (reject
// "//" protocol-relative and absolute http(s) URLs so this can't be an
// open redirect), and never bounce back into an auth page (avoids a
/**
 * Determine a safe post-authentication redirect path from the URL `redirect` query parameter.
 *
 * Returns the sanitized path to use after sign-in; falls back to `/account` when executed outside the browser, when `redirect` is missing or empty, when it does not start with a single leading `/`, when it is protocol-relative (`//...`), or when it equals `/sign-in` or `/sign-up`.
 *
 * @returns The validated redirect path (a leading-slash path) or `"/account"` on invalid input or during SSR.
 */
function readRedirect(): string {
  if (typeof window === "undefined") return "/account";
  const raw = new URLSearchParams(window.location.search).get("redirect");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/account";
  const pathOnly = raw.split(/[?#]/)[0];
  if (pathOnly === "/sign-in" || pathOnly === "/sign-up") return "/account";
  return raw;
}

/**
 * Render the sign-in UI and handle the sign-in flow, including a sanitized post-login redirect.
 *
 * Reads the URL once on mount to capture an optional success flag (`reset` or `verified`) and a validated `redirect` target.
 * When a success flag is present a corresponding success banner is shown and the query string is stripped from the URL.
 * Submits credentials through the auth hook, displays submission errors, and navigates to the captured redirect target on successful sign-in.
 *
 * @returns The JSX element for the sign-in page and form
 */
export function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Only read the URL on mount — once the user starts interacting we
  // don't want the banner to flicker back as the form re-renders.
  const [successFlag] = useState(readSuccessFlag);
  // Capture the redirect target on mount too, BEFORE the successFlag
  // effect below strips the query string — otherwise a combined
  // ?reset=success&redirect=… would lose the redirect.
  const [redirectTarget] = useState(readRedirect);
  const signIn = authHooks.useSignIn();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!successFlag) return;
    setLocation("/sign-in", { replace: true });
  }, [successFlag, setLocation]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => setLocation(redirectTarget),
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
          <label
            htmlFor="signin-password"
            className="block text-sm font-medium"
          >
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
