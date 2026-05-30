// /shop/me/quarterly-summary — patient-facing 90-day therapy
// rollup. Returns print-friendly HTML the patient can save to
// PDF in their browser and share with their sleep MD.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { buildQuarterlySummary } from "../../lib/therapy-summary/build-quarterly-html";
import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const WINDOW_DAYS = 90;

async function resolveSinglePatientByEmail(customerEmail: string): Promise<{
  id: string;
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string | null;
} | null> {
  const supabase = getSupabaseServiceRoleClient();
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, legal_last_name, date_of_birth")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!data || data.length !== 1) return null;
  const r = data[0]!;
  return {
    id: r.id,
    legalFirstName: r.legal_first_name,
    legalLastName: r.legal_last_name,
    dateOfBirth: r.date_of_birth,
  };
}

router.get("/shop/me/quarterly-summary", requireSignedIn, async (req, res) => {
  const customerEmail = req.shopCustomerEmail;
  if (!customerEmail) {
    res.status(403).json({ error: "patient_not_linked" });
    return;
  }
  const patient = await resolveSinglePatientByEmail(customerEmail);
  if (!patient) {
    res.status(403).json({ error: "patient_not_linked" });
    return;
  }
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - WINDOW_DAYS);
  const startIso = windowStart.toISOString().slice(0, 10);
  const endIso = windowEnd.toISOString().slice(0, 10);

  const supabase = getSupabaseServiceRoleClient();
  const { data: nights, error } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("night_date, usage_minutes, ahi, leak_rate_l_min, source")
    .eq("patient_id", patient.id)
    .gte("night_date", startIso)
    .order("night_date", { ascending: true })
    .limit(WINDOW_DAYS * 4);
  if (error) throw error;

  const summary = buildQuarterlySummary({
    patient,
    windowStart: startIso,
    windowEnd: endIso,
    practiceName: process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps",
    nights: (nights ?? []).map((n) => ({
      nightDate: n.night_date,
      usageMinutes: n.usage_minutes,
      ahi: n.ahi == null ? null : Number(n.ahi),
      leakLMin: n.leak_rate_l_min == null ? null : Number(n.leak_rate_l_min),
    })),
  });

  logger.info(
    {
      event: "shop.me.quarterly-summary.served",
      nightsRecorded: summary.fields.nightsRecorded,
    },
    "quarterly summary served",
  );

  if (req.query.format === "json") {
    res.json({ fields: summary.fields });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(summary.html);
});

export default router;
