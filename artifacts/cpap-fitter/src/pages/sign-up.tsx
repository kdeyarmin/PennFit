import { SignUp } from "@clerk/react";
import { useDocumentTitle } from "@/hooks/use-document-title";

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

/** See sign-in.tsx for the rationale on hiding the Clerk footer. */
const HIDE_CLERK_BRANDING = {
  elements: {
    footer: { display: "none" as const },
  },
} as const;

export function SignUpPage() {
  useDocumentTitle("Create your account");
  const redirectUrl = readRedirect();
  return (
    <div className="flex min-h-[calc(100dvh-5rem)] flex-col items-center justify-center px-4 py-12">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Create your Penn Home Medical Supply account
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          New here? Set up your account in a few seconds to get started.
        </p>
      </div>
      <SignUp
        appearance={HIDE_CLERK_BRANDING}
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
