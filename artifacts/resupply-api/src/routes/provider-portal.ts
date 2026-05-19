// /provider-portal — public, token-gated read-only view for a
// physician/NP. The token is minted by CSR via
// POST /admin/providers/:id/portal-link.
//
//   GET /provider-portal/:token
//        Returns provider details + caseload (active prescriptions).
//        No PHI beyond what the provider already knows about THEIR
//        OWN patients: name, prescribed item, valid_until.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { verifyProviderPortalToken } from "../lib/provider-portal-token";

const router: IRouter = Router();

// IP-keyed rate limiter on the unauthenticated provider portal lookup.
// Uses `express-rate-limit` so the gate is recognised by static
// analysis (CodeQL `js/missing-rate-limiting`). 60/min/IP is well
// above any honest physician browsing pattern but well below what a
// scraper guessing tokens would need.
const providerPortalRateLimiter = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

router.get(
  "/provider-portal/:token",
  providerPortalRateLimiter,
  async (req, res) => {
  const parsed = z.string().min(8).safeParse(req.params.token);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const v = verifyProviderPortalToken(parsed.data);
  if (!v.valid) {
    res.status(401).json({ error: "invalid_or_expired_token" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: provider, error: pErr } = await supabase
    .schema("resupply")
    .from("providers")
    .select(
      "id, npi, legal_name, practice_name, taxonomy_code",
    )
    .eq("id", v.providerId)
    .limit(1)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!provider) {
    res.status(404).json({ error: "provider_not_found" });
    return;
  }
  const { data: rxs, error: rErr } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select(
      "id, item_sku, hcpcs_code, status, valid_from, valid_until, patients!inner(id, legal_first_name, legal_last_name)",
    )
    .eq("provider_id", v.providerId)
    .order("valid_from", { ascending: false })
    .limit(200);
  if (rErr) throw rErr;
  res.json({
    provider: {
      id: provider.id,
      npi: provider.npi,
      legalName: provider.legal_name,
      practiceName: provider.practice_name,
      taxonomyCode: provider.taxonomy_code,
    },
    prescriptions: (rxs ?? []).map((r) => {
      const p = (r as { patients?: unknown }).patients as
        | {
            legal_first_name: string | null;
            legal_last_name: string | null;
          }
        | null;
      return {
        id: r.id,
        itemSku: r.item_sku,
        hcpcsCode: r.hcpcs_code,
        status: r.status,
        validFrom: r.valid_from,
        validUntil: r.valid_until,
        patientName: [p?.legal_first_name, p?.legal_last_name]
          .filter(Boolean)
          .join(" ") || null,
      };
    }),
  });
});

export default router;
