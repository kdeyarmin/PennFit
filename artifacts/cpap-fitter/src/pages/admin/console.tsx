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

import { Suspense } from "react";
import { Switch, Route, Redirect } from "wouter";
import {
  useGetAdminMe,
  getGetAdminMeQueryKey,
  ApiError,
} from "@workspace/api-client-react/admin";
import { ErrorBoundary } from "@/components/error-boundary";
import { lazyWithRetry } from "@/lib/lazy-with-retry";

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
// Wrapped with lazyWithRetry (not bare React.lazy): each deploy replaces
// the content-hashed chunk files, so a tab opened before the deploy 404s
// the first not-yet-visited page it navigates to. lazyWithRetry recovers
// with one guarded reload instead of stranding the staff user on the
// ErrorBoundary ("Something went wrong" on the e-signature portal was
// exactly this).
//
// `DashboardPage` is intentionally kept eager because it's the default
// route on /admin and any Suspense flash there would be the first thing
// a staff user sees. `NotFound` + `NotAuthorizedPage` are also eager —
// both are small + load-bearing for error paths.
import { DashboardPage } from "@/pages/admin/dashboard";

const PatientsPage = lazyWithRetry(() =>
  import("@/pages/admin/patients").then((m) => ({ default: m.PatientsPage })),
);
const AdminPatientsDuplicatesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-patients-duplicates").then((m) => ({
    default: m.AdminPatientsDuplicatesPage,
  })),
);
const AdminLiveStaffingPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-live-staffing").then((m) => ({
    default: m.AdminLiveStaffingPage,
  })),
);
const PatientDetailPage = lazyWithRetry(() =>
  import("@/pages/admin/patient-detail").then((m) => ({
    default: m.PatientDetailPage,
  })),
);
const AdminPatientPacketsPage = lazyWithRetry(() =>
  import("@/pages/admin/patient-packets").then((m) => ({
    default: m.AdminPatientPacketsPage,
  })),
);
const AdminDocumentsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-documents").then((m) => ({
    default: m.AdminDocumentsPage,
  })),
);
const AdminSignatureTrackingPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-signature-tracking").then((m) => ({
    default: m.AdminSignatureTrackingPage,
  })),
);
const ConversationsPage = lazyWithRetry(() =>
  import("@/pages/admin/conversations").then((m) => ({
    default: m.ConversationsPage,
  })),
);
const ConversationDetailPage = lazyWithRetry(() =>
  import("@/pages/admin/conversation-detail").then((m) => ({
    default: m.ConversationDetailPage,
  })),
);
const EmailInboxPage = lazyWithRetry(() =>
  import("@/pages/admin/email-inbox").then((m) => ({
    default: m.EmailInboxPage,
  })),
);
const EpisodesPage = lazyWithRetry(() =>
  import("@/pages/admin/episodes").then((m) => ({ default: m.EpisodesPage })),
);
const RulesPage = lazyWithRetry(() =>
  import("@/pages/admin/rules").then((m) => ({ default: m.RulesPage })),
);
const AdminComplianceRulesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-compliance-rules").then((m) => ({
    default: m.AdminComplianceRulesPage,
  })),
);
const AdminLocationsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-locations").then((m) => ({
    default: m.AdminLocationsPage,
  })),
);
const AdminShopReviewsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-reviews").then((m) => ({
    default: m.AdminShopReviewsPage,
  })),
);
const AdminProductQuestionsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-product-questions").then((m) => ({
    default: m.AdminProductQuestionsPage,
  })),
);
const AdminShopReturnsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-returns").then((m) => ({
    default: m.AdminShopReturnsPage,
  })),
);
const AdminFollowupsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-followups").then((m) => ({
    default: m.AdminFollowupsPage,
  })),
);
const AdminCasesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-cases").then((m) => ({
    default: m.AdminCasesPage,
  })),
);
const AdminProvidersPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-providers").then((m) => ({
    default: m.AdminProvidersPage,
  })),
);
const AdminProviderEsignPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-provider-esign").then((m) => ({
    default: m.AdminProviderEsignPage,
  })),
);
const AdminInboundFaxesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-inbound-faxes").then((m) => ({
    default: m.AdminInboundFaxesPage,
  })),
);
const AdminPrescriptionRequestsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-prescription-requests").then((m) => ({
    default: m.AdminPrescriptionRequestsPage,
  })),
);
const AdminEquipmentRecallsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-equipment-recalls").then((m) => ({
    default: m.AdminEquipmentRecallsPage,
  })),
);
const AdminAnalyticsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-analytics").then((m) => ({
    default: m.AdminAnalyticsPage,
  })),
);
const AdminAnalyticsMarginPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-analytics-margin").then((m) => ({
    default: m.AdminAnalyticsMarginPage,
  })),
);
const AdminAnalyticsOutreachAttributionPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-analytics-outreach-attribution").then((m) => ({
    default: m.AdminAnalyticsOutreachAttributionPage,
  })),
);
const AdminAnalyticsAcquisitionFunnelPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-analytics-acquisition-funnel").then((m) => ({
    default: m.AdminAnalyticsAcquisitionFunnelPage,
  })),
);
const AdminAnalyticsRevenueBySourcePage = lazyWithRetry(() =>
  import("@/pages/admin/admin-analytics-revenue-by-source").then((m) => ({
    default: m.AdminAnalyticsRevenueBySourcePage,
  })),
);
const AdminAnalyticsChannelEngagementPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-analytics-channel-engagement").then((m) => ({
    default: m.AdminAnalyticsChannelEngagementPage,
  })),
);
const AdminLtvCacPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-ltv-cac").then((m) => ({
    default: m.AdminLtvCacPage,
  })),
);
const AdminInventoryTurnoverPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-inventory-turnover").then((m) => ({
    default: m.AdminInventoryTurnoverPage,
  })),
);
const AdminGoalsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-goals").then((m) => ({
    default: m.AdminGoalsPage,
  })),
);
const AdminKpiAlertsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-kpi-alerts").then((m) => ({
    default: m.AdminKpiAlertsPage,
  })),
);
const AdminTherapyUsageReportPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-therapy-usage-report").then((m) => ({
    default: m.AdminTherapyUsageReportPage,
  })),
);
const AdminRtOverviewPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-rt-overview").then((m) => ({
    default: m.AdminRtOverviewPage,
  })),
);
const AdminRtOutcomesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-rt-outcomes").then((m) => ({
    default: m.AdminRtOutcomesPage,
  })),
);
const AdminInterventionsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-interventions").then((m) => ({
    default: m.AdminInterventionsPage,
  })),
);
const AdminMaskFitWorklistPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-mask-fit-worklist").then((m) => ({
    default: m.AdminMaskFitWorklistPage,
  })),
);
const AdminClinicalOutreachPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-clinical-outreach").then((m) => ({
    default: m.AdminClinicalOutreachPage,
  })),
);
const AdminEducationVideosPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-education-videos").then((m) => ({
    default: m.AdminEducationVideosPage,
  })),
);
const AdminOutreachPlaybooksPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-outreach-playbooks").then((m) => ({
    default: m.AdminOutreachPlaybooksPage,
  })),
);
const AdminBulkCampaignsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-bulk-campaigns").then((m) => ({
    default: m.AdminBulkCampaignsPage,
  })),
);
const AdminSecurityPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-security").then((m) => ({
    default: m.AdminSecurityPage,
  })),
);
const AdminMacrosPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-macros").then((m) => ({
    default: m.AdminMacrosPage,
  })),
);
const AdminMessageTemplatesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-message-templates").then((m) => ({
    default: m.AdminMessageTemplatesPage,
  })),
);
const AdminAlertsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-alerts").then((m) => ({
    default: m.AdminAlertsPage,
  })),
);
const AdminShopSubscriptionsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-subscriptions").then((m) => ({
    default: m.AdminShopSubscriptionsPage,
  })),
);
const AdminTeamPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-team").then((m) => ({
    default: m.AdminTeamPage,
  })),
);
const AdminOperationsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-operations").then((m) => ({
    default: m.AdminOperationsPage,
  })),
);
const AdminAccountSetupPage = lazyWithRetry(() =>
  import("@/pages/admin/account-setup").then((m) => ({
    default: m.AdminAccountSetupPage,
  })),
);
const AdminReportsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-reports").then((m) => ({
    default: m.AdminReportsPage,
  })),
);
const AdminControlCenterPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-control-center").then((m) => ({
    default: m.AdminControlCenterPage,
  })),
);
const AdminProductivityPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-productivity").then((m) => ({
    default: m.AdminProductivityPage,
  })),
);
const AdminBackordersPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-backorders").then((m) => ({
    default: m.AdminBackordersPage,
  })),
);
const AdminClosuresPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-closures").then((m) => ({
    default: m.AdminClosuresPage,
  })),
);
const AdminCompanyCalendarPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-company-calendar").then((m) => ({
    default: m.AdminCompanyCalendarPage,
  })),
);
const AdminAppointmentRequestsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-appointment-requests").then((m) => ({
    default: m.AdminAppointmentRequestsPage,
  })),
);
const AdminIntegrationsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-integrations").then((m) => ({
    default: m.AdminIntegrationsPage,
  })),
);
const AdminPacwarePage = lazyWithRetry(() =>
  import("@/pages/admin/admin-pacware").then((m) => ({
    default: m.AdminPacwarePage,
  })),
);
const AdminSystemConfigurationPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-system-configuration").then((m) => ({
    default: m.AdminSystemConfigurationPage,
  })),
);
const AdminConnectionTestsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-connection-tests").then((m) => ({
    default: m.AdminConnectionTestsPage,
  })),
);
const AdminBotPlaygroundPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-bot-playground").then((m) => ({
    default: m.AdminBotPlaygroundPage,
  })),
);
const AdminTherapyFleetPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-therapy-fleet").then((m) => ({
    default: m.AdminTherapyFleetPage,
  })),
);
const AdminTherapyResupplyPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-therapy-resupply").then((m) => ({
    default: m.AdminTherapyResupplyPage,
  })),
);
const AdminTherapyCompliancePage = lazyWithRetry(() =>
  import("@/pages/admin/admin-therapy-compliance").then((m) => ({
    default: m.AdminTherapyCompliancePage,
  })),
);
const AdminCoachingPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-coaching").then((m) => ({
    default: m.AdminCoachingPage,
  })),
);
const AdminClinicalPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-clinical").then((m) => ({
    default: m.AdminClinicalPage,
  })),
);
const AdminDeliveryFailuresPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-delivery-failures").then((m) => ({
    default: m.AdminDeliveryFailuresPage,
  })),
);
const AdminWebhookDeliveriesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-webhook-deliveries").then((m) => ({
    default: m.AdminWebhookDeliveriesPage,
  })),
);
const AdminRuleTesterPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-rule-tester").then((m) => ({
    default: m.AdminRuleTesterPage,
  })),
);
const AdminSettingsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-settings").then((m) => ({
    default: m.AdminSettingsPage,
  })),
);
const AdminShopInventoryPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-inventory").then((m) => ({
    default: m.AdminShopInventoryPage,
  })),
);
const AdminShopProductNewPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-product-new").then((m) => ({
    default: m.AdminShopProductNewPage,
  })),
);
const AdminShopInventoryReconcilePage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-inventory-reconcile").then((m) => ({
    default: m.AdminShopInventoryReconcilePage,
  })),
);
const AdminShopInventoryReconcileEditPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-inventory-reconcile-edit").then((m) => ({
    default: m.AdminShopInventoryReconcileEditPage,
  })),
);
const AdminShopAbandonedCartsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-abandoned-carts").then((m) => ({
    default: m.AdminShopAbandonedCartsPage,
  })),
);
const AdminShopBackInStockPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-back-in-stock").then((m) => ({
    default: m.AdminShopBackInStockPage,
  })),
);
const AdminInsuranceLeadsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-insurance-leads").then((m) => ({
    default: m.AdminInsuranceLeadsPage,
  })),
);
const AdminFitterLeadsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-fitter-leads").then((m) => ({
    default: m.AdminFitterLeadsPage,
  })),
);
const AdminFitterInvitesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-fitter-invites").then((m) => ({
    default: m.AdminFitterInvitesPage,
  })),
);
const AdminInsuranceClaimsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-insurance-claims").then((m) => ({
    default: m.AdminInsuranceClaimsPage,
  })),
);
const AdminBillingHubPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-hub").then((m) => ({
    default: m.AdminBillingHubPage,
  })),
);
const AdminBillingAiQueuePage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-ai-queue").then((m) => ({
    default: m.AdminBillingAiQueuePage,
  })),
);
const AdminBillingAgingPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-aging").then((m) => ({
    default: m.AdminBillingAgingPage,
  })),
);
const AdminSecondaryClaimsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-secondary-claims").then((m) => ({
    default: m.AdminSecondaryClaimsPage,
  })),
);
const AdminBillingStatementsSendPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-statements-send").then((m) => ({
    default: m.AdminBillingStatementsSendPage,
  })),
);
const AdminBillingCollectionsForecastPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-collections-forecast").then((m) => ({
    default: m.AdminBillingCollectionsForecastPage,
  })),
);
const AdminBillingCmnWorklistPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-cmn-worklist").then((m) => ({
    default: m.AdminBillingCmnWorklistPage,
  })),
);
const AdminBillingBillHoldPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-bill-hold").then((m) => ({
    default: m.AdminBillingBillHoldPage,
  })),
);
const AdminBillingTimelyFilingPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-timely-filing").then((m) => ({
    default: m.AdminBillingTimelyFilingPage,
  })),
);
const AdminPayerProfitabilityPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-payer-profitability").then((m) => ({
    default: m.AdminPayerProfitabilityPage,
  })),
);
const AdminBillingDenialsWorklistPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-denials-worklist").then((m) => ({
    default: m.AdminBillingDenialsWorklistPage,
  })),
);
const AdminBillingManualClaimPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-manual-claim").then((m) => ({
    default: m.AdminBillingManualClaimPage,
  })),
);
const AdminBillingDenialsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-denials").then((m) => ({
    default: m.AdminBillingDenialsPage,
  })),
);
const AdminBillingEraPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-era").then((m) => ({
    default: m.AdminBillingEraPage,
  })),
);
const AdminBillingEligibilityPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-eligibility").then((m) => ({
    default: m.AdminBillingEligibilityPage,
  })),
);
const AdminBillingVerifyPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-verify").then((m) => ({
    default: m.AdminBillingVerifyPage,
  })),
);
const AdminBillingEligibilityWorklistPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-eligibility-worklist").then((m) => ({
    default: m.AdminBillingEligibilityWorklistPage,
  })),
);
const AdminBillingPriorAuthsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-prior-auths").then((m) => ({
    default: m.AdminBillingPriorAuthsPage,
  })),
);
const AdminBillingConfigHubPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-config").then((m) => ({
    default: m.AdminBillingConfigHubPage,
  })),
);
const AdminBillingConfigPayersPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-config-payers").then((m) => ({
    default: m.AdminBillingConfigPayersPage,
  })),
);
const AdminBillingConfigOrganizationPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-config-organization").then((m) => ({
    default: m.AdminBillingConfigOrganizationPage,
  })),
);
const AdminBillingConfigClearinghousePage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-config-clearinghouse").then((m) => ({
    default: m.AdminBillingConfigClearinghousePage,
  })),
);
const AdminBillingConfigFeeSchedulesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-config-fee-schedules").then((m) => ({
    default: m.AdminBillingConfigFeeSchedulesPage,
  })),
);
const AdminBillingConfigModifierRulesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-config-modifier-rules").then((m) => ({
    default: m.AdminBillingConfigModifierRulesPage,
  })),
);
const AdminBillingConfigDenialCodesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-config-denial-codes").then((m) => ({
    default: m.AdminBillingConfigDenialCodesPage,
  })),
);
const AdminBillingConfigClaimTemplatesPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-config-claim-templates").then((m) => ({
    default: m.AdminBillingConfigClaimTemplatesPage,
  })),
);
const AdminBillingCappedRentalsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-capped-rentals").then((m) => ({
    default: m.AdminBillingCappedRentalsPage,
  })),
);
const AdminBillingOfficeAllyPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-office-ally").then((m) => ({
    default: m.AdminBillingOfficeAllyPage,
  })),
);
const AdminBillingAutoSubmitPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-auto-submit").then((m) => ({
    default: m.AdminBillingAutoSubmitPage,
  })),
);
const AdminOfficeAllySubmissionDetailPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-billing-office-ally-detail").then((m) => ({
    default: m.AdminOfficeAllySubmissionDetailPage,
  })),
);
const AdminNpsPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-nps").then((m) => ({ default: m.AdminNpsPage })),
);
const AdminCustomerDetailPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-customer-detail").then((m) => ({
    default: m.AdminCustomerDetailPage,
  })),
);
const AdminShopCustomersPage = lazyWithRetry(() =>
  import("@/pages/admin/admin-shop-customers").then((m) => ({
    default: m.AdminShopCustomersPage,
  })),
);
// Renamed-export pattern: the source files export AdminOrders /
// AdminOrderDetail / AdminReminders / AdminAnalytics but are bound to
// renamed Pennpaps* locals here. The lazy factory must map the source
// name to a default export under the renamed alias.
const PennpapsOrdersPage = lazyWithRetry(() =>
  import("@/pages/admin/pennpaps-orders").then((m) => ({
    default: m.AdminOrders,
  })),
);
const PennpapsOrderDetailPage = lazyWithRetry(() =>
  import("@/pages/admin/pennpaps-order-detail").then((m) => ({
    default: m.AdminOrderDetail,
  })),
);
const PennpapsRemindersPage = lazyWithRetry(() =>
  import("@/pages/admin/pennpaps-reminders").then((m) => ({
    default: m.AdminReminders,
  })),
);
const PennpapsAnalyticsPage = lazyWithRetry(() =>
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
  const canManageTools = (data?.permissions ?? []).includes(
    "admin.tools.manage",
  );

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
    <AppShell
      adminEmail={data?.email}
      adminRole={data?.role}
      adminPermissions={data?.permissions}
    >
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
              path="/admin/billing/secondary"
              component={AdminSecondaryClaimsPage}
            />
            <Route
              path="/admin/billing/statements"
              component={AdminBillingStatementsSendPage}
            />
            <Route
              path="/admin/billing/collections-forecast"
              component={AdminBillingCollectionsForecastPage}
            />
            <Route
              path="/admin/billing/cmn"
              component={AdminBillingCmnWorklistPage}
            />
            <Route
              path="/admin/billing/bill-hold"
              component={AdminBillingBillHoldPage}
            />
            <Route
              path="/admin/billing/timely-filing"
              component={AdminBillingTimelyFilingPage}
            />
            <Route
              path="/admin/billing/payer-profitability"
              component={AdminPayerProfitabilityPage}
            />
            <Route
              path="/admin/billing/denials-worklist"
              component={AdminBillingDenialsWorklistPage}
            />
            <Route
              path="/admin/billing/manual-claim"
              component={AdminBillingManualClaimPage}
            />
            <Route
              path="/admin/billing/denials"
              component={AdminBillingDenialsPage}
            />
            <Route path="/admin/billing/era" component={AdminBillingEraPage} />
            <Route
              path="/admin/billing/eligibility-recheck"
              component={AdminBillingEligibilityWorklistPage}
            />
            <Route
              path="/admin/billing/eligibility"
              component={AdminBillingEligibilityPage}
            />
            <Route
              path="/admin/billing/verify"
              component={AdminBillingVerifyPage}
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
              path="/admin/billing/config/organization"
              component={AdminBillingConfigOrganizationPage}
            />
            <Route
              path="/admin/billing/config/clearinghouse"
              component={AdminBillingConfigClearinghousePage}
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
              path="/admin/billing/auto-submit"
              component={AdminBillingAutoSubmitPage}
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
            <Route
              path="/admin/patient-packets"
              component={AdminPatientPacketsPage}
            />
            <Route path="/admin/documents" component={AdminDocumentsPage} />
            <Route
              path="/admin/signature-tracking"
              component={AdminSignatureTrackingPage}
            />
            {/* Literal segment — MUST precede /admin/patients/:id below. */}
            <Route
              path="/admin/patients/duplicates"
              component={AdminPatientsDuplicatesPage}
            />
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
            <Route path="/admin/email-inbox" component={EmailInboxPage} />
            <Route path="/admin/episodes" component={EpisodesPage} />
            <Route path="/admin/rules" component={RulesPage} />
            <Route
              path="/admin/compliance-rules"
              component={AdminComplianceRulesPage}
            />
            <Route path="/admin/locations" component={AdminLocationsPage} />
            <Route
              path="/admin/shop/reviews"
              component={AdminShopReviewsPage}
            />
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
              path="/admin/fitter-invites"
              component={AdminFitterInvitesPage}
            />
            <Route
              path="/admin/shop/customers"
              component={AdminShopCustomersPage}
            />
            <Route path="/admin/shop/customers/:userId">
              {(params) => <AdminCustomerDetailPage userId={params.userId} />}
            </Route>
            <Route
              path="/admin/shop/returns"
              component={AdminShopReturnsPage}
            />
            <Route path="/admin/followups" component={AdminFollowupsPage} />
            {/* /admin/today and /admin/work-queue merged into the Home
                landing (/admin); keep the URLs working for bookmarks. */}
            <Route path="/admin/today">
              <Redirect to="/admin" replace />
            </Route>
            <Route path="/admin/work-queue">
              <Redirect to="/admin" replace />
            </Route>
            <Route path="/admin/cases" component={AdminCasesPage} />
            <Route path="/admin/providers" component={AdminProvidersPage} />
            <Route
              path="/admin/provider-portal"
              component={AdminProviderEsignPage}
            />
            <Route
              path="/admin/inbound-faxes"
              component={AdminInboundFaxesPage}
            />
            <Route
              path="/admin/patients/:patientId/prescription-requests"
              component={AdminPrescriptionRequestsPage}
            />
            <Route
              path="/admin/equipment-recalls"
              component={AdminEquipmentRecallsPage}
            />
            <Route
              path="/admin/analytics/margin"
              component={AdminAnalyticsMarginPage}
            />
            <Route
              path="/admin/analytics/outreach-attribution"
              component={AdminAnalyticsOutreachAttributionPage}
            />
            <Route
              path="/admin/analytics/acquisition-funnel"
              component={AdminAnalyticsAcquisitionFunnelPage}
            />
            <Route
              path="/admin/analytics/revenue-by-source"
              component={AdminAnalyticsRevenueBySourcePage}
            />
            <Route
              path="/admin/analytics/channel-engagement"
              component={AdminAnalyticsChannelEngagementPage}
            />
            <Route
              path="/admin/analytics/ltv-cac"
              component={AdminLtvCacPage}
            />
            <Route
              path="/admin/analytics/inventory-turnover"
              component={AdminInventoryTurnoverPage}
            />
            <Route path="/admin/goals" component={AdminGoalsPage} />
            <Route path="/admin/kpi-alerts" component={AdminKpiAlertsPage} />
            <Route path="/admin/analytics" component={AdminAnalyticsPage} />
            <Route
              path="/admin/therapy-usage-report"
              component={AdminTherapyUsageReportPage}
            />
            <Route path="/admin/rt-overview" component={AdminRtOverviewPage} />
            <Route path="/admin/rt-outcomes" component={AdminRtOutcomesPage} />
            <Route
              path="/admin/clinical/interventions"
              component={AdminInterventionsPage}
            />
            <Route
              path="/admin/clinical/mask-fit"
              component={AdminMaskFitWorklistPage}
            />
            <Route
              path="/admin/clinical/outreach"
              component={AdminClinicalOutreachPage}
            />
            <Route
              path="/admin/clinical/education-videos"
              component={AdminEducationVideosPage}
            />
            <Route
              path="/admin/bulk-campaigns"
              component={AdminBulkCampaignsPage}
            />
            <Route
              path="/admin/playbooks"
              component={AdminOutreachPlaybooksPage}
            />
            <Route path="/admin/security" component={AdminSecurityPage} />
            <Route path="/admin/macros" component={AdminMacrosPage} />
            <Route
              path="/admin/templates"
              component={AdminMessageTemplatesPage}
            />
            <Route path="/admin/alerts">
              {() =>
                canManageTools ? (
                  <AdminAlertsPage />
                ) : (
                  <NotAuthorizedPage reason="not-authorized" />
                )
              }
            </Route>
            <Route
              path="/admin/shop/subscriptions"
              component={AdminShopSubscriptionsPage}
            />
            <Route path="/admin/team" component={AdminTeamPage} />
            <Route path="/admin/operations" component={AdminOperationsPage} />
            <Route
              path="/admin/account-setup"
              component={AdminAccountSetupPage}
            />
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
              path="/admin/live-staffing"
              component={AdminLiveStaffingPage}
            />
            <Route
              path="/admin/shop/backorders"
              component={AdminBackordersPage}
            />
            <Route path="/admin/closures" component={AdminClosuresPage} />
            <Route
              path="/admin/company-calendar"
              component={AdminCompanyCalendarPage}
            />
            <Route
              path="/admin/appointment-requests"
              component={AdminAppointmentRequestsPage}
            />
            <Route
              path="/admin/integrations"
              component={AdminIntegrationsPage}
            />
            <Route path="/admin/pacware" component={AdminPacwarePage} />
            <Route
              path="/admin/system/configuration"
              component={AdminSystemConfigurationPage}
            />
            <Route
              path="/admin/connection-tests"
              component={AdminConnectionTestsPage}
            />
            <Route
              path="/admin/bot-playground"
              component={AdminBotPlaygroundPage}
            />
            <Route
              path="/admin/therapy-fleet"
              component={AdminTherapyFleetPage}
            />
            <Route
              path="/admin/therapy-resupply"
              component={AdminTherapyResupplyPage}
            />
            <Route
              path="/admin/therapy-compliance"
              component={AdminTherapyCompliancePage}
            />
            <Route path="/admin/coaching" component={AdminCoachingPage} />
            <Route path="/admin/clinical" component={AdminClinicalPage} />
            <Route
              path="/admin/delivery-failures"
              component={AdminDeliveryFailuresPage}
            />
            <Route
              path="/admin/webhook-deliveries"
              component={AdminWebhookDeliveriesPage}
            />
            <Route path="/admin/rule-tester" component={AdminRuleTesterPage} />
            <Route path="/admin/settings" component={AdminSettingsPage} />
            <Route
              path="/admin/pennpaps/orders"
              component={PennpapsOrdersPage}
            />
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
