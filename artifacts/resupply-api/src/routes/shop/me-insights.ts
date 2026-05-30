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
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
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
  /** True once the admin dispatcher has emailed the patient
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

/**
 * Resolve the patient row whose `email` matches `customerEmail`
 * case-insensitively, but only if the match is unambiguous.
 *
 *   * 0 hits  → null (no match)
 *   * 1 hit   → patient id
 *   * 2+ hits → null (ambiguous — same as the inbound-parse / inbound-SMS
 *                     strategy: refuse to mis-route PHI)
 *
 * PostgREST has no `lower(col) = $1`. We approximate via `.ilike()`
 * on the escaped literal — `_` and `%` would otherwise act as LIKE
 * wildcards. A non-malicious email may legitimately contain `_` in
 * the local part, so the escape isn't optional.
 */
async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  // Escape LIKE metacharacters so e.g. "alice_smith@…" doesn't match
  // "aliceXsmith@…".
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) return null;
  return rows[0]!.id;
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

  // No match → no data to surface. Ambiguous email → empty rather
  // than risk exposing one patient's data to another.
  const patientId = await resolveSinglePatientByEmail(customerEmail);
  if (!patientId) {
    res.json({ insights: [] });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data: events, error } = await supabase
    .schema("resupply")
    .from("patient_smart_trigger_events")
    .select(
      "id, kind, detected_at, window_start_date, window_end_date, sent_at",
    )
    .eq("patient_id", patientId)
    .is("dismissed_at", null)
    .order("detected_at", { ascending: false })
    .limit(RESPONSE_LIMIT);
  if (error) throw error;

  const insights: CustomerInsight[] = (events ?? []).map((e) =>
    project(e.id, e.kind as SmartTriggerKind, e.detected_at, {
      windowStartDate: e.window_start_date,
      windowEndDate: e.window_end_date,
      notified: e.sent_at !== null,
    }),
  );

  logger.info(
    { customerId, count: insights.length },
    "shop.me.insights.served",
  );

  res.json({ insights });
});

const insightIdParam = z.string().uuid();

/**
 * Customer-facing dismiss. Marks an insight as dismissed when the
 * trigger row belongs to a patient whose email matches the
 * signed-in customer's email_lower. The double-bind in the WHERE
 * clause is the authorization gate: a customer can never dismiss
 * a row whose patient_id maps to a different email.
 *
 *   * 200 with { ok: true } when the dismiss succeeded.
 *   * 404 when no row matched (already dismissed, wrong patient,
 *     unknown id) — we deliberately do NOT distinguish so an
 *     attacker can't enumerate trigger IDs.
 *   * 401 already handled by requireSignedIn.
 *
 * Audit: stamps `dismissed_by_email` with the customer's email so
 * the admin audit log can tell self-dismissals apart from
 * CSR-initiated dismissals. `dismissed_reason` stays null on the
 * customer path (no free-text input — the customer just wants the
 * card to go away).
 */
router.post(
  "/shop/me/insights/:id/dismiss",
  requireSignedIn,
  async (req, res) => {
    const customerEmail = req.shopCustomerEmail;
    if (!customerEmail) {
      // No email → no email-match possible → no row to dismiss.
      res.status(404).json({ error: "insight_not_found" });
      return;
    }
    const idParse = insightIdParam.safeParse(req.params.id);
    if (!idParse.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = idParse.data;

    const patientId = await resolveSinglePatientByEmail(customerEmail);
    if (!patientId) {
      res.status(404).json({ error: "insight_not_found" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    // Atomic dismiss — scoped to the single unambiguous patient row.
    // The .is("dismissed_at", null) guard mirrors the original
    // RETURNING-on-WHERE-NULL pattern: 0 rows back → already dismissed
    // or wrong patient_id, both of which collapse to a 404.
    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("patient_smart_trigger_events")
      .update({
        dismissed_at: nowIso,
        dismissed_by_email: customerEmail.toLowerCase(),
        updated_at: nowIso,
      })
      .eq("id", id)
      .eq("patient_id", patientId)
      .is("dismissed_at", null)
      .select("id");
    if (error) throw error;

    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "insight_not_found" });
      return;
    }
    logger.info(
      { customerId: req.userCustomerId, insightId: id },
      "shop.me.insights.dismissed",
    );
    res.json({ ok: true });
  },
);

function project(
  id: string,
  kind: SmartTriggerKind,
  detectedAt: string,
  rest: { windowStartDate: string; windowEndDate: string; notified: boolean },
): CustomerInsight {
  const copy = COPY[kind];
  return {
    id,
    kind,
    // PostgREST already returns timestamptz as ISO string.
    detectedAt,
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
    cta: {
      label: "Shop replacement cushions",
      url: "/shop#shop-section-cushion",
    },
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
    cta: { label: "Order a replacement", url: "/shop#shop-section-cushion" },
  },
  humidifier_drop: {
    headline: "Refresh your tubing",
    body: "With seasonal warmth your tubing may be due for a refresh — older tubing collects condensation and reduces airflow.",
    cta: { label: "Shop tubing", url: "/shop#shop-section-tubing" },
  },
};

export default router;
