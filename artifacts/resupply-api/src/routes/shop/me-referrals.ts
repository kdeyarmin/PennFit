// /shop/me/referrals — patient self-service referral program.
//
//   GET  /shop/me/referrals          — list my referrals + stats
//   POST /shop/me/referrals          — mint a shareable referral code
//                                       (optionally pre-fill referee
//                                       email/name)
//
// Conversion attribution is a separate downstream job; this endpoint
// only records the *invitations*. The Stripe webhook is the natural
// place to mark a referral converted when a paid order arrives from
// the referee_email.

import { randomBytes } from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const URLSAFE_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateCode(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += URLSAFE_ALPHABET[bytes[i]! % URLSAFE_ALPHABET.length];
  }
  return out;
}

async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
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

router.get("/shop/me/referrals", requireSignedIn, async (req, res) => {
  const email = req.shopCustomerEmail;
  if (!email) {
    res.json({ referrals: [], patientLinked: false, stats: null });
    return;
  }
  const patientId = await resolveSinglePatientByEmail(email);
  if (!patientId) {
    res.json({ referrals: [], patientLinked: false, stats: null });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_referrals")
    .select(
      "id, code, referee_email, referee_name, status, converted_at, created_at",
    )
    .eq("referrer_patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = data ?? [];
  const stats = {
    total: rows.length,
    converted: rows.filter((r) => r.status === "converted").length,
    pending: rows.filter((r) => r.status === "pending").length,
  };
  res.json({
    patientLinked: true,
    stats,
    referrals: rows.map((r) => ({
      id: r.id,
      code: r.code,
      refereeEmail: r.referee_email,
      refereeName: r.referee_name,
      status: r.status,
      convertedAt: r.converted_at,
      createdAt: r.created_at,
    })),
  });
});

const body = z
  .object({
    refereeEmail: z.string().trim().email().max(200).nullable().optional(),
    refereeName: z.string().trim().max(160).nullable().optional(),
  })
  .strict();

router.post("/shop/me/referrals", requireSignedIn, async (req, res) => {
  const email = req.shopCustomerEmail;
  if (!email) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const patientId = await resolveSinglePatientByEmail(email);
  if (!patientId) {
    res.status(404).json({ error: "patient_not_linked" });
    return;
  }
  // Single retry on the very unlikely event of a code collision —
  // 62^10 ≈ 8.4e17 space so this branch is effectively unreachable,
  // but the dedupe index would otherwise surface a confusing 23505.
  const supabase = getSupabaseServiceRoleClient();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateCode();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_referrals")
      .insert({
        referrer_patient_id: patientId,
        code,
        referee_email: parsed.data.refereeEmail ?? null,
        referee_name: parsed.data.refereeName ?? null,
        status: "pending",
      })
      .select("id, code")
      .single();
    if (!error) {
      res.status(201).json({ id: data.id, code: data.code });
      return;
    }
    const errCode =
      typeof error === "object" && error && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (errCode !== "23505") throw error;
    // collision — try again
  }
  res.status(503).json({ error: "code_collision" });
});

export default router;
