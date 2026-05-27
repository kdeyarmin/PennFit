// Verify-email landing page. The user clicks a link in an email
// that points here with `?token=…`. We POST the token to the
// server immediately on mount; the result is rendered as one of
// three branches (verifying / success / error).

import "@/admin.css";

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";

import { authErrorMessage } from "@workspace/resupply-auth-react";

import { authHooks } from "@/lib/admin/auth-hooks";
import { AuthLayout } from "@/components/auth-layout";

const basePath = "/admin";

function readTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("token") ?? "";
}

// Strip ?token=... from the address bar so the single-use secret
// doesn't linger in browser history, autocomplete, or screenshots.
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
  // Ref-guarded one-shot: the verify mutation is a new function
  // reference each render, so listing it as an effect dep would
  // loop. The ref ensures we POST exactly once per token, which
  // also defends against React strict-mode's dev-only double-fire
  // (the second invocation would otherwise see the token already
  // consumed and render "expired").
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
            authErrorMessage(err, {
              action: "verify your email",
              subject: "link",
              fallback: "Could not verify this link.",
            }),
          );
        },
      },
    );
  }, [token]);

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
          Verify your email
        </h1>

        {status === "verifying" && (
          <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            Verifying your email address…
          </p>
        )}

        {status === "ok" && (
          <>
            <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
              Your email is verified. You can now sign in.
            </p>
            <Link
              href={`${basePath}/sign-in`}
              className="inline-block w-full text-center rounded-md text-white font-semibold py-2 text-sm"
              style={{ backgroundColor: "hsl(var(--penn-navy-deep))" }}
            >
              Continue to sign in
            </Link>
          </>
        )}

        {status === "error" && (
          <>
            <p
              role="alert"
              className="text-sm rounded-md px-3 py-2"
              style={{
                backgroundColor: "hsl(0 70% 96%)",
                color: "hsl(0 70% 30%)",
              }}
            >
              {errorMessage}
            </p>
            <Link
              href={`${basePath}/sign-in`}
              className="text-xs underline block text-center"
              style={{ color: "hsl(var(--penn-navy-deep))" }}
            >
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
