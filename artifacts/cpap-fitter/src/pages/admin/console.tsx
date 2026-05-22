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
import { AdminRtOverviewPage } from "@/pages/admin/admin-rt-overview";
import { AdminBulkCampaignsPage } from "@/pages/admin/admin-bulk-campaigns";
import { AdminSecurityPage } from "@/pages/admin/admin-security";
import { AdminMacrosPage } from "@/pages/admin/admin-macros";
import { AdminMessageTemplatesPage } from "@/pages/admin/admin-message-templates";
import { AdminShopSubscriptionsPage } from "@/pages/admin/admin-shop-subscriptions";
import { AdminTeamPage } from "@/pages/admin/admin-team";
import { AdminOperationsPage } from "@/pages/admin/admin-operations";
import { AdminReportsPage } from "@/pages/admin/admin-reports";
import { AdminProductivityPage } from "@/pages/admin/admin-productivity";
import { AdminBackordersPage } from "@/pages/admin/admin-backorders";
import { AdminClosuresPage } from "@/pages/admin/admin-closures";
import { AdminAppointmentRequestsPage } from "@/pages/admin/admin-appointment-requests";
import { AdminAccreditationBinderPage } from "@/pages/admin/admin-accreditation-binder";
import { AdminIntegrationsPage } from "@/pages/admin/admin-integrations";
import { AdminCoachingPage } from "@/pages/admin/admin-coaching";
import { AdminDeliveryFailuresPage } from "@/pages/admin/admin-delivery-failures";
import { AdminRuleTesterPage } from "@/pages/admin/admin-rule-tester";
import { AdminSettingsPage } from "@/pages/admin/admin-settings";
import { AdminShopInventoryPage } from "@/pages/admin/admin-shop-inventory";
import { AdminShopProductNewPage } from "@/pages/admin/admin-shop-product-new";
import { AdminShopInventoryReconcilePage } from "@/pages/admin/admin-shop-inventory-reconcile";
import { AdminShopInventoryReconcileEditPage } from "@/pages/admin/admin-shop-inventory-reconcile-edit";
import { AdminShopAbandonedCartsPage } from "@/pages/admin/admin-shop-abandoned-carts";
import { AdminShopBackInStockPage } from "@/pages/admin/admin-shop-back-in-stock";
import { AdminInsuranceLeadsPage } from "@/pages/admin/admin-insurance-leads";
import { AdminInsuranceClaimsPage } from "@/pages/admin/admin-insurance-claims";
import { AdminBillingHubPage } from "@/pages/admin/admin-billing-hub";
import { AdminBillingAiQueuePage } from "@/pages/admin/admin-billing-ai-queue";
import { AdminBillingAgingPage } from "@/pages/admin/admin-billing-aging";
import { AdminBillingDenialsPage } from "@/pages/admin/admin-billing-denials";
import { AdminBillingEraPage } from "@/pages/admin/admin-billing-era";
import { AdminBillingEligibilityPage } from "@/pages/admin/admin-billing-eligibility";
import { AdminBillingPriorAuthsPage } from "@/pages/admin/admin-billing-prior-auths";
import { AdminBillingConfigHubPage } from "@/pages/admin/admin-billing-config";
import { AdminBillingConfigPayersPage } from "@/pages/admin/admin-billing-config-payers";
import { AdminBillingConfigFeeSchedulesPage } from "@/pages/admin/admin-billing-config-fee-schedules";
import { AdminBillingConfigModifierRulesPage } from "@/pages/admin/admin-billing-config-modifier-rules";
import { AdminBillingConfigDenialCodesPage } from "@/pages/admin/admin-billing-config-denial-codes";
import { AdminBillingConfigClaimTemplatesPage } from "@/pages/admin/admin-billing-config-claim-templates";
import { AdminBillingCappedRentalsPage } from "@/pages/admin/admin-billing-capped-rentals";
import { AdminBillingOfficeAllyPage } from "@/pages/admin/admin-billing-office-ally";
import { AdminOfficeAllySubmissionDetailPage } from "@/pages/admin/admin-billing-office-ally-detail";
import { AdminNpsPage } from "@/pages/admin/admin-nps";
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

/**
 * Gate access to the admin console and render the admin routes inside the application shell.
 *
 * Queries the current admin identity and, depending on the result, either:
 * - renders an authorization error page with a specific reason,
 * - renders the app shell with a loading spinner while access is being confirmed, or
 * - renders the full set of `/admin/*` routes (wrapped in an error boundary) with the admin's email and role provided to the shell.
 *
 * @returns The admin console UI: an authorization gate (error or loading) or the routed admin pages inside the app shell.
 */
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
          <Route path="/admin/billing" component={AdminBillingHubPage} />
          <Route
            path="/admin/billing/ai-queue"
            component={AdminBillingAiQueuePage}
          />
          <Route
            path="/admin/billing/aging"
            component={AdminBillingAgingPage}
          />
          <Route
            path="/admin/billing/denials"
            component={AdminBillingDenialsPage}
          />
          <Route
            path="/admin/billing/era"
            component={AdminBillingEraPage}
          />
          <Route
            path="/admin/billing/eligibility"
            component={AdminBillingEligibilityPage}
          />
          <Route
            path="/admin/billing/prior-auths"
            component={AdminBillingPriorAuthsPage}
          />
          <Route
            path="/admin/billing/config"
            component={AdminBillingConfigHubPage}
          />
          <Route
            path="/admin/billing/config/payers"
            component={AdminBillingConfigPayersPage}
          />
          <Route
            path="/admin/billing/config/fee-schedules"
            component={AdminBillingConfigFeeSchedulesPage}
          />
          <Route
            path="/admin/billing/config/modifier-rules"
            component={AdminBillingConfigModifierRulesPage}
          />
          <Route
            path="/admin/billing/config/denial-codes"
            component={AdminBillingConfigDenialCodesPage}
          />
          <Route
            path="/admin/billing/config/claim-templates"
            component={AdminBillingConfigClaimTemplatesPage}
          />
          <Route
            path="/admin/billing/capped-rentals"
            component={AdminBillingCappedRentalsPage}
          />
          <Route
            path="/admin/billing/office-ally"
            component={AdminBillingOfficeAllyPage}
          />
          <Route path="/admin/billing/office-ally/:submissionId">
            {(params) => (
              <AdminOfficeAllySubmissionDetailPage
                submissionId={params.submissionId}
              />
            )}
          </Route>
          <Route path="/admin/patients" component={PatientsPage} />
          <Route path="/admin/patients/:patientId/insurance-claims">
            {(params) => (
              <AdminInsuranceClaimsPage patientId={params.patientId} />
            )}
          </Route>
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
            path="/admin/shop/inventory/reconcile"
            component={AdminShopInventoryReconcilePage}
          />
          <Route
            path="/admin/shop/inventory/reconcile/:id"
            component={AdminShopInventoryReconcileEditPage}
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
          <Route path="/admin/rt-overview" component={AdminRtOverviewPage} />
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
          <Route path="/admin/nps" component={AdminNpsPage} />
          <Route
            path="/admin/productivity"
            component={AdminProductivityPage}
          />
          <Route
            path="/admin/shop/backorders"
            component={AdminBackordersPage}
          />
          <Route
            path="/admin/closures"
            component={AdminClosuresPage}
          />
          <Route
            path="/admin/appointment-requests"
            component={AdminAppointmentRequestsPage}
          />
          <Route
            path="/admin/accreditation-binder"
            component={AdminAccreditationBinderPage}
          />
          <Route
            path="/admin/integrations"
            component={AdminIntegrationsPage}
          />
          <Route
            path="/admin/coaching"
            component={AdminCoachingPage}
          />
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
