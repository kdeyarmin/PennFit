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

import { Suspense, lazy } from "react";
import { Switch, Route, Redirect } from "wouter";
import {
  useGetAdminMe,
  getGetAdminMeQueryKey,
  ApiError,
} from "@workspace/api-client-react/admin";
import { ErrorBoundary } from "@/components/error-boundary";

import { authHooks } from "@/lib/admin/auth-hooks";
import { AppShell } from "@/components/admin/AppShell";
import { Spinner } from "@/components/admin/Spinner";
import NotFound from "@/pages/admin/not-found";
import { NotAuthorizedPage } from "@/pages/admin/not-authorized";

// Per-page lazy chunks. Splits what used to be a single ~70-page admin
// bundle into one chunk per route so a CSR who only ever opens 3 pages
// downloads 3 chunks (not all 70+). patient-detail alone is 2,456 lines;
// the previous monolith meant every staff user paid the full per-page
// transfer up front on the first /admin/* navigation.
//
// `DashboardPage` is intentionally kept eager because it's the default
// route on /admin and any Suspense flash there would be the first thing
// a staff user sees. `NotFound` + `NotAuthorizedPage` are also eager —
// both are small + load-bearing for error paths.
import { DashboardPage } from "@/pages/admin/dashboard";

const PatientsPage = lazy(() =>
  import("@/pages/admin/patients").then((m) => ({ default: m.PatientsPage })),
);
const PatientDetailPage = lazy(() =>
  import("@/pages/admin/patient-detail").then((m) => ({
    default: m.PatientDetailPage,
  })),
);
const ConversationsPage = lazy(() =>
  import("@/pages/admin/conversations").then((m) => ({
    default: m.ConversationsPage,
  })),
);
const ConversationDetailPage = lazy(() =>
  import("@/pages/admin/conversation-detail").then((m) => ({
    default: m.ConversationDetailPage,
  })),
);
const EpisodesPage = lazy(() =>
  import("@/pages/admin/episodes").then((m) => ({ default: m.EpisodesPage })),
);
const RulesPage = lazy(() =>
  import("@/pages/admin/rules").then((m) => ({ default: m.RulesPage })),
);
const AdminShopReviewsPage = lazy(() =>
  import("@/pages/admin/admin-shop-reviews").then((m) => ({
    default: m.AdminShopReviewsPage,
  })),
);
const AdminProductQuestionsPage = lazy(() =>
  import("@/pages/admin/admin-product-questions").then((m) => ({
    default: m.AdminProductQuestionsPage,
  })),
);
const AdminShopReturnsPage = lazy(() =>
  import("@/pages/admin/admin-shop-returns").then((m) => ({
    default: m.AdminShopReturnsPage,
  })),
);
const AdminFollowupsPage = lazy(() =>
  import("@/pages/admin/admin-followups").then((m) => ({
    default: m.AdminFollowupsPage,
  })),
);
const AdminTodayPage = lazy(() =>
  import("@/pages/admin/admin-today").then((m) => ({
    default: m.AdminTodayPage,
  })),
);
const AdminProvidersPage = lazy(() =>
  import("@/pages/admin/admin-providers").then((m) => ({
    default: m.AdminProvidersPage,
  })),
);
const AdminInboundFaxesPage = lazy(() =>
  import("@/pages/admin/admin-inbound-faxes").then((m) => ({
    default: m.AdminInboundFaxesPage,
  })),
);
const AdminInboundReferralsPage = lazy(() =>
  import("@/pages/admin/admin-inbound-referrals").then((m) => ({
    default: m.AdminInboundReferralsPage,
  })),
);
const AdminPrescriptionRequestsPage = lazy(() =>
  import("@/pages/admin/admin-prescription-requests").then((m) => ({
    default: m.AdminPrescriptionRequestsPage,
  })),
);
const AdminEquipmentRecallsPage = lazy(() =>
  import("@/pages/admin/admin-equipment-recalls").then((m) => ({
    default: m.AdminEquipmentRecallsPage,
  })),
);
const AdminAnalyticsPage = lazy(() =>
  import("@/pages/admin/admin-analytics").then((m) => ({
    default: m.AdminAnalyticsPage,
  })),
);
const AdminRtOverviewPage = lazy(() =>
  import("@/pages/admin/admin-rt-overview").then((m) => ({
    default: m.AdminRtOverviewPage,
  })),
);
const AdminBulkCampaignsPage = lazy(() =>
  import("@/pages/admin/admin-bulk-campaigns").then((m) => ({
    default: m.AdminBulkCampaignsPage,
  })),
);
const AdminSecurityPage = lazy(() =>
  import("@/pages/admin/admin-security").then((m) => ({
    default: m.AdminSecurityPage,
  })),
);
const AdminMacrosPage = lazy(() =>
  import("@/pages/admin/admin-macros").then((m) => ({
    default: m.AdminMacrosPage,
  })),
);
const AdminMessageTemplatesPage = lazy(() =>
  import("@/pages/admin/admin-message-templates").then((m) => ({
    default: m.AdminMessageTemplatesPage,
  })),
);
const AdminShopSubscriptionsPage = lazy(() =>
  import("@/pages/admin/admin-shop-subscriptions").then((m) => ({
    default: m.AdminShopSubscriptionsPage,
  })),
);
const AdminTeamPage = lazy(() =>
  import("@/pages/admin/admin-team").then((m) => ({ default: m.AdminTeamPage })),
);
const AdminOperationsPage = lazy(() =>
  import("@/pages/admin/admin-operations").then((m) => ({
    default: m.AdminOperationsPage,
  })),
);
const AdminReportsPage = lazy(() =>
  import("@/pages/admin/admin-reports").then((m) => ({
    default: m.AdminReportsPage,
  })),
);
const AdminControlCenterPage = lazy(() =>
  import("@/pages/admin/admin-control-center").then((m) => ({
    default: m.AdminControlCenterPage,
  })),
);
const AdminProductivityPage = lazy(() =>
  import("@/pages/admin/admin-productivity").then((m) => ({
    default: m.AdminProductivityPage,
  })),
);
const AdminBackordersPage = lazy(() =>
  import("@/pages/admin/admin-backorders").then((m) => ({
    default: m.AdminBackordersPage,
  })),
);
const AdminClosuresPage = lazy(() =>
  import("@/pages/admin/admin-closures").then((m) => ({
    default: m.AdminClosuresPage,
  })),
);
const AdminAppointmentRequestsPage = lazy(() =>
  import("@/pages/admin/admin-appointment-requests").then((m) => ({
    default: m.AdminAppointmentRequestsPage,
  })),
);
const AdminIntegrationsPage = lazy(() =>
  import("@/pages/admin/admin-integrations").then((m) => ({
    default: m.AdminIntegrationsPage,
  })),
);
const AdminCoachingPage = lazy(() =>
  import("@/pages/admin/admin-coaching").then((m) => ({
    default: m.AdminCoachingPage,
  })),
);
const AdminDeliveryFailuresPage = lazy(() =>
  import("@/pages/admin/admin-delivery-failures").then((m) => ({
    default: m.AdminDeliveryFailuresPage,
  })),
);
const AdminRuleTesterPage = lazy(() =>
  import("@/pages/admin/admin-rule-tester").then((m) => ({
    default: m.AdminRuleTesterPage,
  })),
);
const AdminSettingsPage = lazy(() =>
  import("@/pages/admin/admin-settings").then((m) => ({
    default: m.AdminSettingsPage,
  })),
);
const AdminShopInventoryPage = lazy(() =>
  import("@/pages/admin/admin-shop-inventory").then((m) => ({
    default: m.AdminShopInventoryPage,
  })),
);
const AdminShopProductNewPage = lazy(() =>
  import("@/pages/admin/admin-shop-product-new").then((m) => ({
    default: m.AdminShopProductNewPage,
  })),
);
const AdminShopInventoryReconcilePage = lazy(() =>
  import("@/pages/admin/admin-shop-inventory-reconcile").then((m) => ({
    default: m.AdminShopInventoryReconcilePage,
  })),
);
const AdminShopInventoryReconcileEditPage = lazy(() =>
  import("@/pages/admin/admin-shop-inventory-reconcile-edit").then((m) => ({
    default: m.AdminShopInventoryReconcileEditPage,
  })),
);
const AdminShopAbandonedCartsPage = lazy(() =>
  import("@/pages/admin/admin-shop-abandoned-carts").then((m) => ({
    default: m.AdminShopAbandonedCartsPage,
  })),
);
const AdminShopBackInStockPage = lazy(() =>
  import("@/pages/admin/admin-shop-back-in-stock").then((m) => ({
    default: m.AdminShopBackInStockPage,
  })),
);
const AdminInsuranceLeadsPage = lazy(() =>
  import("@/pages/admin/admin-insurance-leads").then((m) => ({
    default: m.AdminInsuranceLeadsPage,
  })),
);
const AdminFitterLeadsPage = lazy(() =>
  import("@/pages/admin/admin-fitter-leads").then((m) => ({
    default: m.AdminFitterLeadsPage,
  })),
);
const AdminInsuranceClaimsPage = lazy(() =>
  import("@/pages/admin/admin-insurance-claims").then((m) => ({
    default: m.AdminInsuranceClaimsPage,
  })),
);
const AdminBillingHubPage = lazy(() =>
  import("@/pages/admin/admin-billing-hub").then((m) => ({
    default: m.AdminBillingHubPage,
  })),
);
const AdminBillingAiQueuePage = lazy(() =>
  import("@/pages/admin/admin-billing-ai-queue").then((m) => ({
    default: m.AdminBillingAiQueuePage,
  })),
);
const AdminBillingAgingPage = lazy(() =>
  import("@/pages/admin/admin-billing-aging").then((m) => ({
    default: m.AdminBillingAgingPage,
  })),
);
const AdminBillingDenialsPage = lazy(() =>
  import("@/pages/admin/admin-billing-denials").then((m) => ({
    default: m.AdminBillingDenialsPage,
  })),
);
const AdminBillingEraPage = lazy(() =>
  import("@/pages/admin/admin-billing-era").then((m) => ({
    default: m.AdminBillingEraPage,
  })),
);
const AdminBillingEligibilityPage = lazy(() =>
  import("@/pages/admin/admin-billing-eligibility").then((m) => ({
    default: m.AdminBillingEligibilityPage,
  })),
);
const AdminBillingPriorAuthsPage = lazy(() =>
  import("@/pages/admin/admin-billing-prior-auths").then((m) => ({
    default: m.AdminBillingPriorAuthsPage,
  })),
);
const AdminBillingConfigHubPage = lazy(() =>
  import("@/pages/admin/admin-billing-config").then((m) => ({
    default: m.AdminBillingConfigHubPage,
  })),
);
const AdminBillingConfigPayersPage = lazy(() =>
  import("@/pages/admin/admin-billing-config-payers").then((m) => ({
    default: m.AdminBillingConfigPayersPage,
  })),
);
const AdminBillingConfigFeeSchedulesPage = lazy(() =>
  import("@/pages/admin/admin-billing-config-fee-schedules").then((m) => ({
    default: m.AdminBillingConfigFeeSchedulesPage,
  })),
);
const AdminBillingConfigModifierRulesPage = lazy(() =>
  import("@/pages/admin/admin-billing-config-modifier-rules").then((m) => ({
    default: m.AdminBillingConfigModifierRulesPage,
  })),
);
const AdminBillingConfigDenialCodesPage = lazy(() =>
  import("@/pages/admin/admin-billing-config-denial-codes").then((m) => ({
    default: m.AdminBillingConfigDenialCodesPage,
  })),
);
const AdminBillingConfigClaimTemplatesPage = lazy(() =>
  import("@/pages/admin/admin-billing-config-claim-templates").then((m) => ({
    default: m.AdminBillingConfigClaimTemplatesPage,
  })),
);
const AdminBillingCappedRentalsPage = lazy(() =>
  import("@/pages/admin/admin-billing-capped-rentals").then((m) => ({
    default: m.AdminBillingCappedRentalsPage,
  })),
);
const AdminBillingOfficeAllyPage = lazy(() =>
  import("@/pages/admin/admin-billing-office-ally").then((m) => ({
    default: m.AdminBillingOfficeAllyPage,
  })),
);
const AdminOfficeAllySubmissionDetailPage = lazy(() =>
  import("@/pages/admin/admin-billing-office-ally-detail").then((m) => ({
    default: m.AdminOfficeAllySubmissionDetailPage,
  })),
);
const AdminNpsPage = lazy(() =>
  import("@/pages/admin/admin-nps").then((m) => ({ default: m.AdminNpsPage })),
);
const AdminCustomerDetailPage = lazy(() =>
  import("@/pages/admin/admin-customer-detail").then((m) => ({
    default: m.AdminCustomerDetailPage,
  })),
);
const AdminShopCustomersPage = lazy(() =>
  import("@/pages/admin/admin-shop-customers").then((m) => ({
    default: m.AdminShopCustomersPage,
  })),
);
// Renamed-export pattern: the source files export AdminOrders /
// AdminOrderDetail / AdminReminders / AdminAnalytics but are bound to
// renamed Pennpaps* locals here. The lazy factory must map the source
// name to a default export under the renamed alias.
const PennpapsOrdersPage = lazy(() =>
  import("@/pages/admin/pennpaps-orders").then((m) => ({
    default: m.AdminOrders,
  })),
);
const PennpapsOrderDetailPage = lazy(() =>
  import("@/pages/admin/pennpaps-order-detail").then((m) => ({
    default: m.AdminOrderDetail,
  })),
);
const PennpapsRemindersPage = lazy(() =>
  import("@/pages/admin/pennpaps-reminders").then((m) => ({
    default: m.AdminReminders,
  })),
);
const PennpapsAnalyticsPage = lazy(() =>
  import("@/pages/admin/pennpaps-analytics").then((m) => ({
    default: m.AdminAnalytics,
  })),
);

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
  const { data, isPending, isError, error } = useGetAdminMe({
    query: {
      queryKey: getGetAdminMeQueryKey(),
      // A 401/403 here is a terminal answer ("you are not an admin"),
      // not a transient blip. React Query's default retry:3 with
      // exponential backoff would otherwise keep a signed-in non-admin
      // staring at the "Confirming admin access…" spinner for ~7s before
      // the not-authorized page renders. Retry only network/5xx errors,
      // and only twice.
      retry: (failureCount, err) => {
        const status = err instanceof ApiError ? err.status : 0;
        if (status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  });

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
        {/* Suspense boundary for the per-page lazy chunks declared at
            the top of this file. Without it, a navigation to any
            non-Dashboard route would crash with "Component suspended
            while responding to synchronous input". The spinner is the
            same admin-themed Spinner used by the AppShell while admin
            access is being confirmed, so the visual treatment is
            consistent across both kinds of pending state. */}
        <Suspense fallback={<Spinner label="Loading page…" />}>
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
            path="/admin/fitter-leads"
            component={AdminFitterLeadsPage}
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
            path="/admin/inbound-referrals"
            component={AdminInboundReferralsPage}
          />
          <Route
            path="/admin/patients/:patientId/prescription-requests"
            component={AdminPrescriptionRequestsPage}
          />
          <Route
            path="/admin/equipment-recalls"
            component={AdminEquipmentRecallsPage}
          />
          <Route path="/admin/analytics" component={AdminAnalyticsPage} />
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
          <Route
            path="/admin/control-center"
            component={AdminControlCenterPage}
          />
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
        </Suspense>
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
