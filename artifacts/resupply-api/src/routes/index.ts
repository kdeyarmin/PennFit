import { Router, type IRouter } from "express";
import abandonedCartsRouter from "./admin/abandoned-carts.js";
import shopCustomersAdminRouter from "./admin/customers.js";
import shopCustomerNotesRouter from "./admin/customer-notes.js";
import shopCustomerFollowupsRouter from "./admin/customer-followups.js";
import customerTimelineRouter from "./admin/customer-timeline.js";
import followupsListRouter from "./admin/followups-list.js";
import shopOrderNotesRouter from "./admin/order-notes.js";
import productCostsRouter from "./admin/product-costs.js";
import metricAlertsRouter from "./admin/metric-alerts.js";
import metricThresholdsRouter from "./admin/metric-thresholds.js";
import clinicalEncountersRouter from "./admin/clinical-encounters.js";
import rtOutcomesRouter from "./admin/rt-outcomes.js";
import setupChecklistRouter from "./admin/setup-checklist.js";
import casesRouter from "./admin/cases.js";
import workItemsRouter from "./admin/work-items.js";
import businessTargetsRouter from "./admin/business-targets.js";
import agentAvailabilityRouter from "./admin/agent-availability.js";
import conversationsSearchRouter from "./admin/conversations-search.js";
import conversationDraftReplyRouter from "./admin/conversation-draft-reply.js";
import clickToDialRouter from "./admin/click-to-dial.js";
import shopOrdersAdminRouter from "./admin/shop-orders.js";
import shopProductsAdminRouter from "./admin/shop-products.js";
import inventoryReconciliationRouter from "./admin/inventory-reconciliation.js";
import csrMacrosRouter from "./admin/csr-macros.js";
import alertsRouter from "./admin/alerts.js";
import alertMessageOverridesRouter from "./admin/alert-message-overrides.js";
import messageTemplatesRouter from "./admin/message-templates.js";
import messageTemplateOverridesRouter from "./admin/message-template-overrides.js";
import shopReturnsAdminRouter from "./admin/shop-returns.js";
import shopReturnNotesRouter from "./admin/return-notes.js";
import shopReviewRequestsRouter from "./admin/shop-review-requests.js";
import teamRouter from "./admin/team.js";
import opsStatusRouter from "./admin/ops-status.js";
import inboxCountsRouter from "./admin/inbox-counts.js";
import todayRouter from "./admin/today.js";
import providersRouter from "./admin/providers.js";
import swoRouter from "./admin/swo.js";
import complianceAttestationRouter from "./admin/compliance-attestation.js";
import inboundFaxesRouter from "./admin/inbound-faxes.js";
import inboundReferralsRouter from "./admin/inbound-referrals.js";
import equipmentRecallsRouter from "./admin/equipment-recalls.js";
import analyticsRouter from "./admin/analytics.js";
import analyticsMarginRouter from "./admin/analytics-margin.js";
import inventoryTurnoverRouter from "./admin/inventory-turnover.js";
import ltvCacRouter from "./admin/ltv-cac.js";
import rtOverviewRouter from "./admin/rt-overview.js";
import productivityRouter from "./admin/productivity.js";
import patientDocumentsRetentionRouter from "./admin/patient-documents-retention.js";
import shopBackordersRouter from "./admin/shop-backorders.js";
import officeClosuresRouter from "./admin/office-closures.js";
import coachingPlansRouter from "./admin/coaching-plans.js";
import conversationRoutingRouter from "./admin/conversation-routing.js";
import conversationCoachingNotesRouter from "./admin/conversation-coaching-notes.js";
import conversationTriageRouter from "./admin/conversation-triage.js";
import patientAddressHistoryRouter from "./admin/patient-address-history.js";
import patientTimelineRouter from "./admin/patient-timeline.js";
import csrShiftsRouter from "./admin/csr-shifts.js";
import appointmentRequestsRouter from "./admin/appointment-requests.js";
import shopOrderLossClaimsRouter from "./admin/shop-order-loss-claims.js";
import carrierLabelsRouter from "./admin/carrier-labels.js";
import formAcknowledgementsRouter from "./admin/form-acknowledgements.js";
import patientFitOverridesRouter from "./admin/patient-fit-overrides.js";
import referralsAttributeRouter from "./admin/referrals-attribute.js";
import patientMaintenanceLogRouter from "./admin/patient-maintenance-log.js";
import resupplyFunnelRouter from "./admin/resupply-funnel.js";
import therapyUsageReportRouter from "./admin/therapy-usage-report.js";
import patientTherapyNightsManualRouter from "./admin/patient-therapy-nights-manual.js";
import patientIdentityVerificationsRouter from "./admin/patient-identity-verifications.js";
import providerPortalRouter from "./provider-portal.js";
import shopOrderPodRouter from "./admin/shop-order-pod.js";
import shopOrderPodUploadRouter from "./admin/shop-order-pod-upload.js";
import integrationsStatusRouter from "./admin/integrations-status.js";
import integrationsNightlySyncRouter from "./admin/integrations-nightly-sync.js";
import integrationsWebhooksRouter from "./integrations-webhooks.js";
import integrationsErrorsRouter from "./admin/integrations-errors.js";
import therapyFleetRouter from "./admin/therapy-fleet.js";
import therapyResupplyRouter from "./admin/therapy-resupply.js";
import therapyComplianceRouter from "./admin/therapy-compliance.js";
import integrationsRefreshSuppliesRouter from "./admin/integrations-refresh-supplies.js";
import integrationsSyncEquipmentRouter from "./admin/integrations-sync-equipment.js";
import bulkCampaignsRouter from "./admin/bulk-campaigns.js";
import mfaRouter from "./admin/mfa.js";
import reportsRouter from "./admin/reports.js";
import reportPresetsRouter from "./admin/report-presets.js";
import featureFlagsRouter from "./admin/feature-flags.js";
import npsSummaryRouter from "./admin/nps-summary.js";
import deliveryFailuresRouter from "./admin/delivery-failures.js";
import lookupRouter from "./admin/lookup.js";
import systemInfoRouter from "./admin/system-info.js";
import shopReviewsAdminRouter from "./admin/shop-reviews.js";
import shopProductQuestionsAdminRouter from "./admin/product-questions.js";
import csrComplianceAlertsRouter from "./admin/csr-compliance-alerts.js";
import patientOnboardingRouter from "./admin/patient-onboarding.js";
import patientPortalInviteRouter from "./admin/patient-portal-invite.js";
import prescriptionRenewalsRouter from "./admin/prescription-renewals.js";
import shopProductCompatibilityAdminRouter from "./admin/product-compatibility.js";
import patientTherapySyncRouter from "./admin/patient-therapy-sync.js";
import patientResupplySummaryRouter from "./admin/patient-resupply-summary.js";
import patientTherapyLinksRouter from "./admin/patient-therapy-links.js";
import patientIntegrationsRouter from "./admin/patient-integrations.js";
import smartTriggersRouter from "./admin/smart-triggers.js";
import physicianFaxOutreachRouter from "./admin/physician-fax-outreach.js";
import shopBackInStockAdminRouter from "./admin/shop-back-in-stock.js";
import shopSubsMetricsRouter from "./admin/shop-subscriptions-metrics.js";
import insuranceLeadsAdminRouter from "./admin/insurance-leads.js";
import fitterLeadsAdminRouter from "./admin/fitter-leads.js";
import payerProfilesRouter from "./admin/payer-profiles.js";
import officeAllySubmissionsRouter from "./admin/office-ally-submissions.js";
import officeAllyUploadAckRouter from "./admin/office-ally-upload-ack.js";
import denialCodesRouter from "./admin/denial-codes.js";
import payerFeeSchedulesRouter from "./admin/payer-fee-schedules.js";
import eraIngestRouter from "./admin/era-ingest.js";
import billingReportsRouter from "./admin/billing-reports.js";
import payerProfitabilityRouter from "./admin/payer-profitability.js";
import denialsWorklistRouter from "./admin/denials-worklist.js";
import eligibilityVerificationWorklistRouter from "./admin/eligibility-verification-worklist.js";
import priorAuthRenewalRouter from "./admin/prior-auth-renewal.js";
import manualClaimRouter from "./admin/manual-claim.js";
import billingTimelyFilingRouter from "./admin/billing-timely-filing.js";
import billingDashboardRouter from "./admin/billing-dashboard.js";
import productHcpcsMapRouter from "./admin/product-hcpcs-map.js";
import payerModifierRulesRouter from "./admin/payer-modifier-rules.js";
import claimTemplatesRouter from "./admin/claim-templates.js";
import fulfillmentToClaimRouter from "./admin/fulfillment-to-claim.js";
import aiBillingQueueRouter from "./admin/ai-billing-queue.js";
import dmeOrganizationRouter from "./admin/dme-organization.js";
import clearinghouseCredentialsRouter from "./admin/clearinghouse-credentials.js";
import goodFaithEstimatesRouter from "./admin/good-faith-estimates.js";
import pecosStatusRouter from "./admin/pecos-status.js";
import eligibilityChecksRouter from "./admin/eligibility-checks.js";
import sameOrSimilarRouter from "./admin/same-or-similar.js";
import cappedRentalCyclesRouter from "./admin/capped-rental-cycles.js";
import dwoDocumentsRouter from "./admin/dwo-documents.js";
import adherencePredictionsRouter from "./admin/adherence-predictions.js";
import shopMembershipRouter from "./admin/shop-membership.js";
import fhirRouter from "./fhir/index.js";
import davinciPasSubmitRouter from "./admin/davinci-pas-submit.js";
import billingBenchmarksRouter from "./admin/billing-benchmarks.js";
import billingBatchSubmitRouter from "./admin/billing-batch-submit.js";
import billingStatementsRouter from "./admin/billing-statements.js";
import claimAppealsRouter from "./admin/claim-appeals.js";
import webhookSubscriptionsRouter from "./admin/webhook-subscriptions.js";
import webhookEventCatalogRouter from "./admin/webhook-event-catalog.js";
import billingDirectorRouter from "./admin/billing-director.js";
import eligibilityRecentRouter from "./admin/eligibility-recent.js";
import priorAuthQueueRouter from "./admin/prior-auth-queue.js";
import webhookTestSendRouter from "./admin/webhook-test-send.js";
import payerFeeSchedulesImportRouter from "./admin/payer-fee-schedules-import.js";
import systemIntegrationsStatusRouter from "./admin/system-integrations-status.js";
import integrationsInboundRouter from "./integrations-inbound.js";
import documentationPacketsRouter from "./admin/documentation-packets.js";
import webhookDeliveryRetryRouter from "./admin/webhook-delivery-retry.js";
import dispenseReadinessRouter from "./admin/dispense-readiness.js";
import conversationsRouter from "./conversations/index.js";
import dashboardRouter from "./dashboard/index.js";
import emailRouter from "./email/index.js";
import episodesRouter from "./episodes/index.js";
import healthRouter from "./health.js";
import meRouter from "./me.js";
import patientsRouter from "./patients/index.js";
import rulesRouter from "./rules/index.js";
import smsRouter from "./sms/index.js";
import shopRouter from "./shop/index.js";
import faxRouter from "./fax/index.js";
import portalClinicianRouter from "./portal-clinician.js";
import rxRequestDocumentRouter from "./rx-request-document.js";
import prescriptionRequestsRouter from "./admin/prescription-requests.js";
import voiceRouter from "./voice/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
// Public shop routes (no auth) — patient-facing cash-pay catalog,
// Stripe Hosted Checkout, and order summary lookup. Mounted before
// the admin-gated routes so the literal /shop/* paths can never be
// shadowed by a future param route.
router.use(shopRouter);
// Voice + SMS + Fax + Email routes are mounted unconditionally; each
// handler does its own feature-flag check so a missing env var becomes
// a clean 503 (or TwiML 503 for vendor-only paths) rather than a 404.
router.use(voiceRouter);
router.use(smsRouter);
// /fax/document/:token  — signed cover-letter PDF fetched by Twilio
// /fax/status-callback  — Twilio fax delivery lifecycle webhook
router.use(faxRouter);
// /portal/clinician/:token — public referral status page for EHR
// partners who don't consume webhook callbacks. Token-gated; no
// session cookie required.
router.use(portalClinicianRouter);
// /rx-request/document/:token — Twilio fetches a fully-rendered
// pre-populated prescription PDF here when an admin dispatches a
// prescription-request packet. Token-gated; signed HMAC w/ 24h TTL.
router.use(rxRequestDocumentRouter);
router.use(emailRouter);
// Admin-console READ endpoints. Each handler is gated by
// requireAdmin and surfaces only PHI the dashboard needs to
// render — decrypted name on lists, decrypted message bodies only on
// the conversation detail endpoint, never phone or email values.
router.use(dashboardRouter);
router.use(patientsRouter);
router.use(rulesRouter);
router.use(conversationsRouter);
router.use(episodesRouter);
// /admin/shop/abandoned-carts/* — operator tooling for the cart-
// abandonment SendGrid nudge (list + manual dispatcher trigger).
// requireAdmin gate is on the router itself.
router.use(abandonedCartsRouter);
// /admin/shop/reviews/* — moderation queue for customer-submitted
// product reviews. Reviews are pending by default and only become
// publicly visible after an admin approves them. requireAdmin gate
// is on the router itself.
router.use(shopReviewsAdminRouter);
// /admin/shop/product-questions — moderation queue + answer flow
// for customer-submitted product Q&A (Phase A.5). Pending questions
// only become publicly visible after a CSR posts an answer.
router.use(shopProductQuestionsAdminRouter);
// /admin/patients/:id/onboarding + /admin/onboarding/send-due —
// first-90-day adherence-coaching enrollment + dispatcher (Phase
// B.1 / feature #17). The CMS adherence threshold is missed by
// 40-70% of patients in the first 90 days; this surface fires the
// scheduled day-1/7/30/90 nudges that reverse that.
router.use(patientOnboardingRouter);
// /admin/csr-compliance-alerts/* — at-risk queue surfaced to CSRs by
// the daily compliance scanner (low-usage from patient_therapy_nights,
// no-response after a check-in send, vendor-failure clusters). CSRs
// resolve / snooze rows from the dashboard with a one-line note.
router.use(csrComplianceAlertsRouter);
// /admin/patients/:id/portal-invite — CSR-driven patient portal
// invitation. Lets agents send a "set up your portal" email to a
// patient, optionally filling in required onboarding fields at the
// same time. Resend + revoke follow the same pattern as team invites.
router.use(patientPortalInviteRouter);
// /admin/prescriptions/send-renewal-due — prescription concierge
// dispatcher (Phase B.2 / feature #7). Scans active prescriptions
// expiring within 30 days and emails the patient to coordinate
// renewal. Aeroflow built its brand on this.
router.use(prescriptionRenewalsRouter);
// /admin/shop/products/:productId/compatibility — admin CRUD for
// the product-to-machine compatibility map (Phase B.3 / feature
// #11). Public reads live alongside the catalog router.
router.use(shopProductCompatibilityAdminRouter);
// /admin/shop/inventory/reconciliations/* — monthly physical-count
// workflow. Admin enters counted quantities per SKU, server records
// variance against the live Stripe stock_count, optionally pushes
// the new counts back to Stripe. requireAdmin gate via
// requirePermission("admin.tools.manage") on the router.
router.use(inventoryReconciliationRouter);
// /admin/patients/:id/therapy-nights/* — therapy-cloud sync
// (Phase E.1 / feature #18). Adapter stubs for ResMed AirView +
// Philips Care; the actual partner integration lands once a BAA
// + API access is in place. Sync endpoint 503s until the chosen
// adapter's env var is set.
router.use(patientTherapySyncRouter);
// /admin/patients/:id/resupply-summary — single round-trip
// aggregate of the last 60 therapy nights + open smart-trigger
// events + open compliance alerts + 30-day Medicare adherence
// math. Source for the Resupply tab on patient detail.
router.use(patientResupplySummaryRouter);
// /admin/patients/:id/therapy-links/* — durable per-patient mapping
// to a therapy-cloud account so the nightly sync worker doesn't
// need a human re-typing the partner id. See patient-therapy-sync
// above for the read/import companion.
router.use(patientTherapyLinksRouter);
// /admin/patients/:id/integrations — unified "Device data" view
// across ResMed AirView, Philips Care, and Health Connect. Reads
// from patient_integration_snapshots; refresh endpoint calls the
// vendor adapter and UPSERTs.
router.use(patientIntegrationsRouter);
// /admin/smart-triggers/* — data-driven reorder-trigger evaluator +
// dispatcher (Phase E.2 / feature #19). Reads patient_therapy_nights,
// runs the rule library, queues + sends nudges that convert at 3-5x
// the rate of calendar-only reminders.
router.use(smartTriggersRouter);
// /admin/physician-fax-outreach — record + dispatch physician-fax
// Rx-renewal requests (Phase G.6). Dispatches via Twilio when
// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FAX_FROM_NUMBER
// are set; otherwise the row is created with status='pending'.
router.use(physicianFaxOutreachRouter);
// /admin/(patients/:id)/prescription-requests — physician-faxable
// pre-populated prescriptions. Twilio dispatch, signed-PDF return,
// CSR-stamped lifecycle. Renders via lib/prescription-request-pdf.ts.
router.use(prescriptionRequestsRouter);
// /admin/shop/back-in-stock-queue — visibility into who's waiting
// for which OOS SKU + manual fanout trigger. requireAdmin gate is
// on the router itself.
router.use(shopBackInStockAdminRouter);
// /admin/shop/insurance-leads/* — durable queue + status mutations
// for submissions to the public POST /shop/insurance-leads form.
// requireAdmin gate is on the router itself.
router.use(insuranceLeadsAdminRouter);
// /admin/fitter-leads/* — funnel queue + conversion KPIs for the
// at-home fitter. Powers the "Fitter Prospects" admin page; the
// dispatchers (fitter-supply-campaign + fitter-conversion-
// attribution) handle the actual sends and conversion stamps.
router.use(fitterLeadsAdminRouter);
// /admin/payer-profiles/* — Pennsylvania payer catalog (migration
// 0128). Read by every admin; write restricted to requireAdminOnly.
// Drives 837P NM1*PR loop population on Office Ally submissions.
router.use(payerProfilesRouter);
// /admin/office-ally-submissions/* — read + ack-ingest surface for
// 837P claim files uploaded to Office Ally. The actual submit POST
// lives on the patients router so it's co-located with the per-claim
// state machine.
router.use(officeAllySubmissionsRouter);
// /admin/office-ally/upload-ack — manual ack-file ingestion path
// (admin-only) for when the poller can't reach OA or OA emails an
// ack out-of-band. Reuses the dispatchers exported from the poll
// worker so manual + auto paths share parsing + state-machine
// updates.
router.use(officeAllyUploadAckRouter);
// /admin/denial-codes/* — CARC / RARC catalog (Phase 4 of the
// billing build). Seeded in migration 0129 with the ~50 codes DME
// suppliers hit most often; admin UI surfaces them on claim denials.
router.use(denialCodesRouter);
// /admin/payer-fee-schedules/* — payer + HCPCS expected-allowed
// catalog. Drives the partial-pay variance triage on ERA ingest.
router.use(payerFeeSchedulesRouter);
// /admin/product-costs/* — operator-managed unit cost (COGS) per shop
// SKU. The COGS analog of the fee-schedule catalog; source for the
// per-transaction cost snapshots + every owner-facing margin surface.
router.use(productCostsRouter);
// /admin/metric-alerts/* — the in-app KPI alert feed (F2 metrics
// substrate). Alerts written by the metrics.alerts-evaluator worker.
router.use(metricAlertsRouter);
// /admin/metric-thresholds/* — owner CRUD for the KPI alert rules the
// evaluator walks (Owner #5). Read on metrics.read, write on
// admin.tools.manage.
router.use(metricThresholdsRouter);
// /admin/patients/:id/clinical-encounters — append-only clinician
// documentation (F3). Read on clinical.read, write on clinical.note.write.
router.use(clinicalEncountersRouter);
// /admin/analytics/rt-outcomes — per-RT outcomes rollup from
// clinical_encounters (Phase 3, RT #24). Counts only; clinical.read.
router.use(rtOutcomesRouter);
// /admin/patients/:id/setup-checklist — new-patient setup-guidance
// checklist (Phase 1, RT). Gated by the clinical perms.
router.use(setupChecklistRouter);
// /admin/cases — lightweight CSR case (ticket) object + links (F4).
router.use(casesRouter);
// /admin/work-items — the unified, prioritized CSR work queue (F4),
// UNIONing the open work across every triage source.
router.use(workItemsRouter);
// /admin/business-targets — owner goal / target tracking (Phase 1).
router.use(businessTargetsRouter);
// /admin/agent-availability — CSR availability toggle (Phase 1); the
// skill-router skips away / do-not-assign reps.
router.use(agentAvailabilityRouter);
// /admin/conversations-search — search conversations by message content
// (Phase 1, CSR #13).
router.use(conversationsSearchRouter);
// POST /admin/conversations/:id/draft-reply — AI-draft the next reply
// (Phase 4, CSR #15). Draft only; degrades soft when AI is unavailable.
router.use(conversationDraftReplyRouter);
// /admin/patients/:id/click-to-dial + /admin/call-dispositions/:id —
// CSR click-to-dial bridge + post-call disposition logging (#11).
router.use(clickToDialRouter);
// /admin/billing/era-ingest + /admin/billing/era-files — upload a
// 5010 835 remittance, parse it, auto-reconcile claim totals + line
// items + insert paid/denied events.
router.use(eraIngestRouter);
// /admin/billing/aging-report + /admin/billing/dso-by-payer +
// /admin/billing/denial-rate — read-only AR + reporting dashboards
// for the billing team.
router.use(billingReportsRouter);
// /admin/billing/timely-filing — open-claim filing-deadline worklist,
// ranked most-urgent-first (days left before the payer's timely-filing
// window closes). Pure countdown core in @workspace/resupply-domain.
router.use(billingTimelyFilingRouter);
// /admin/billing/payer-profitability — per-payer net yield (Owner #2):
// billed → allowed → collected, denial rate, net of F1 COGS. cost.read.
router.use(payerProfitabilityRouter);
// /admin/billing/denials-worklist — denied claims ranked by recoverable
// $ × win-probability (Biller #33). reports.read.
router.use(denialsWorklistRouter);
// /admin/billing/eligibility-verification-worklist — active coverages
// ranked by re-verification urgency (never/terminating/stale) (Biller
// #31, read-only half). reports.read.
router.use(eligibilityVerificationWorklistRouter);
// /admin/prior-authorizations/:id/draft-renewal — one-click renewal
// draft cloned from an expiring/expired PA (Biller #35). patients.update.
router.use(priorAuthRenewalRouter);
// /admin/patients/:id/manual-claims — hand-keyed corrected /
// void-replacement / paper-backup claim entry (Biller #32). The X12
// resubmission fields live in migration 0195. patients.update.
router.use(manualClaimRouter);
// /admin/billing/dashboard — single round-trip "what needs my
// attention today" view for the billing CSR. Aggregate counts +
// dollar amounts only; the UI deep-links by id.
router.use(billingDashboardRouter);
// /admin/product-hcpcs-map/* — shop SKU → HCPCS catalog. Drives the
// "build from fulfillment" auto-population.
router.use(productHcpcsMapRouter);
// /admin/payer-modifier-rules/* — payer + HCPCS auto-attach modifier
// rules (KX, KH, KI, RR, NU…) evaluated by the claim builder.
router.use(payerModifierRulesRouter);
// /admin/claim-templates + /admin/patients/:id/insurance-claims/:claimId/apply-template
// — pre-built line-item shapes the CSR can one-click stamp onto a draft.
router.use(claimTemplatesRouter);
// /admin/fulfillments/:fulfillmentId/create-claim — one-click claim
// creation from a shipped fulfillment row. Runs the claim builder
// (HCPCS map + modifier rules + fee schedule + diagnosis + prescriber)
// and inserts the populated draft.
router.use(fulfillmentToClaimRouter);
// /admin/billing/ai-queue — AI scrub + denial-analysis worklist
// surfacing claims blocked / fixable / awaiting analysis / ready
// for one-click auto-resubmit.
router.use(aiBillingQueueRouter);
// /admin/dme-organization + /admin/dme-organization/contacts — the
// singleton DME identity row + named contact roster. Authoritative
// source for the 837P billing-provider loop, HCFA PDF, accreditation
// binder, and ABN / SWO authorized signer text.
router.use(dmeOrganizationRouter);
// /admin/clearinghouse-credentials/* — editable per-clearinghouse
// SFTP + ETIN config. Includes /test endpoint for the "verify
// connection" button and /admin/office-ally/poll-now manual trigger,
// plus /admin/clearinghouse-inbound-files for the polled-file audit.
router.use(clearinghouseCredentialsRouter);
// /admin/accreditation/readiness — survey-readiness audit results +
// /admin/accreditation/surveys CRUD for scheduled + completed visits.
// CMS-required annual unannounced surveys land Jan 1, 2026.
// /admin/good-faith-estimates — No Surprises Act cash-pay GFE
// generator. PDF stream + persistent audit row (3-year HHS
// retention requirement).
router.use(goodFaithEstimatesRouter);
// /admin/providers-pecos — CMS PECOS ordering-provider sync. Daily
// auto-sync via the worker plus a manual sync-now trigger.
router.use(pecosStatusRouter);
// /admin/patients/:id/insurance-coverages/:coverageId/verify-eligibility
// + /admin/patients/:id/eligibility-checks — X12 270/271 round-trip.
router.use(eligibilityChecksRouter);
// /admin/patients/:id/same-or-similar — Medicare HETS Same-or-Similar
// cache. Manual recording today; HETS adapter lands later.
router.use(sameOrSimilarRouter);
// /admin/capped-rental-cycles/* — 13/36-month rental lifecycle CRUD
// + manual advance trigger. Daily worker advances cycles
// automatically.
router.use(cappedRentalCyclesRouter);
// /admin/dwo-documents/* — DWO / CMN / SWO renewal tracking with
// T-60/T-30/T-7 alert sweep.
router.use(dwoDocumentsRouter);
// /admin/patients/:id/adherence/score + /history — heuristic
// adherence predictor + history; at-risk list at /admin/adherence/at-risk.
router.use(adherencePredictionsRouter);
// /admin/shop/customers/:id/membership — cash-pay membership tier
// management (Stripe Subscriptions handles billing).
router.use(shopMembershipRouter);
// /fhir/r4/* — read-only FHIR R4 patient surface (Cures Act +
// USCDI v4 future-proofing). CapabilityStatement, Patient, and
// Patient/$everything (Coverage + Condition + MedicationRequest +
// Device) exposed today.
router.use(fhirRouter);
// /admin/patients/:id/prior-authorizations/:paId/submit-davinci-pas
// — FHIR-based PA submission per Da Vinci PAS IG v2.2 (CMS-0057-F).
router.use(davinciPasSubmitRouter);
// /admin/billing/benchmarks — internal cohort percentiles (Phase 1).
router.use(billingBenchmarksRouter);
// /admin/billing/batch-submit-office-ally — multi-claim 837P batch.
router.use(billingBatchSubmitRouter);
// /admin/patients/:id/billing-statements — patient statement PDF.
router.use(billingStatementsRouter);
// /admin/patients/:id/insurance-claims/:claimId/appeal-letter — PDF.
router.use(claimAppealsRouter);
// /admin/webhook-subscriptions + /admin/webhook-deliveries — outbound
// event subscription CRUD + recent-delivery audit.
router.use(webhookSubscriptionsRouter);
// /admin/webhook-event-catalog — static schema of every event type
// the API publishes (single source of truth for the subscription
// validator + the docs page).
router.use(webhookEventCatalogRouter);
// /admin/billing/director-summary — single round-trip the billing
// director loads every morning. Consolidates counts + dollar
// rollups + denial-rate trend + top payers + webhook health.
router.use(billingDirectorRouter);
// /admin/billing/eligibility-recent — system-wide recent
// eligibility checks (last 30 days by default), feeding the
// verification team's daily worklist.
router.use(eligibilityRecentRouter);
// /admin/billing/prior-auth-queue — system-wide PA queue grouped
// by at-risk / missed SLA / awaiting decision / expiring soon /
// drafts. Source for the admin PA director page.
router.use(priorAuthQueueRouter);
// /admin/webhook-subscriptions/:id/test-send — fire a synthetic
// webhook delivery to validate the subscriber endpoint end-to-end.
router.use(webhookTestSendRouter);
// /admin/payer-fee-schedules/import-csv — bulk CSV import.
router.use(payerFeeSchedulesImportRouter);
// /admin/system/integrations-status — admin-facing rollup of every
// integration's configured/configured-partial/unconfigured posture.
router.use(systemIntegrationsStatusRouter);
// /integrations/inbound/:source — public-mount inbound webhook
// intake for third-party deliveries (Parachute, HSAT vendors, etc).
router.use(integrationsInboundRouter);
// /admin/hipaa-breach-incidents — HIPAA §164.404-414 lifecycle.
// /admin/patients/:id/documentation-packets — combined PDF
// support packets (cover letter + sleep study + Rx + DWO summaries).
router.use(documentationPacketsRouter);
// /admin/webhook-deliveries/:id/retry-now — manual re-queue of an
// exhausted/failed delivery.
router.use(webhookDeliveryRetryRouter);
// /admin/patients/:id/dispense-readiness-reviews/* + /admin/dispense-readiness/queue
// — AI-augmented pre-dispense readiness reviewer. ~30 deterministic
// checks across patient identity / insurance / clinical / provider /
// PA / forms / equipment / DME-org compliance + an LLM synthesizer
// that produces a plain-English action plan with specific "how to
// obtain" guidance for every gap.
router.use(dispenseReadinessRouter);
// ── Phase 10 (compliance machinery, migration 0141) ──────────────
// /admin/compliance/business-associate-agreements — HIPAA
// §164.504(e) BAA inventory + expiry buckets.
// /admin/compliance/oig-leie-screenings — record + list OIG LEIE
// monthly exclusion-list screens against staff / providers /
// BAs / contractors. Coverage rollup flags overdue subjects.
// /admin/compliance/patient-rights-requests — HIPAA
// §164.522/524/526/528 access / amendment / accounting /
// restriction / confidential-communications workflow with the
// 30-day response clock (single 30-day extension allowed).
// /admin/compliance/risk-assessments + contingency-attestations +
// disaster-drills + qi-initiatives + qi-measurements +
// ownership-disclosures + disclosure-log — registers that close
// out §164.308(a)(1)/(a)(7), ACHC QAPI, and §424.57(c)(17).
// /admin/compliance/officer-summary — single round-trip rollup the
// compliance officer loads every morning. Aggregate counts across
// BAA inventory, OIG screening, patient rights, disclosures, risk
// assessments, contingency / drills, QAPI, ownership, training,
// grievances, and the most recent accreditation readiness run.
// /admin/shop/products/* — operator tooling for the cash-pay catalog
// itself. Today: PATCH stock_count metadata on a Stripe Product.
// requireAdmin gate is on the router itself.
router.use(shopProductsAdminRouter);
// /admin/shop/orders/* — fulfillment tooling on shop_orders rows
// (tracking entry, mark-delivered, address override, refund issuance).
// requireAdmin gate is on the router itself.
router.use(shopOrdersAdminRouter);
// /admin/shop/orders/:orderId/notes — internal CSR notes per shop
// order (Phase 14). Mounted after the orders router so the more-
// specific /notes path doesn't shadow any future detail GET.
router.use(shopOrderNotesRouter);
// /admin/shop/returns/* — comfort-guarantee swap / refund / RMA
// queue. Linear lifecycle (requested → approved → shipped_back →
// received → refunded|replaced|closed) with strict from-state
// assertions on every transition.
router.use(shopReturnsAdminRouter);
// /admin/shop/returns/:returnId/notes — internal CSR notes per
// return (Phase 15). Mounted after the returns router so the more-
// specific /notes path doesn't shadow the lifecycle endpoints.
router.use(shopReturnNotesRouter);
// /admin/csr-macros/* — admin CRUD for the canned-reply library used
// by the in-thread reply composer. See migration 0017 + the
// macroMerge helper in the dashboard for the {{namespace.key}}
// substitution syntax.
router.use(csrMacrosRouter);
// /admin/alerts/* — the alert library: a curated catalog of
// email/SMS/voice alerts with editable per-channel messages, plus a
// send action. Reading/editing is admin.tools.manage-gated; sending
// is requireAdmin + rate-limited. The dispatch path degrades to a
// hard-coded fallback when the seed rows are missing, so the route is
// forward-deploy-safe before migration 0179 is applied.
router.use(alertsRouter);
// /admin/patients/:patientId/alert-message-overrides/* — per-patient
// overrides of the alert library. The dispatch path layers an active
// override per-field over the global alert message; isActive=false
// suppresses the alert for that patient on that channel. Same
// admin.tools.manage gate + forward-deploy-safe posture as the global
// surface (migration 0180; dispatch degrades to the global on a
// missing override table).
router.use(alertMessageOverridesRouter);
// /admin/message-templates/* — admin read + edit for the
// customer-message template library (Phase 1 of
// docs/proposals/customer-message-templates.md). The render path
// (lib/resupply-templates) falls back to each call site's
// hard-coded baseline when the table is missing or the lookup
// fails, so this route is forward-safe even before the migration
// is journaled — see lib/resupply-db/drizzle/0067_message_templates.sql
// for the journal posture.
router.use(messageTemplatesRouter);
// /admin/shop/customers/:userId/message-template-overrides/* —
// per-customer overrides for the global library (Phase 3 of
// docs/proposals/customer-message-templates.md). Same posture as
// the parent route: forward-deploy-safe via the lookup-fallback
// chain even before the migration is journaled.
router.use(messageTemplateOverridesRouter);
// /admin/shop/subscriptions/metrics — KPI rollup for the
// subscription health dashboard. Pure SQL aggregation — no Stripe
// round-trip on this path.
router.use(shopSubsMetricsRouter);
// /admin/shop/review-requests/send-due — manual dispatcher for the
// post-purchase review-request email. Same atomic-claim pattern as
// the abandoned-cart dispatcher; comm-prefs + DND aware.
router.use(shopReviewRequestsRouter);
// /admin/team/* — DB-backed admin/CSR team management. Supplements
// (does not replace) the RESUPPLY_ADMIN_EMAILS env var allowlist;
// see middlewares/requireAdmin.ts for the resolution order.
router.use(teamRouter);
// /admin/ops-status — operations center status feed: vendor flags,
// dispatcher-eligible row counts, team counts. Read-only.
router.use(opsStatusRouter);
// /admin/inbox-counts — actionable-work counters for nav badges
// (awaiting-reply convs, pending returns, pending reviews). Read-
// only, called on every nav render with a 30s SPA cache.
router.use(inboxCountsRouter);
// /admin/today — unified CSR work queue; top items across the
// queues a CSR touches every day (conversations awaiting reply,
// overdue followups, pending returns, compliance alerts, Rx
// renewals due, documents to review). One round-trip; ~5 items
// per queue. The /admin/today SPA page renders this directly.
router.use(todayRouter);
// /admin/providers/* — central physician/NP registry. Replaces the
// free-text jsonb prescriber data scattered across prescriptions
// and shop_customers. NPPES lookup endpoint proxies the public
// NPI registry so CSRs autofill provider records instead of
// re-keying.
router.use(providersRouter);
// /admin/patients/:id/prescriptions/:rxId/swo — render the
// CMS-standardized Standard Written Order as a streaming PDF.
// Consumes the providers FK + sleep_studies ICD-10 introduced in
// the Tier-2a sprint.
router.use(swoRouter);
// /admin/patients/:id/compliance-attestation — render the 90-day
// Medicare LCD L33718 adherence attestation as a streaming PDF.
// Sliding 30-day window finder lives in
// lib/compliance-attestation.ts and is unit-tested without pdfkit.
router.use(complianceAttestationRouter);
// /admin/inbound-faxes/* — triage queue for faxes Twilio delivers.
// The webhook lives at /fax/inbound (mounted elsewhere); this is
// the CSR-facing surface for listing, attaching to patient/Rx/
// provider, and archiving.
router.use(inboundFaxesRouter);
// /admin/inbound-referrals/* — triage queue for electronic
// referral orders that landed via /integrations/inbound/parachute
// (and, in Phase 4, EHR FHIR sources). Mirror of the inbound-faxes
// surface for the typed-referral schema in migration 0144.
router.use(inboundReferralsRouter);
// /admin/equipment-recalls/* — manufacturer recall registry + the
// scan endpoint that surfaces affected patients. Required for
// Philips-DreamStation-style workflows where every DME needs to
// know which dispensed serials are in the recall lot.
router.use(equipmentRecallsRouter);
// /admin/analytics/* — clinical-side analytics (resupply funnel,
// compliance cohorts, CSR productivity). Distinct from storefront
// analytics at /admin/storefront/analytics which covers orders +
// email health + mask popularity.
router.use(analyticsRouter);
// /admin/analytics/margin — gross-margin / COGS dashboard (Owner #1).
// Folds the F1 cost snapshots on shop_order_items through the shared
// margin core; keeps the costed/uncosted revenue split explicit.
router.use(analyticsMarginRouter);
// /admin/analytics/inventory-turnover — turnover (annualized COGS ÷
// inventory value) + stockout demand per SKU (Owner #7). cost.read.
router.use(inventoryTurnoverRouter);
// /admin/analytics/ltv-cac + /admin/customers/:id/acquisition — LTV &
// CAC cohort economics by acquisition channel (Owner #3). cost.read to
// view, cost.write to record attribution.
router.use(ltvCacRouter);
// /admin/rt-overview — respiratory-therapist at-a-glance board.
// Reads patient_therapy_links + patient_therapy_nights +
// patient_smart_trigger_events for the daily clinical review.
router.use(rtOverviewRouter);
// /admin/patient-documents/retention/* — HIPAA retention sweep
// review queue, legal-hold toggle, and (admin-only) destruction.
router.use(patientDocumentsRetentionRouter);
// /admin/shop/backorders + /admin/shop/sku-substitutes — resupply
// substitution catalog. requireAdmin for backorder marks (CSR
// day-to-day); requireAdminOnly for substitute rule changes
// (clinical preference order).
router.use(shopBackordersRouter);
// /admin/office-closures — CSR-managed closure windows; inbound
// SMS during an active window gets the closure auto-reply.
router.use(officeClosuresRouter);
// /admin/coaching-plans/* — adherence coaching workflow that
// layers an outreach state machine on top of csr_compliance_alerts.
router.use(coachingPlansRouter);
// Skill-based conversation routing — PATCH skill arrays + a
// GET assignee-suggestions endpoint that scores active admins.
router.use(conversationRoutingRouter);
// Supervisor coaching notes on conversations (Tier 1 J).
router.use(conversationCoachingNotesRouter);
// Conversation triage (Wave 1): snooze / tags / claim.
router.use(conversationTriageRouter);
// Patient address change history.
router.use(patientAddressHistoryRouter);
// Patient timeline — unified chronological feed across episodes,
// fulfillments, conversations, address changes, grievances,
// coaching plans, and recall notifications.
router.use(patientTimelineRouter);
// HIPAA audit-log archive — list flagged rows + admin destroy.
// CSR shift schedule — who's on now + admin scheduling.
router.use(csrShiftsRouter);
// /admin/appointment-requests — CSR queue for patient-initiated
// appointment requests (fitting help, telehealth, etc.).
router.use(appointmentRequestsRouter);
// /admin/shop/orders/:orderId/loss-claims — lost-shipment workflow
// for paid orders that never arrived. Lifecycle: open →
// carrier_filed → resolved_refunded | resolved_reshipped |
// closed_unresolved.
router.use(shopOrderLossClaimsRouter);
// /admin/shop/returns/:returnId/label — adapter-backed carrier
// label generation. Returns 503 until CARRIER_LABEL_VENDOR is set.
router.use(carrierLabelsRouter);
// /admin/form-acknowledgements — accreditation-binder summary +
// per-patient HIPAA / AOB / ABN / FR / supplier-standards roster.
router.use(formAcknowledgementsRouter);
// /admin/patients/:id/fit-override — CSR override of the camera-
// based mask-fit recommendation. One-row-per-patient.
router.use(patientFitOverridesRouter);
// /admin/referrals/scan-attribution — idempotent sweep that marks
// pending patient_referrals rows as converted when a matching email
// has placed a paid order.
router.use(referralsAttributeRouter);
// /admin/patients/:id/maintenance-log — CSR view of the patient's
// hygiene checklist completion history.
router.use(patientMaintenanceLogRouter);
// /admin/analytics/resupply-funnel — episode-stage rollup with
// confirm + fulfillment rates over a configurable window.
router.use(resupplyFunnelRouter);
router.use(therapyUsageReportRouter);
// /admin/patients/:id/therapy-nights — manual entry path for nights
// not delivered via the partner integration.
router.use(patientTherapyNightsManualRouter);
// /admin/patients/:id/identity-verifications — durable identity-check
// log. We never store the SSN/ID; only the outcome + method.
router.use(patientIdentityVerificationsRouter);
// /provider-portal/:token — public token-gated read-only caseload
// view for a physician/NP. Token minted by CSR.
router.use(providerPortalRouter);
// /admin/shop/orders/:orderId/pod — proof-of-delivery photo upload
// stamp for accreditation + dispute resolution.
router.use(shopOrderPodRouter);
// /admin/shop/orders/:orderId/pod/* — 3-step upload (presigned PUT
// → finalize-verifies-bucket → admin-only GET stream + DELETE) for
// the proof-of-delivery photo. Co-exists with the legacy PATCH
// above; pattern mirrors prescription-attachment for consistency.
router.use(shopOrderPodUploadRouter);
// /admin/integrations/status — vendor-adapter health dashboard.
router.use(integrationsStatusRouter);
// /admin/integrations/nightly-sync — manual trigger for the nightly
// bulk-sync sweep. Same code path the scheduled job runs.
router.use(integrationsNightlySyncRouter);
// /integrations/webhooks/:vendor — vendor PUSH endpoints (AirView
// and Care Orchestrator). HMAC-verified. Public mount because
// vendors don't carry admin sessions.
router.use(integrationsWebhooksRouter);
// /admin/integrations/errors — sync-failure triage queue + retry.
router.use(integrationsErrorsRouter);
// /admin/therapy-fleet/* — population-level therapy-cloud analytics:
// compliance cohorts + prioritized clinical/compliance outreach
// worklist (with CSV export) over the patient_therapy_nights rollup.
router.use(therapyFleetRouter);
// /admin/therapy-resupply/* — resupply opportunities from device data:
// vendor supply rosters whose nextEligibleDate has arrived, surfaced as
// a fleet "due/overdue" queue (with CSV export) to drive resupply orders.
router.use(therapyResupplyRouter);
// /admin/therapy-compliance/* — CMS 90-day setup-adherence tracker:
// best rolling 30-day count per in-window patient + qualify/at-risk
// classification (with CSV export) to protect Medicare reimbursement.
router.use(therapyComplianceRouter);
// /admin/patients/:id/integrations/refresh-supplies — post-shipment
// hook that re-fetches just the vendor supply roster (preserves
// prior nights + settings).
router.use(integrationsRefreshSuppliesRouter);
// /admin/patients/:id/integrations/sync-equipment — replay the
// snapshot→equipment_assets auto-link + recall scan over every
// cached snapshot for this patient. Useful after a recall lands
// for a device class some patients already have on file.
router.use(integrationsSyncEquipmentRouter);
// /admin/productivity — per-agent throughput dashboard for
// supervisors. reports.read-gated; CSRs see their own row too.
router.use(productivityRouter);
// /admin/bulk-campaigns/* — staging-side surface for bulk-email
// campaigns. Phase A persists draft + cancelled; Phase B will add
// the send-side worker that drains bulk_campaign_recipients.
router.use(bulkCampaignsRouter);
// /admin/mfa/* — TOTP enrollment for admin/CSR accounts. Phase A:
// enrollment + status + disable only. Sign-in gating ships in Phase B
// after the enrollment flow has been proven in production.
router.use(mfaRouter);
// /admin/reports/* — date-bounded CSV/PDF/QuickBooks exports for ops
// + finance.
router.use(reportsRouter);
// /admin/reports/presets/* — per-user saved report shortcuts
// (slug + format + date-range preset). Mounted alongside the
// reports router so the page-level UI only has one base path.
router.use(reportPresetsRouter);
// /admin/feature-flags/* — Control Center on/off toggles that gate
// dispatchers and route handlers in real time.
router.use(featureFlagsRouter);
// /admin/nps/recent — last-N-days NPS rollup for the post-delivery
// follow-up. Surfaces band counts + canonical NPS score + a comment
// tail. Powered by shop_order_nps_responses (migration 0127).
router.use(npsSummaryRouter);
// /admin/delivery-failures — webhook delivery error triage queue
// (per-message + audit-log failure events). Read-only.
router.use(deliveryFailuresRouter);
// /admin/lookup — global cross-entity lookup bar. Phone (HMAC),
// email, UUID, and Stripe-session-id-aware. Read-only.
router.use(lookupRouter);
// /admin/system-info — read-only env + deployment metadata for ops
// triage. Never returns env-var values, only "is this set?" booleans.
router.use(systemInfoRouter);
// /admin/shop/customers/* — Customer 360 surface (search/list +
// detail + reorder-on-behalf). Read-mostly; the only write is the
// reorder action which creates a Stripe Checkout Session. Same
// requireAdmin gate as the other shop-admin modules.
router.use(shopCustomersAdminRouter);
// /admin/shop/customers/:userId/notes — internal CSR notes per
// shop customer (Phase 10). Mounted after the customers router so
// the more-specific /notes path doesn't shadow the detail GET.
router.use(shopCustomerNotesRouter);
// /admin/shop/customers/:userId/followups — CSR-scheduled callback
// reminders per shop customer (Phase 17). Same mount-after-detail
// rationale as the notes router.
router.use(shopCustomerFollowupsRouter);
// /admin/shop/customers/:id/timeline — cross-channel customer timeline
// (Biller/CSR #12): conversations + orders + returns + followups +
// reviews, newest first. conversations.manage.
router.use(customerTimelineRouter);
// /admin/followups — cross-customer daily queue of open follow-ups
// (Phase 18). Mounted alongside the per-customer router so both
// surfaces stay co-located.
router.use(followupsListRouter);

export default router;
