// /shop/me/quarterly-summary — patient-facing 90-day therapy
// rollup. Returns print-friendly HTML the patient can save to
// PDF in their browser and share with their sleep MD.

import { Router, type IRouter } from "express";

import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import { buildQuarterlySummary } from "../../lib/therapy-summary/build-quarterly-html";
import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const WINDOW_DAYS = 90;

async function resolveSinglePatientByEmail(
  orgId: string,
  customerEmail: string,
): Promise<{
  id: string;
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string | null;
} | null> {
  const supabase = getOrgScopedClient(orgId);
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data, error } = await supabase
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
  const orgIdForLookup = req.orgId;
  if (!orgIdForLookup) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const patient = await resolveSinglePatientByEmail(
    orgIdForLookup,
    customerEmail,
  );
  if (!patient) {
    res.status(403).json({ error: "patient_not_linked" });
    return;
  }
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - WINDOW_DAYS);
  const startIso = windowStart.toISOString().slice(0, 10);
  const endIso = windowEnd.toISOString().slice(0, 10);

  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const { data: nights, error } = await supabase
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
    nights: (
      (nights ?? []) as Array<
        Database["resupply"]["Tables"]["patient_therapy_nights"]["Row"]
      >
    ).map((n) => ({
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
