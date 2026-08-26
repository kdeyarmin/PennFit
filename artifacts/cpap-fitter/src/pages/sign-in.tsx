// Sign-in page for the cpap-fitter shop.
//
// On success we redirect to the sanitized ?redirect= target (so a
// shopper bounced here mid-checkout returns to /shop/cart?resume=1, and
// the header/account/orders CTAs return where they came from), falling
// back to /account for a returning shopper landing on their order
// history. New customers should use /sign-up instead — link below.

import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { CheckCircle2, Loader2, Lock, Mail, ShieldCheck } from "lucide-react";

import { authErrorMessage } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/auth-hooks";
import { isValidEmail } from "@/lib/email-format";
import { AuthLayout } from "@/components/auth-layout";
import { PasswordInput } from "@/components/password-input";

// Shared field styling — a calm white input with a brand-navy focus
// ring. Leading room (pl-10) is reserved for the inline channel icon.
const FIELD_CLASS =
  "mt-1 w-full rounded-lg border border-slate-200 bg-white pl-10 pr-3 py-2.5 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:border-[hsl(var(--penn-navy))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-navy)/0.18)]";

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
  // Legacy shop deep links — insurance-only storefront now.
  if (pathOnly.startsWith("/shop/")) return "/insurance";
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

  // Inline email-format validation: surface a field-level error once the
  // shopper has typed something that isn't a valid address, rather than
  // waiting for a pointless server round-trip. Mirrors consent.tsx.
  const emailValid = isValidEmail(email);
  const showEmailError = email.length > 0 && !emailValid;

  useEffect(() => {
    if (!successFlag) return;
    setLocation("/sign-in", { replace: true });
  }, [successFlag, setLocation]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    // Don't bother the server with a malformed address — the inline
    // error is already visible.
    if (!emailValid) return;
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
        className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_hsl(var(--penn-navy-deep)/0.06),0_18px_40px_hsl(var(--penn-navy-deep)/0.10)]"
      >
        {/* Accent rail — navy → aurum → navy gradient (brand tokens). */}
        <div
          aria-hidden="true"
          className="h-1 w-full bg-[linear-gradient(90deg,hsl(var(--penn-navy-deep)),hsl(var(--penn-gold)),hsl(var(--penn-navy-soft)))]"
        />

        <div className="space-y-5 p-7">
          {/* Branded header: gradient-ringed shield mark + welcome copy. */}
          <div className="flex flex-col items-center text-center">
            <div className="relative mb-3">
              <span
                aria-hidden="true"
                className="absolute inset-0 -m-1 rounded-2xl bg-[hsl(var(--penn-gold)/0.30)] blur-md"
              />
              <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[linear-gradient(150deg,hsl(var(--penn-navy-soft)),hsl(var(--penn-navy))_55%,hsl(var(--penn-navy-deep)))] shadow-inner ring-1 ring-white/15">
                <ShieldCheck
                  className="h-6 w-6 text-white"
                  aria-hidden="true"
                />
              </span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Welcome back
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Sign in to manage therapy, messages, and shipping details.
            </p>
          </div>

          {successFlag === "reset" && (
            <p
              role="status"
              data-testid="signin-reset-success"
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
            >
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                aria-hidden="true"
              />
              Your password has been updated. Sign in with your new password.
            </p>
          )}
          {successFlag === "verified" && (
            <p
              role="status"
              data-testid="signin-verified-success"
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
            >
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                aria-hidden="true"
              />
              Your email is verified. Sign in to continue.
            </p>
          )}

          <div>
            <label
              htmlFor="signin-email"
              className="block text-sm font-medium text-slate-700"
            >
              Email
            </label>
            <div className="relative">
              <Mail
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="signin-email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (submitError) setSubmitError(null);
                }}
                aria-invalid={showEmailError || undefined}
                aria-describedby={
                  showEmailError ? "signin-email-error" : undefined
                }
                className={FIELD_CLASS}
              />
            </div>
            {showEmailError && (
              <p
                id="signin-email-error"
                role="alert"
                className="mt-1 text-sm font-medium text-red-700"
              >
                Enter a valid email address (e.g. you@example.com).
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor="signin-password"
                className="block text-sm font-medium text-slate-700"
              >
                Password
              </label>
              <Link
                href={`${basePath}/forgot-password`}
                className="text-xs font-medium text-[hsl(var(--penn-navy))] hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Lock
                className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
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
                className="border-slate-200 bg-white pl-10 py-2.5 shadow-sm transition-colors placeholder:text-slate-400 focus:border-[hsl(var(--penn-navy))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-navy)/0.18)]"
              />
            </div>
          </div>

          {submitError && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
            >
              {submitError}
            </p>
          )}

          <button
            type="submit"
            disabled={signIn.isPending || showEmailError}
            className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-lg bg-[linear-gradient(180deg,hsl(var(--penn-navy-soft)),hsl(var(--penn-navy))_55%,hsl(var(--penn-navy-deep)))] py-2.5 text-sm font-semibold text-white shadow-[0_4px_14px_hsl(var(--penn-navy-deep)/0.28)] transition-all hover:shadow-[0_6px_20px_hsl(var(--penn-navy-deep)/0.36)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--penn-navy)/0.45)] focus-visible:ring-offset-2 disabled:opacity-60"
          >
            {signIn.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-center text-sm text-muted-foreground">
            New here?{" "}
            <Link
              href={`${basePath}/sign-up`}
              className="font-medium text-[hsl(var(--penn-navy))] hover:underline"
            >
              Create an account
            </Link>
          </p>

          {/* Trust signal — quiet, high-tech reassurance. */}
          <div className="flex items-center justify-center gap-1.5 border-t border-slate-100 pt-4 text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Protected by a secure, encrypted connection
          </div>
        </div>
      </form>
    </AuthLayout>
  );
}
