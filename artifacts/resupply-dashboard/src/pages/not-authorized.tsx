import { useClerk, useUser } from "@clerk/react";

// Friendly "you can't see the operator console" screen.
//
// Two distinct failure modes funnel into this page; both rendering
// branches are intentional, because they require different operator
// follow-ups:
//
//   reason="not-authorized" (HTTP 403)
//     The signed-in user passed Clerk's session check but is not on
//     the RESUPPLY_OPERATOR_EMAILS allowlist. Resolution is "ask an
//     admin to add me" — so we show the email, tell them to contact
//     the resupply admin, and offer a sign-out button so they can
//     try a different account.
//
//   reason="not-configured" (HTTP 503)
//     The server has no allowlist set. This is a deploy-side mistake
//     (the env var didn't ship). Resolution is "ask an SRE to fix
//     the config" — the user retrying or signing out won't help.
//
// We deliberately keep the messaging short and don't echo the API's
// raw error string. The API never includes the user's id, the
// allowlist contents, or any environment fragment in its 4xx/5xx
// bodies (see /me OpenAPI definition + requireOperator.ts), but
// belt-and-braces: we only render Clerk-side data the user already
// owns.

export type NotAuthorizedReason = "not-authorized" | "not-configured";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function NotAuthorizedPage({
  reason,
  contactEmail = "rt-coordinator@pennhomemedical.com",
}: {
  reason: NotAuthorizedReason;
  contactEmail?: string;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress ?? "your account";

  const isConfigError = reason === "not-configured";

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <header
        className="flex items-center justify-between px-6 py-4 border-b"
        style={{ backgroundColor: "#0a1f44", borderColor: "#0a1f44" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 rounded flex items-center justify-center font-bold"
            style={{ backgroundColor: "#c9a24a", color: "#0a1f44" }}
            aria-hidden="true"
          >
            P
          </div>
          <div className="leading-tight">
            <div className="text-white font-semibold tracking-tight">
              Penn Resupply Console
            </div>
            <div className="text-xs" style={{ color: "#c9a24a" }}>
              Access denied
            </div>
          </div>
        </div>
        <div className="text-xs text-white/80">
          Signed in as <span className="font-semibold">{email}</span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div
          className="max-w-xl w-full bg-white border rounded-lg p-8 shadow-sm"
          style={{ borderColor: "#e5e7eb" }}
          role="alert"
          aria-live="polite"
        >
          <p
            className="text-xs uppercase tracking-[0.2em] mb-3 font-semibold"
            style={{ color: "#b91c1c" }}
          >
            {isConfigError ? "Server not configured" : "Not authorized"}
          </p>
          <h1
            className="text-2xl font-semibold mb-3"
            style={{ color: "#0a1f44" }}
          >
            {isConfigError
              ? "Operator access isn't set up on this server yet"
              : "This account isn't approved for the operator console"}
          </h1>

          {isConfigError ? (
            <>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "#374151" }}
              >
                The resupply API doesn't have an operator allowlist
                configured, so it's refusing every sign-in until an
                administrator finishes the setup. This is a deploy-side
                fix — signing out and back in won't change the result.
              </p>
              <p
                className="text-sm leading-relaxed mb-2"
                style={{ color: "#374151" }}
              >
                Please contact your Penn Home Medical Supply IT
                administrator and reference{" "}
                <code className="text-xs px-1 py-0.5 bg-gray-100 rounded">
                  RESUPPLY_OPERATOR_EMAILS
                </code>
                .
              </p>
            </>
          ) : (
            <>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "#374151" }}
              >
                You're signed in as{" "}
                <span className="font-semibold">{email}</span>, but that
                address isn't on the resupply operator allowlist.
              </p>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "#374151" }}
              >
                If you believe you should have access, please contact{" "}
                <a
                  href={`mailto:${contactEmail}`}
                  className="underline font-semibold"
                  style={{ color: "#0a1f44" }}
                >
                  {contactEmail}
                </a>{" "}
                and ask to be added.
              </p>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "#374151" }}
              >
                Already approved under a different email? Sign out and
                sign back in with the right account.
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() =>
                    void signOut({ redirectUrl: `${basePath}/sign-in` })
                  }
                  className="text-sm font-semibold px-4 py-2 rounded text-white"
                  style={{ backgroundColor: "#0a1f44" }}
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </main>

      <footer
        className="text-xs px-6 py-3 border-t text-center"
        style={{
          color: "#6b7280",
          backgroundColor: "#ffffff",
          borderColor: "#e5e7eb",
        }}
      >
        Penn Home Medical Supply · Internal tooling · Not for patient use
      </footer>
    </div>
  );
}
