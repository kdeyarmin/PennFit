import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { Show } from "@clerk/react";
import { useGetOperatorMe, ApiError } from "@workspace/resupply-api-client";
import NotFound from "./pages/not-found";
import { SignInPage } from "./pages/sign-in";
import { SignUpPage } from "./pages/sign-up";
import { NotAuthorizedPage } from "./pages/not-authorized";
import { useApiAuthBridge } from "./lib/api-client";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/Spinner";
import { DashboardPage } from "./pages/dashboard";
import { PatientsPage } from "./pages/patients";
import { PatientDetailPage } from "./pages/patient-detail";
import { ConversationsPage } from "./pages/conversations";
import { ConversationDetailPage } from "./pages/conversation-detail";
import { EpisodesPage } from "./pages/episodes";
import { AuditPage } from "./pages/audit";

// Penn Resupply Operator Console.
//
// Three routing layers, in order:
//
//   1. <WouterRouter base> — strips the artifact base path so
//      routes below are written as if they were root-relative.
//
//   2. <Switch> — top-level routes:
//        - /sign-in, /sign-in/:rest*, /sign-up, /sign-up/:rest*
//          reachable while signed-out
//        - everything else funnels through <ConsoleRoute>
//
//   3. <ConsoleRoute> — Clerk gate + /me probe + AppShell. Routes
//      to operator pages live INSIDE this gate so a signed-out user
//      never lands on a page that fires authenticated queries.

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// The console body — only rendered when Clerk says we have a session.
// /me probe outcomes funnel into:
//   - pending  → loading spinner inside the console shell
//   - error    → NotAuthorizedPage with a reason derived from status
//   - success  → AppShell + nested operator pages
//
// `error.status` mapping is unchanged from the placeholder build.
// status 0 (network drop, ApiError-not-thrown) → "transient" so a
// connectivity blip doesn't tell the operator they were de-allow-listed.

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

  if (isPending) {
    return (
      <AppShell>
        <Spinner label="Confirming operator access…" />
      </AppShell>
    );
  }

  return (
    <AppShell operatorEmail={data?.email}>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/patients" component={PatientsPage} />
        <Route path="/patients/:id">
          {(params) => <PatientDetailPage id={params.id} />}
        </Route>
        <Route path="/conversations" component={ConversationsPage} />
        <Route path="/conversations/:id">
          {(params) => <ConversationDetailPage id={params.id} />}
        </Route>
        <Route path="/episodes" component={EpisodesPage} />
        <Route path="/audit" component={AuditPage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

function ConsoleRoute() {
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
      {/* Every other route — including detail pages — gets gated by
          ConsoleRoute. ConsoleRoute itself renders a nested <Switch>
          with the actual operator pages. */}
      <Route path="/:rest*" component={ConsoleRoute} />
    </Switch>
  );
}

function App() {
  // Register the Clerk → API auth bridge once for the lifetime of
  // the app. Must live INSIDE ClerkProvider (in main.tsx).
  useApiAuthBridge();

  return (
    <WouterRouter base={basePath}>
      <Router />
    </WouterRouter>
  );
}

export default App;
