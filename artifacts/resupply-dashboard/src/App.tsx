import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { Show } from "@clerk/react";
import { useGetAdminMe, ApiError } from "@workspace/resupply-api-client";
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
import { RulesPage } from "./pages/rules";
import { AuditPage } from "./pages/audit";
import { AdminShopReviewsPage } from "./pages/admin-shop-reviews";
import { AdminShopReturnsPage } from "./pages/admin-shop-returns";
import { AdminMacrosPage } from "./pages/admin-macros";
import { AdminShopSubscriptionsPage } from "./pages/admin-shop-subscriptions";
import { AdminTeamPage } from "./pages/admin-team";
import { AdminOperationsPage } from "./pages/admin-operations";
import { AdminReportsPage } from "./pages/admin-reports";
import { AdminDeliveryFailuresPage } from "./pages/admin-delivery-failures";
import { AdminRuleTesterPage } from "./pages/admin-rule-tester";
import { AdminShopInventoryPage } from "./pages/admin-shop-inventory";
import { AdminShopProductNewPage } from "./pages/admin-shop-product-new";
import { AdminShopAbandonedCartsPage } from "./pages/admin-shop-abandoned-carts";

// PennPaps Admin Console.
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
//   3. <ConsoleRoute> — the auth provider gate + /me probe + AppShell. Routes
//      to admin pages live INSIDE this gate so a signed-out user
//      never lands on a page that fires authenticated queries.

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// The console body — only rendered when the auth provider says we have a session.
// /me probe outcomes funnel into:
//   - pending  → loading spinner inside the console shell
//   - error    → NotAuthorizedPage with a reason derived from status
//   - success  → AppShell + nested admin pages
//
// `error.status` mapping is unchanged from the placeholder build.
// status 0 (network drop, ApiError-not-thrown) → "transient" so a
// connectivity blip doesn't tell the admin they were de-allow-listed.

function AdminConsole() {
  const { data, isPending, isError, error } = useGetAdminMe();

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
        <Spinner label="Confirming admin access…" />
      </AppShell>
    );
  }

  return (
    <AppShell adminEmail={data?.email} adminRole={data?.role}>
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
        <Route path="/rules" component={RulesPage} />
        <Route path="/audit" component={AuditPage} />
        <Route
          path="/admin/shop/reviews"
          component={AdminShopReviewsPage}
        />
        <Route
          path="/admin/shop/inventory"
          component={AdminShopInventoryPage}
        />
        <Route
          path="/admin/shop/inventory/new"
          component={AdminShopProductNewPage}
        />
        <Route
          path="/admin/shop/abandoned-carts"
          component={AdminShopAbandonedCartsPage}
        />
        <Route
          path="/admin/shop/returns"
          component={AdminShopReturnsPage}
        />
        <Route path="/admin/macros" component={AdminMacrosPage} />
        <Route
          path="/admin/shop/subscriptions"
          component={AdminShopSubscriptionsPage}
        />
        <Route path="/admin/team" component={AdminTeamPage} />
        <Route path="/admin/operations" component={AdminOperationsPage} />
        <Route path="/admin/reports" component={AdminReportsPage} />
        <Route
          path="/admin/delivery-failures"
          component={AdminDeliveryFailuresPage}
        />
        <Route path="/admin/rule-tester" component={AdminRuleTesterPage} />
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
        <AdminConsole />
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
      {/* Every other route — including the bare "/" landing page
          and all detail pages — gets gated by ConsoleRoute.
          ConsoleRoute itself renders a nested <Switch> with the
          actual admin pages.

          The pattern MUST be "*" (not "/:rest*"). Wouter uses
          regexparam, and `/:rest*` requires at least one path
          segment after the slash — so it matches "/foo" but NOT
          "/" itself. Using "*" matches both, which is what we need
          so the admin landing on /resupply/ actually gets
          the dashboard (or the redirect to /sign-in when signed-out)
          instead of a blank page from a Switch that found no
          matching route. */}
      <Route path="*" component={ConsoleRoute} />
    </Switch>
  );
}

function App() {
  // Register the auth → API bridge once for the lifetime of
  // the app. Must live INSIDE ClerkProvider (in main.tsx).
  useApiAuthBridge();

  return (
    <WouterRouter base={basePath}>
      <Router />
    </WouterRouter>
  );
}

export default App;
