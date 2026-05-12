import { Router, type IRouter } from "express";
import abandonedCartsRouter from "./admin/abandoned-carts.js";
import shopCustomersAdminRouter from "./admin/customers.js";
import shopCustomerNotesRouter from "./admin/customer-notes.js";
import shopCustomerFollowupsRouter from "./admin/customer-followups.js";
import followupsListRouter from "./admin/followups-list.js";
import shopOrderNotesRouter from "./admin/order-notes.js";
import shopOrdersAdminRouter from "./admin/shop-orders.js";
import shopProductsAdminRouter from "./admin/shop-products.js";
import csrMacrosRouter from "./admin/csr-macros.js";
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
import equipmentRecallsRouter from "./admin/equipment-recalls.js";
import analyticsRouter from "./admin/analytics.js";
import trainingRecordsRouter from "./admin/training-records.js";
import grievancesRouter from "./admin/grievances.js";
import accreditationPoliciesRouter from "./admin/accreditation-policies.js";
import productivityRouter from "./admin/productivity.js";
import patientDocumentsRetentionRouter from "./admin/patient-documents-retention.js";
import shopBackordersRouter from "./admin/shop-backorders.js";
import officeClosuresRouter from "./admin/office-closures.js";
import coachingPlansRouter from "./admin/coaching-plans.js";
import conversationRoutingRouter from "./admin/conversation-routing.js";
import conversationCoachingNotesRouter from "./admin/conversation-coaching-notes.js";
import bulkCampaignsRouter from "./admin/bulk-campaigns.js";
import mfaRouter from "./admin/mfa.js";
import reportsRouter from "./admin/reports.js";
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
import patientTherapyLinksRouter from "./admin/patient-therapy-links.js";
import patientIntegrationsRouter from "./admin/patient-integrations.js";
import smartTriggersRouter from "./admin/smart-triggers.js";
import physicianFaxOutreachRouter from "./admin/physician-fax-outreach.js";
import shopBackInStockAdminRouter from "./admin/shop-back-in-stock.js";
import shopSubsMetricsRouter from "./admin/shop-subscriptions-metrics.js";
import insuranceLeadsAdminRouter from "./admin/insurance-leads.js";
import auditRouter from "./audit/index.js";
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
router.use(auditRouter);
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
// /admin/patients/:id/therapy-nights/* — therapy-cloud sync
// (Phase E.1 / feature #18). Adapter stubs for ResMed AirView +
// Philips Care; the actual partner integration lands once a BAA
// + API access is in place. Sync endpoint 503s until the chosen
// adapter's env var is set.
router.use(patientTherapySyncRouter);
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
// /admin/shop/back-in-stock-queue — visibility into who's waiting
// for which OOS SKU + manual fanout trigger. requireAdmin gate is
// on the router itself.
router.use(shopBackInStockAdminRouter);
// /admin/shop/insurance-leads/* — durable queue + status mutations
// for submissions to the public POST /shop/insurance-leads form.
// requireAdmin gate is on the router itself.
router.use(insuranceLeadsAdminRouter);
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
// /admin/compliance/* — accreditation-binder surfaces: per-staff
// training records (HIPAA, OSHA, fit-test, infection-control,
// orientation) and patient grievances (complaints + grievances +
// adverse events under one typed row). Surveyors (ACHC, BOC, TJC)
// query these exact artifacts during DMEPOS site visits.
router.use(trainingRecordsRouter);
router.use(grievancesRouter);
// /admin/accreditation/* — the policy catalog + per-staff
// attestation surface + binder summary that ties the three
// evidence sections (policies, training, grievances) together
// for a single hand-off to a surveyor.
router.use(accreditationPoliciesRouter);
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
// /admin/reports/*.csv — date-bounded CSV exports for ops + finance.
router.use(reportsRouter);
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
// /admin/followups — cross-customer daily queue of open follow-ups
// (Phase 18). Mounted alongside the per-customer router so both
// surfaces stay co-located.
router.use(followupsListRouter);

export default router;
