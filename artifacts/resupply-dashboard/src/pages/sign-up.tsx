import { SignUp } from "@clerk/react";

// PennPaps-branded the auth provider sign-up page. We expose sign-up because Clerk's
// default sign-in form links to it; the admin allowlist still
// gates console access, so a self-signed-up user lands on the "not
// authorized" screen until an admin adds them to
// RESUPPLY_ADMIN_EMAILS. That is intentional — it lets a new RT
// coordinator self-serve account creation while keeping the
// authorization decision an explicit admin action.

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignUpPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl={`${basePath}/`}
      />
    </div>
  );
}
