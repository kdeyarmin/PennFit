import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import recommendRouter from "./recommend.js";
import ordersRouter from "./orders.js";
import trackOrderRouter from "./track-order.js";
import adminRouter from "./admin.js";
import usageEventsRouter from "./usage-events.js";
import remindersRouter from "./reminders.js";
import chatRouter from "./chat.js";
import sleepCoachRouter from "./sleep-coach.js";
import meClaimsRouter from "./me-claims.js";
import mePaymentsRouter from "./me-payments.js";
import meBillingRouter from "./me-billing.js";
import meRightsRequestsRouter from "./me-rights-requests.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(recommendRouter);
router.use(ordersRouter);
router.use(trackOrderRouter);
router.use(adminRouter);
router.use(usageEventsRouter);
router.use(remindersRouter);
router.use(chatRouter);
router.use(sleepCoachRouter);
// Patient-portal claim explorer: read-only /api/me/claims +
// /api/me/billing-balance for the logged-in patient.
router.use(meClaimsRouter);
// /api/me/payments — Stripe PaymentIntent for patient balances +
// list. The intent's success is processed via the existing
// /resupply-api/stripe/webhook handler (payment_intent.* cases).
router.use(mePaymentsRouter);
// /api/me/billing-statements — the patient's own statement history
// + on-demand PDF re-render (no PDF persistence — the line_items_json
// snapshot is the source of truth).
router.use(meBillingRouter);
// /api/me/rights-requests + /api/me/disclosures — HIPAA
// §164.522/524/526/528 rights submission + the §164.528 accounting
// of disclosures (non-TPO entries from patient_disclosure_log).
router.use(meRightsRequestsRouter);

export default router;
