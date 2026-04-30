import { SignIn } from "@clerk/react";

// PennPaps-branded Clerk sign-in page. Path-routed under the dashboard's
// base path so the same component can serve `/sign-in/*` (Clerk's
// multi-step flow uses sub-paths internally for verify-email,
// MFA, etc.). All redirects target the dashboard root, where the
// admin gate runs the /me probe and routes to either the console
// or the "not authorized" screen.

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignInPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        forceRedirectUrl={`${basePath}/`}
      />
    </div>
  );
}
