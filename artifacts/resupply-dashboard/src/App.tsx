import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { useGetAdminMe, ApiError } from "@workspace/resupply-api-client";
import NotFound from "./pages/not-found";
import { SignInPage } from "./pages/sign-in";
import { ForgotPasswordPage } from "./pages/forgot-password";
import { ResetPasswordPage } from "./pages/reset-password";
import { VerifyEmailPage } from "./pages/verify-email";
import { NotAuthorizedPage } from "./pages/not-authorized";
import { authHooks } from "./lib/auth-hooks";
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
import { AdminSettingsPage } from "./pages/admin-settings";
import { AdminShopInventoryPage } from "./pages/admin-shop-inventory";
import { AdminShopProductNewPage } from "./pages/admin-shop-product-new";
import { AdminShopAbandonedCartsPage } from "./pages/admin-shop-abandoned-carts";
// PennPaps storefront-admin pages — ported from cpap-fitter as part
// of the Task #37 consolidation. They speak to the storefront router
// mounted on resupply-api at `/api/admin/*` (see artifact.toml).
import { AdminOrders as PennpapsOrdersPage } from "./pages/pennpaps-orders";
import { AdminOrderDetail as PennpapsOrderDetailPage } from "./pages/pennpaps-order-detail";
import { AdminAuditLog as PennpapsAuditPage } from "./pages/pennpaps-audit";
import { AdminReminders as PennpapsRemindersPage } from "./pages/pennpaps-reminders";
import { AdminAnalytics as PennpapsAnalyticsPage } from "./pages/pennpaps-analytics";

// Resupply Admin Console.
//
// Three routing layers, in order:
//
//   1. <WouterRouter base> — strips the artifact base path so
//      routes below are written as if they were root-relative.
//
//   2. <Switch> — top-level routes: the unauthenticated set
//      (/sign-in, /forgot-password, /reset-password, /verify-email)
//      sits next to the catch-all that funnels into <ConsoleRoute>.
//
//   3. <ConsoleRoute> — the in-house /auth/me probe + AppShell.
//      Routes to admin pages live INSIDE this gate so a
//      signed-out user never lands on a page that fires
//      authenticated queries.

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Console body — only rendered when the in-house session probe
// confirms an authenticated session. The admin-me probe drives:
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
        <Route path="/admin/settings" component={AdminSettingsPage} />
        {/* PennPaps storefront-admin (Task #37 consolidation). The
            paths live under /admin/pennpaps/* to disambiguate from
            the existing cash-pay shop admin (/admin/shop/*) so a
            CSR clicking "Orders" in the sidebar lands on the
            PennPaps storefront orders, not the Stripe shop orders. */}
        <Route path="/admin/pennpaps/orders" component={PennpapsOrdersPage} />
        <Route path="/admin/pennpaps/orders/:id" component={PennpapsOrderDetailPage} />
        <Route path="/admin/pennpaps/audit" component={PennpapsAuditPage} />
        <Route path="/admin/pennpaps/reminders" component={PennpapsRemindersPage} />
        <Route path="/admin/pennpaps/analytics" component={PennpapsAnalyticsPage} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

// Probes /resupply-api/auth/me; redirects to /sign-in when no
// session is present.
function ConsoleRoute() {
  const { data, isPending } = authHooks.useSession();
  if (isPending) return null;
  if (!data) return <Redirect to="/sign-in" />;
  return <AdminConsole />;
}

function Router() {
  return (
    <Switch>
      <Route path="/sign-in" component={SignInPage} />
      <Route path="/sign-in/:rest*" component={SignInPage} />
      <Route path="/forgot-password" component={ForgotPasswordPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route path="/verify-email" component={VerifyEmailPage} />
      {/* Every other route gets gated by ConsoleRoute. The pattern
          MUST be "*" (not "/:rest*"). Wouter uses regexparam, and
          `/:rest*` requires at least one path segment — using "*"
          matches both "/" and "/foo" so the admin landing on
          /resupply/ actually gets the dashboard (or the
          /sign-in redirect when signed-out) instead of a blank
          page. */}
      <Route path="*" component={ConsoleRoute} />
    </Switch>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <Router />
    </WouterRouter>
  );
}

export default App;
