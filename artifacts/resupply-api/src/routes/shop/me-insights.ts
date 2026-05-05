// /shop/me/insights — customer-facing view of detected smart-trigger
// events (Phase G.4 — Phase E.2 follow-up).
//
//   GET /shop/me/insights
//
// Returns the active smart-trigger events for the patient row whose
// `email` matches the signed-in shop customer's email_lower. This is
// the customer side of the data the admin dispatcher already emails:
// "we noticed your leak rate has trended up — replace your cushion".
//
// Match strategy: by email only. Linking shop_customers.customer_id
// to patients.id requires a separate consent flow we haven't built
// yet (HIPAA — accidental cross-account data exposure if the email
// gets reused). Email-match is conservative: if the customer's
// shop email matches their resupply patient email exactly, we surface
// their data; otherwise the endpoint returns an empty list.
//
// Active = sent_at not requirement, dismissed_at IS NULL. We include
// pending detections (not yet emailed) because the customer-facing
// insight is independent of the admin-facing dispatch ritual.
//
// PHI / log posture: the response carries trigger kind + dates only.
// No therapy values (leak rate, AHI, usage minutes) — those are the
// detection inputs and live in patient_therapy_nights, not here.
// Logging is structural: customerId + count.

import { Router, type IRouter } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  getDbPool,
  patientSmartTriggerEvents,
  patients,
  type SmartTriggerKind,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

/** Cap to keep the customer payload bounded. A real patient should
 *  never have more than a handful of active triggers; if they do,
 *  showing the most recent few covers every UI lifecycle. */
const RESPONSE_LIMIT = 20;

interface CustomerInsight {
  id: string;
  kind: SmartTriggerKind;
  detectedAt: string;
  windowStartDate: string;
  windowEndDate: string;
  /** True once the admin dispatcher has emailed/SMS'd the patient
   *  about this event. Lets the SPA badge "we already let you know"
   *  vs. "new". */
  notified: boolean;
  /** Static copy describing what the customer can do. Server-rendered
   *  rather than SPA-rendered so we can A/B test conversion language
   *  without shipping a new bundle. */
  headline: string;
  body: string;
  cta: { label: string; url: string };
}

router.get("/shop/me/insights", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  const customerEmail = req.shopCustomerEmail;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }

  // No email on the session → no match possible. Returning an empty
  // list (vs 404) keeps the SPA simple: it always gets a typed array.
  if (!customerEmail) {
    res.json({ insights: [] });
    return;
  }

  const db = drizzle(getDbPool());

  // Email-match: the signed-in customer's email_lower vs the patient
  // row's email (CITEXT-style by lowering both sides). We don't index
  // on lower(patients.email) today — the per-customer cardinality is
  // tiny (a single patient row in the typical case) so a seq-scan in
  // postgres on the patient batch is cheap. Future: add a functional
  // index if the table grows.
  const events = await db
    .select({
      id: patientSmartTriggerEvents.id,
      kind: patientSmartTriggerEvents.kind,
      detectedAt: patientSmartTriggerEvents.detectedAt,
      windowStartDate: patientSmartTriggerEvents.windowStartDate,
      windowEndDate: patientSmartTriggerEvents.windowEndDate,
      sentAt: patientSmartTriggerEvents.sentAt,
    })
    .from(patientSmartTriggerEvents)
    .innerJoin(patients, eq(patients.id, patientSmartTriggerEvents.patientId))
    .where(
      and(
        sql`lower(${patients.email}) = ${customerEmail.toLowerCase()}`,
        isNull(patientSmartTriggerEvents.dismissedAt),
      ),
    )
    .orderBy(desc(patientSmartTriggerEvents.detectedAt))
    .limit(RESPONSE_LIMIT);

  const insights: CustomerInsight[] = events.map((e) =>
    project(e.id, e.kind as SmartTriggerKind, e.detectedAt, {
      windowStartDate: e.windowStartDate,
      windowEndDate: e.windowEndDate,
      notified: e.sentAt !== null,
    }),
  );

  logger.info(
    { customerId, count: insights.length },
    "shop.me.insights.served",
  );

  res.json({ insights });
});

function project(
  id: string,
  kind: SmartTriggerKind,
  detectedAt: Date,
  rest: { windowStartDate: string; windowEndDate: string; notified: boolean },
): CustomerInsight {
  const copy = COPY[kind];
  return {
    id,
    kind,
    detectedAt: detectedAt.toISOString(),
    windowStartDate: rest.windowStartDate,
    windowEndDate: rest.windowEndDate,
    notified: rest.notified,
    headline: copy.headline,
    body: copy.body,
    cta: copy.cta,
  };
}

const COPY: Record<
  SmartTriggerKind,
  { headline: string; body: string; cta: { label: string; url: string } }
> = {
  leak_rising: {
    headline: "Your mask seal may be slipping",
    body:
      "Your leak rate has trended up over the last two weeks — usually a sign your cushion seal is wearing out. " +
      "A fresh cushion is a 5-minute swap and typically clears the readings overnight.",
    cta: { label: "Shop replacement cushions", url: "/shop?cat=cushions" },
  },
  usage_dropping: {
    headline: "We noticed a few harder nights",
    body:
      "Your therapy hours have dropped over the last couple of weeks. That's the most common point where small adjustments " +
      "(refit, ramp tweak, humidifier nudge) make the biggest difference. We'd love to help.",
    cta: { label: "Talk to our team", url: "/account" },
  },
  cushion_wear: {
    headline: "Time for a fresh cushion",
    body:
      "Both your leak rate and AHI ticked up over the last two weeks — usually the end of a cushion's working life. " +
      "Replacing it takes about 5 minutes and typically clears both readings.",
    cta: { label: "Order a replacement", url: "/shop?cat=cushions" },
  },
  humidifier_drop: {
    headline: "Refresh your tubing",
    body: "With seasonal warmth your tubing may be due for a refresh — older tubing collects condensation and reduces airflow.",
    cta: { label: "Shop tubing", url: "/shop" },
  },
};

export default router;
