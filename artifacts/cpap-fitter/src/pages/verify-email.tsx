// Verify-email landing for the cpap-fitter shop. The user clicks
// the link in their welcome email and we POST the token to the
// server immediately on mount.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";

import { AuthError } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function readTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

// Strip ?token=... from the address bar so it doesn't persist in
// browser history, autocomplete, or shareable URLs.
function stripTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("token")) return;
    params.delete("token");
    const qs = params.toString();
    const next =
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", next);
  } catch {
    // History API not available: no-op.
  }
}

export function VerifyEmailPage() {
  const token = useMemo(readTokenFromUrl, []);
  useEffect(stripTokenFromUrl, []);
  const [status, setStatus] = useState<"verifying" | "ok" | "error">(
    token ? "verifying" : "error",
  );
  const [errorMessage, setErrorMessage] = useState<string>(
    token ? "" : "This page expects a verification link from your email.",
  );
  const verify = authHooks.useVerifyEmail();
  const verifyRef = useRef(verify);
  verifyRef.current = verify;
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true;
    verifyRef.current.mutate(
      { token },
      {
        onSuccess: () => setStatus("ok"),
        onError: (err) => {
          setStatus("error");
          setErrorMessage(
            err instanceof AuthError
              ? err.userMessage
              : "Could not verify this link.",
          );
        },
      },
    );
  }, [token]);

  return (
    <AuthLayout variant="customer">
      <div className="w-full max-w-sm rounded-lg shadow-sm border bg-white p-6 space-y-4 text-sm">
        <h1 className="text-xl font-semibold">Verify your email</h1>

        {status === "verifying" && <p>Verifying your email address…</p>}

        {status === "ok" && (
          <>
            <p>Your email is verified. You can now sign in.</p>
            <Link
              href={`${basePath}/sign-in`}
              className="block text-center rounded-md bg-[hsl(var(--penn-navy-deep))] text-white font-semibold py-2"
            >
              Continue to sign in
            </Link>
          </>
        )}

        {status === "error" && (
          <>
            <p
              role="alert"
              className="rounded-md px-3 py-2 bg-red-50 text-red-900"
            >
              {errorMessage}
            </p>
            <Link
              href={`${basePath}/sign-in`}
              className="text-xs underline text-[hsl(var(--penn-navy-deep))] block text-center"
            >
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
