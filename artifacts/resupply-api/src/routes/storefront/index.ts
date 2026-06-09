import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import recommendRouter from "./recommend.js";
import ordersRouter from "./orders.js";
import trackOrderRouter from "./track-order.js";
import adminRouter from "./admin.js";
import usageEventsRouter from "./usage-events.js";
import remindersRouter from "./reminders.js";
import patientPacketsRouter from "./patient-packets.js";
import chatRouter from "./chat.js";
import sleepCoachRouter from "./sleep-coach.js";
import meClaimsRouter from "./me-claims.js";
import mePaymentsRouter from "./me-payments.js";
import mePaymentMethodsRouter from "./me-payment-methods.js";
import meBillingRouter from "./me-billing.js";
import meInsuranceEstimateRouter from "./me-insurance-estimate.js";
import { attachSignedIn } from "../../middlewares/requireSignedIn.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(recommendRouter);
router.use(ordersRouter);
router.use(trackOrderRouter);
router.use(adminRouter);
router.use(usageEventsRouter);
router.use(remindersRouter);
// /api/patient-packets/view + /sign — public e-signature flow for the
// new-patient document packet. Token-gated (HMAC); no login. Mounted
// before attachSignedIn so it stays unauthenticated.
router.use(patientPacketsRouter);
router.use(chatRouter);
// Patient-portal session resolution for the routers below. They read
// `req.shopCustomerId` (the signed-in patient's customer key) — without
// this middleware nothing populates it, so every one of these PHI
// endpoints would 401 (or degrade to the static fallback) for signed-in
// patients in production. `attachSignedIn` is soft (never blocks): it
// attaches the customer id from the pf_session cookie when present and
// is a no-op otherwise, so each router keeps its own gate — hard-401 for
// claims/payments/billing, graceful `{ available: false }` for the
// insurance estimate. (Per-route tests mount these routers directly with
// their own stub, so this aggregate-level wiring doesn't affect them.)
router.use(attachSignedIn);
router.use(sleepCoachRouter);
// Patient-portal claim explorer: read-only /api/me/claims +
// /api/me/billing-balance for the logged-in patient.
router.use(meClaimsRouter);
// /api/me/payments — Stripe PaymentIntent for patient balances +
// list. The intent's success is processed via the existing
// /resupply-api/stripe/webhook handler (payment_intent.* cases).
router.use(mePaymentsRouter);
// /api/me/payment-methods — patient-controlled card-on-file + autopay
// toggle. Saving a card never charges; the worker (gated by the
// seeded-OFF billing.patient_autopay flag + an env cron) does.
router.use(mePaymentMethodsRouter);
// /api/me/billing-statements — the patient's own statement history
// + on-demand PDF re-render (no PDF persistence — the line_items_json
// snapshot is the source of truth).
router.use(meBillingRouter);
// /api/me/insurance-estimate — personalized estimator backing the
// /insurance/estimate page when the signed-in patient has a
// recent parsed 270/271 on file. Falls back to the static
// payer-average table when unavailable.
router.use(meInsuranceEstimateRouter);
// /api/me/rights-requests + /api/me/disclosures — HIPAA
// §164.522/524/526/528 rights submission + the §164.528 accounting
// of disclosures (non-TPO entries from patient_disclosure_log).

export default router;
