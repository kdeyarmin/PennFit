import { SignUp } from "@clerk/react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Mirrors readRedirect() in sign-in.tsx — see that file for rationale. */
function readRedirect(): string {
  if (typeof window === "undefined") return `${basePath}/admin`;
  const usp = new URLSearchParams(window.location.search);
  const raw = usp.get("redirect");
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) {
    if (basePath && raw.startsWith(basePath)) return raw;
    return `${basePath}${raw}`;
  }
  return `${basePath}/admin`;
}

export function SignUpPage() {
  const redirectUrl = readRedirect();
  return (
    <div className="flex min-h-[calc(100dvh-5rem)] items-center justify-center px-4 py-12">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in?redirect=${encodeURIComponent(
          redirectUrl.startsWith(basePath)
            ? redirectUrl.slice(basePath.length) || "/"
            : redirectUrl,
        )}`}
        forceRedirectUrl={redirectUrl}
      />
    </div>
  );
}
