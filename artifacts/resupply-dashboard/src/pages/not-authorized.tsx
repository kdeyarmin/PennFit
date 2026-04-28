import { useClerk, useUser } from "@clerk/react";

// Friendly "you can't see the admin console" screen.
//
// Three distinct failure modes funnel into this page; each rendering
// branch is intentional, because they require different admin
// follow-ups:
//
//   reason="not-authorized" (HTTP 401/403/most 4xx)
//     The signed-in user passed Clerk's session check but is not on
//     the RESUPPLY_ADMIN_EMAILS allowlist. Resolution is "ask an
//     admin to add me" — so we show the email, tell them to contact
//     the resupply admin, and offer a sign-out button so they can
//     try a different account.
//
//   reason="not-configured" (HTTP 503)
//     The server has no allowlist set. This is a deploy-side mistake
//     (the env var didn't ship). Resolution is "ask an SRE to fix
//     the config" — the user retrying or signing out won't help.
//
//   reason="transient" (status 0 or 5xx that isn't 503)
//     A network blip, a server crash, or anything else that smells
//     like it'll resolve on its own. We tell the user to retry rather
//     than implying their access has been revoked. A 30-second
//     connectivity drop should not look the same as "you've been
//     removed from the allowlist".
//
// We deliberately keep the messaging short and don't echo the API's
// raw error string. The API never includes the user's id, the
// allowlist contents, or any environment fragment in its 4xx/5xx
// bodies (see /me OpenAPI definition + requireAdmin.ts), but
// belt-and-braces: we only render Clerk-side data the user already
// owns.

export type NotAuthorizedReason =
  | "not-authorized"
  | "not-configured"
  | "transient";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Admin-facing contact address. Override per environment with
// VITE_RESUPPLY_CONTACT_EMAIL so a production cutover (mailbox
// rename, distribution list change, etc.) doesn't require shipping
// a code change. Default is the current Penn Home Medical operations
// inbox, which is also the production value in dev/staging.
const DEFAULT_CONTACT_EMAIL =
  (import.meta.env.VITE_RESUPPLY_CONTACT_EMAIL as string | undefined) ??
  "rt-coordinator@pennhomemedical.com";

export function NotAuthorizedPage({
  reason,
  contactEmail = DEFAULT_CONTACT_EMAIL,
}: {
  reason: NotAuthorizedReason;
  contactEmail?: string;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const email = user?.primaryEmailAddress?.emailAddress ?? "your account";

  const isConfigError = reason === "not-configured";
  const isTransient = reason === "transient";

  // Per-reason headline copy. The body for each branch is rendered
  // inline below — three short branches read more clearly than a
  // table of JSX in this file.
  const eyebrow = isConfigError
    ? "Server not configured"
    : isTransient
      ? "Connection problem"
      : "Not authorized";
  const headline = isConfigError
    ? "Admin access isn't set up on this server yet"
    : isTransient
      ? "We can't reach the resupply server right now"
      : "This account isn't approved for the admin console";

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
              {isTransient ? "Access pending" : "Access denied"}
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
            style={{ color: isTransient ? "#b45309" : "#b91c1c" }}
          >
            {eyebrow}
          </p>
          <h1
            className="text-2xl font-semibold mb-3"
            style={{ color: "#0a1f44" }}
          >
            {headline}
          </h1>

          {isConfigError ? (
            <>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "#374151" }}
              >
                The resupply API doesn't have an admin allowlist
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
                  RESUPPLY_ADMIN_EMAILS
                </code>
                .
              </p>
            </>
          ) : isTransient ? (
            <>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "#374151" }}
              >
                The dashboard couldn't confirm your admin access just
                now — the server may be restarting, or your connection
                may have dropped briefly. This is almost always a few-
                seconds blip, not a permissions change.
              </p>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "#374151" }}
              >
                Try refreshing the page in a moment. If it keeps
                happening, contact{" "}
                <a
                  href={`mailto:${contactEmail}`}
                  className="underline font-semibold"
                  style={{ color: "#0a1f44" }}
                >
                  {contactEmail}
                </a>
                .
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="text-sm font-semibold px-4 py-2 rounded text-white"
                  style={{ backgroundColor: "#0a1f44" }}
                >
                  Try again
                </button>
              </div>
            </>
          ) : (
            <>
              <p
                className="text-sm leading-relaxed mb-4"
                style={{ color: "#374151" }}
              >
                You're signed in as{" "}
                <span className="font-semibold">{email}</span>, but that
                address isn't on the resupply admin allowlist.
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
