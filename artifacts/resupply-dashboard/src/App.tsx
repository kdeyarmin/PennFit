import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { Show, useClerk } from "@clerk/react";
import { useGetOperatorMe, ApiError } from "@workspace/resupply-api-client";
import NotFound from "./pages/not-found";
import { SignInPage } from "./pages/sign-in";
import { SignUpPage } from "./pages/sign-up";
import { NotAuthorizedPage } from "./pages/not-authorized";
import { useApiAuthBridge } from "./lib/api-client";

// Penn Resupply Operator Console — Phase 0 + Clerk auth.
//
// Three routing layers, in order:
//   1. WouterRouter base — strips the artifact base path so routes
//      below are written as if they were root-relative.
//   2. <Switch> — top-level route table. /sign-in and /sign-up are
//      always reachable so a signed-out user can authenticate; every
//      other path goes through <ConsoleRoute>, which gates on Clerk +
//      the /me operator check.
//   3. <ConsoleRoute> internals — uses Clerk's <SignedIn> /
//      <SignedOut> guards to drive the redirect-to-sign-in flow, then
//      renders the console UI which fetches /me to confirm operator
//      authorization. The 403 / 503 "not authorized" screen is wired
//      in a follow-up change.

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function BrandHeader({ rightSlot }: { rightSlot?: React.ReactNode }) {
  return (
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
            Operator workstation
          </div>
        </div>
      </div>
      {rightSlot ? (
        <div className="text-xs text-white/80">{rightSlot}</div>
      ) : (
        <div
          className="text-xs uppercase tracking-wider"
          style={{ color: "#c9a24a" }}
        >
          Phase 0 · Scaffold
        </div>
      )}
    </header>
  );
}

// The console body — only rendered when Clerk says we have a session.
// Translates the /me probe outcome into one of three terminal states:
//
//   - pending  → loading shimmer in the existing console chrome
//   - error    → dedicated NotAuthorizedPage. The page knows three
//                reasons:
//                  * "not-configured" — HTTP 503 from requireOperator,
//                    meaning the server has no allowlist set; ops fix.
//                  * "transient"      — anything that smells like a
//                    blip (status 0 from a network failure, 5xx that
//                    isn't 503, or anything that didn't surface as
//                    an ApiError); user can retry.
//                  * "not-authorized" — everything else, primarily
//                    HTTP 403 / 401 / other 4xx; user is signed in
//                    but not on the allowlist.
//   - success  → the (currently-placeholder) operator UI.
//
// Reading `error.status` off the generated client's ApiError is type-
// safe rather than a generic `unknown` cast. Status 0 (assigned when
// the error isn't an ApiError instance — e.g. a `fetch` TypeError
// from a connection drop) intentionally maps to "transient" rather
// than "not-authorized" so a 30-second connectivity blip doesn't tell
// the operator they've been un-allowlisted.
// Header chip rendered for a signed-in operator: shows the email and a
// Sign-out button. Lives at the top right of the OperatorConsole shell
// so an operator who lands on the wrong account can recover without
// digging through Clerk's user menu (which we don't currently mount).
function OperatorHeaderChip({ email }: { email: string }) {
  const { signOut } = useClerk();
  return (
    <div className="flex items-center gap-3">
      <span>
        Signed in as <span className="font-semibold">{email}</span>
      </span>
      <button
        type="button"
        // Pass an explicit redirectUrl. Without it, signOut() leaves
        // the browser on the current path (e.g. /resupply/), and the
        // Show-when="signed-out" gate in ConsoleRoute redirects to
        // /sign-in on the next render — works, but adds an extra
        // render frame where the page briefly looks "stuck". Passing
        // the redirect target up front matches NotAuthorizedPage's
        // sign-out behavior and lands on the sign-in URL in one step.
        onClick={() =>
          void signOut({ redirectUrl: `${basePath}/sign-in` })
        }
        className="text-xs font-semibold px-3 py-1.5 rounded border"
        style={{
          color: "#0a1f44",
          backgroundColor: "#ffffff",
          borderColor: "#c9a24a",
        }}
      >
        Sign out
      </button>
    </div>
  );
}

function OperatorConsole() {
  const { data, isPending, isError, error } = useGetOperatorMe();

  if (isError) {
    const status = error instanceof ApiError ? error.status : 0;
    const reason: "not-configured" | "transient" | "not-authorized" =
      status === 503
        ? "not-configured"
        : status === 0 || (status >= 500 && status < 600)
          ? "transient"
          : "not-authorized";
    return <NotAuthorizedPage reason={reason} />;
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: "#f7f8fb" }}
    >
      <BrandHeader
        rightSlot={
          data?.email ? <OperatorHeaderChip email={data.email} /> : undefined
        }
      />

      <main className="flex-1 flex items-center justify-center p-6">
        <div
          className="max-w-xl w-full bg-white border rounded-lg p-8 shadow-sm"
          style={{ borderColor: "#e5e7eb" }}
        >
          <p
            className="text-xs uppercase tracking-[0.2em] mb-3 font-semibold"
            style={{ color: "#c9a24a" }}
          >
            CPAP Resupply Automation
          </p>
          <h1
            className="text-2xl font-semibold mb-3"
            style={{ color: "#0a1f44" }}
          >
            Operator console placeholder
          </h1>

          {isPending && (
            <p className="text-sm" style={{ color: "#374151" }}>
              Confirming operator access…
            </p>
          )}

          {data && (
            <p
              className="text-sm leading-relaxed"
              style={{ color: "#374151" }}
            >
              Real operator screens — patient queue, episode detail,
              conversation viewer, fulfillment — land in Phase 4. For now,
              this page exists only to confirm sign-in works end-to-end
              against the resupply API.
            </p>
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

function ConsoleRoute() {
  // Clerk v6 exposes a single `<Show when="signed-in" | "signed-out">`
  // primitive instead of separate <SignedIn>/<SignedOut> components.
  // The signed-out branch sends the browser to our Penn-branded
  // sign-in page (path-routed, so the URL stays under the artifact's
  // base path); the signed-in branch renders the operator console
  // shell, which then runs the /me probe to confirm authorization.
  return (
    <>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
      <Show when="signed-in">
        <OperatorConsole />
      </Show>
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/sign-in" component={SignInPage} />
      <Route path="/sign-in/:rest*" component={SignInPage} />
      <Route path="/sign-up" component={SignUpPage} />
      <Route path="/sign-up/:rest*" component={SignUpPage} />
      <Route path="/" component={ConsoleRoute} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  // Register the Clerk → API auth bridge once for the lifetime of
  // the app. Must live INSIDE ClerkProvider (which is in main.tsx)
  // so `useAuth()` resolves; the App component is mounted as a child
  // of ClerkProvider so we're safe.
  useApiAuthBridge();

  return (
    <WouterRouter base={basePath}>
      <Router />
    </WouterRouter>
  );
}

export default App;
