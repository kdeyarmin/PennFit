// /shop/me/education-feed — onboarding-stage-personalized education
// feed for the patient portal.
//
//   GET /shop/me/education-feed
//
// Returns the patient's stage (new / habituating / steady /
// experienced) plus the curated article list from the catalog.
//
// Stage is computed from EARLIEST therapy-night date (the moment
// therapy actually started, which is what matters for "first week"
// vs "6 months in"). When no therapy nights exist yet we fall
// back to the patient row's created_at — newly enrolled patients
// still see the "new" content.
//
// Email-match strategy is identical to /shop/me/therapy-summary;
// see that route's preamble for the HIPAA rationale.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  articlesForStage,
  stageForDays,
} from "../../lib/patient-education/catalog";
import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<{ id: string; createdAt: string } | null> {
  const supabase = getSupabaseServiceRoleClient();
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, created_at")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) return null;
  return { id: rows[0]!.id, createdAt: rows[0]!.created_at };
}

router.get("/shop/me/education-feed", requireSignedIn, async (req, res) => {
  const customerEmail = req.shopCustomerEmail;
  if (!customerEmail) {
    // Anonymous / no email match — still surface the "new" feed
    // so the SPA doesn't render an empty hole. This is patient-
    // education content, not PHI; serving the new-user list to
    // anyone signed in is fine.
    res.json({
      patientLinked: false,
      stage: "new",
      daysOnTherapy: 0,
      articles: articlesForStage("new"),
    });
    return;
  }

  const patient = await resolveSinglePatientByEmail(customerEmail);
  if (!patient) {
    res.json({
      patientLinked: false,
      stage: "new",
      daysOnTherapy: 0,
      articles: articlesForStage("new"),
    });
    return;
  }

  // Earliest therapy night = therapy start.
  const supabase = getSupabaseServiceRoleClient();
  const { data: firstNight, error } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("night_date")
    .eq("patient_id", patient.id)
    .order("night_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const startedAt = firstNight?.night_date
    ? new Date(firstNight.night_date)
    : new Date(patient.createdAt);
  const daysOnTherapy = Math.max(
    0,
    Math.floor((Date.now() - startedAt.getTime()) / 86_400_000),
  );
  const stage = stageForDays(daysOnTherapy);

  logger.info(
    {
      event: "shop.me.education-feed.served",
      stage,
      daysOnTherapy,
    },
    "shop.me.education-feed: served",
  );

  res.json({
    patientLinked: true,
    stage,
    daysOnTherapy,
    articles: articlesForStage(stage),
  });
});

export default router;
