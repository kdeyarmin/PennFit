// Admin Console barrel.
//
// All 28 admin pages, the session/role gates, and the AppShell are
// imported here so App.tsx can lazy-load them as ONE chunk. The
// customer storefront bundle stays clean of the admin tables and
// generated resupply-api client until a staff user actually navigates
// to /admin/*.
//
// Three routing layers, in order:
//   1. /admin/sign-in (and other auth pages) live in App.tsx, ungated.
//   2. <ConsoleRoute> probes /resupply-api/auth/me; redirects signed-out
//      users to /admin/sign-in.
//   3. <AdminConsole> probes /resupply-api/admin/me (allowlist check)
//      via useGetAdminMe; renders <NotAuthorizedPage> on 4xx, the
//      <AppShell> + admin Switch on success.
//
// Migrated from artifacts/resupply-dashboard during the
// resupply-dashboard → cpap-fitter consolidation. Originally the
// dashboard was its own SPA at /resupply/*; now it's a sub-router
// under /admin/*.

import { Switch, Route, Redirect } from "wouter";
import { useGetAdminMe, ApiError } from "@workspace/api-client-react/admin";
import { ErrorBoundary } from "@/components/error-boundary";

import { authHooks } from "@/lib/admin/auth-hooks";
import { AppShell } from "@/components/admin/AppShell";
import { Spinner } from "@/components/admin/Spinner";
import NotFound from "@/pages/admin/not-found";
import { NotAuthorizedPage } from "@/pages/admin/not-authorized";

import { DashboardPage } from "@/pages/admin/dashboard";
import { PatientsPage } from "@/pages/admin/patients";
import { PatientDetailPage } from "@/pages/admin/patient-detail";
import { ConversationsPage } from "@/pages/admin/conversations";
import { ConversationDetailPage } from "@/pages/admin/conversation-detail";
import { EpisodesPage } from "@/pages/admin/episodes";
import { RulesPage } from "@/pages/admin/rules";
import { AuditPage } from "@/pages/admin/audit";
import { AdminShopReviewsPage } from "@/pages/admin/admin-shop-reviews";
import { AdminProductQuestionsPage } from "@/pages/admin/admin-product-questions";
import { AdminShopReturnsPage } from "@/pages/admin/admin-shop-returns";
import { AdminFollowupsPage } from "@/pages/admin/admin-followups";
import { AdminTodayPage } from "@/pages/admin/admin-today";
import { AdminProvidersPage } from "@/pages/admin/admin-providers";
import { AdminInboundFaxesPage } from "@/pages/admin/admin-inbound-faxes";
import { AdminEquipmentRecallsPage } from "@/pages/admin/admin-equipment-recalls";
import { AdminAnalyticsPage } from "@/pages/admin/admin-analytics";
import { AdminCompliancePage } from "@/pages/admin/admin-compliance";
import { AdminBulkCampaignsPage } from "@/pages/admin/admin-bulk-campaigns";
import { AdminSecurityPage } from "@/pages/admin/admin-security";
import { AdminMacrosPage } from "@/pages/admin/admin-macros";
import { AdminMessageTemplatesPage } from "@/pages/admin/admin-message-templates";
import { AdminShopSubscriptionsPage } from "@/pages/admin/admin-shop-subscriptions";
import { AdminTeamPage } from "@/pages/admin/admin-team";
import { AdminOperationsPage } from "@/pages/admin/admin-operations";
import { AdminReportsPage } from "@/pages/admin/admin-reports";
import { AdminDeliveryFailuresPage } from "@/pages/admin/admin-delivery-failures";
import { AdminRuleTesterPage } from "@/pages/admin/admin-rule-tester";
import { AdminSettingsPage } from "@/pages/admin/admin-settings";
import { AdminShopInventoryPage } from "@/pages/admin/admin-shop-inventory";
import { AdminShopProductNewPage } from "@/pages/admin/admin-shop-product-new";
import { AdminShopAbandonedCartsPage } from "@/pages/admin/admin-shop-abandoned-carts";
import { AdminShopBackInStockPage } from "@/pages/admin/admin-shop-back-in-stock";
import { AdminInsuranceLeadsPage } from "@/pages/admin/admin-insurance-leads";
import { AdminCustomerDetailPage } from "@/pages/admin/admin-customer-detail";
import { AdminShopCustomersPage } from "@/pages/admin/admin-shop-customers";
import { AdminOrders as PennpapsOrdersPage } from "@/pages/admin/pennpaps-orders";
import { AdminOrderDetail as PennpapsOrderDetailPage } from "@/pages/admin/pennpaps-order-detail";
import { AdminAuditLog as PennpapsAuditPage } from "@/pages/admin/pennpaps-audit";
import { AdminReminders as PennpapsRemindersPage } from "@/pages/admin/pennpaps-reminders";
import { AdminAnalytics as PennpapsAnalyticsPage } from "@/pages/admin/pennpaps-analytics";

// admin.css ships the dashboard's design tokens and nav-item utility
// classes used by AppShell. Imported here (and ONLY here) so the
// styles ride along with the lazy admin chunk and don't bloat the
// storefront bundle.
import "@/admin.css";

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
      <ErrorBoundary>
        <Switch>
          <Route path="/admin" component={DashboardPage} />
          <Route path="/admin/dashboard">
            <Redirect to="/admin" replace />
          </Route>
          <Route path="/admin/patients" component={PatientsPage} />
          <Route path="/admin/patients/:id">
            {(params) => <PatientDetailPage id={params.id} />}
          </Route>
          <Route path="/admin/conversations" component={ConversationsPage} />
          <Route path="/admin/conversations/:id">
            {(params) => <ConversationDetailPage id={params.id} />}
          </Route>
          <Route path="/admin/episodes" component={EpisodesPage} />
          <Route path="/admin/rules" component={RulesPage} />
          <Route path="/admin/audit" component={AuditPage} />
          <Route path="/admin/shop/reviews" component={AdminShopReviewsPage} />
          <Route
            path="/admin/shop/product-questions"
            component={AdminProductQuestionsPage}
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
            path="/admin/shop/back-in-stock"
            component={AdminShopBackInStockPage}
          />
          <Route
            path="/admin/shop/insurance-leads"
            component={AdminInsuranceLeadsPage}
          />
          <Route
            path="/admin/shop/customers"
            component={AdminShopCustomersPage}
          />
          <Route path="/admin/shop/customers/:userId">
            {(params) => <AdminCustomerDetailPage userId={params.userId} />}
          </Route>
          <Route path="/admin/shop/returns" component={AdminShopReturnsPage} />
          <Route path="/admin/followups" component={AdminFollowupsPage} />
          <Route path="/admin/today" component={AdminTodayPage} />
          <Route path="/admin/providers" component={AdminProvidersPage} />
          <Route
            path="/admin/inbound-faxes"
            component={AdminInboundFaxesPage}
          />
          <Route
            path="/admin/equipment-recalls"
            component={AdminEquipmentRecallsPage}
          />
          <Route path="/admin/analytics" component={AdminAnalyticsPage} />
          <Route path="/admin/compliance" component={AdminCompliancePage} />
          <Route
            path="/admin/bulk-campaigns"
            component={AdminBulkCampaignsPage}
          />
          <Route path="/admin/security" component={AdminSecurityPage} />
          <Route path="/admin/macros" component={AdminMacrosPage} />
          <Route
            path="/admin/templates"
            component={AdminMessageTemplatesPage}
          />
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
          <Route path="/admin/pennpaps/orders" component={PennpapsOrdersPage} />
          <Route
            path="/admin/pennpaps/orders/:id"
            component={PennpapsOrderDetailPage}
          />
          <Route path="/admin/pennpaps/audit" component={PennpapsAuditPage} />
          <Route
            path="/admin/pennpaps/reminders"
            component={PennpapsRemindersPage}
          />
          <Route
            path="/admin/pennpaps/analytics"
            component={PennpapsAnalyticsPage}
          />
          <Route component={NotFound} />
        </Switch>
      </ErrorBoundary>
    </AppShell>
  );
}

// Probes /resupply-api/auth/me; redirects to /admin/sign-in when no
// session is present.
export function ConsoleRoute() {
  const { data, isPending } = authHooks.useSession();
  if (isPending) return null;
  if (!data) return <Redirect to="/admin/sign-in" />;
  return <AdminConsole />;
}
