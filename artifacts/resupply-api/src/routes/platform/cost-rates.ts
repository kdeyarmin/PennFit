// /resupply-api/platform/cost-rates — the vendor cost-rate card (G12).
//
//   GET /platform/cost-rates  — current per-unit cost rates
//   PUT /platform/cost-rates  — save rates
//
// The operator-set cost-per-unit the console multiplies by each tenant's
// metered usage (AI tokens, outbound messages, voice/fax events) to derive
// vendor COGS. Stored as plain numeric `app_config` rows on the seed org
// (key/value), the same store the platform System Configuration uses — so
// no migration. Defaults are 0 (no fabricated cost): COGS reads as $0 for
// a metric until the operator enters its rate. Gated by
// `requirePlatformAdmin`. No PHI, no secrets — just cents-per-unit numbers.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

// Response field ⇄ app_config key. The unit each rate is quoted in is
// fixed by the field name (…Per1mCents = cents per 1,000,000 tokens;
// …Cents = cents per event).
const RATE_FIELDS = [
  ["aiInputPer1mCents", "cost_rate.ai_input_per_1m_cents"],
  ["aiOutputPer1mCents", "cost_rate.ai_output_per_1m_cents"],
  ["outboundMessageCents", "cost_rate.outbound_message_cents"],
  ["aiVoiceEventCents", "cost_rate.ai_voice_event_cents"],
  ["faxEventCents", "cost_rate.fax_event_cents"],
] as const;

type RateField = (typeof RATE_FIELDS)[number][0];

const KEY_BY_FIELD = new Map<RateField, string>(
  RATE_FIELDS.map(([field, key]) => [field, key]),
);
const FIELD_BY_KEY = new Map<string, RateField>(
  RATE_FIELDS.map(([field, key]) => [key, field]),
);

function emptyRates(): Record<RateField, number> {
  return {
    aiInputPer1mCents: 0,
    aiOutputPer1mCents: 0,
    outboundMessageCents: 0,
    aiVoiceEventCents: 0,
    faxEventCents: 0,
  };
}

const putBody = z
  .object({
    aiInputPer1mCents: z.number().min(0).max(10_000_000),
    aiOutputPer1mCents: z.number().min(0).max(10_000_000),
    outboundMessageCents: z.number().min(0).max(10_000_000),
    aiVoiceEventCents: z.number().min(0).max(10_000_000),
    faxEventCents: z.number().min(0).max(10_000_000),
  })
  .partial();

router.get(
  "/platform/cost-rates",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res): Promise<void> => {
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "seed_org_unresolved" });
      return;
    }
    const { data, error } = await getOrgScopedClient(seedOrgId)
      .from("app_config")
      .select("key, value")
      .in(
        "key",
        RATE_FIELDS.map(([, key]) => key),
      );
    if (error) {
      logger.error(
        { event: "platform_cost_rates_read_failed", err: error },
        "platform: cost-rate read failed",
      );
      res.status(500).json({ error: "cost_rates_read_failed" });
      return;
    }
    const rates = emptyRates();
    for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) {
      const field = FIELD_BY_KEY.get(row.key);
      if (!field) continue;
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) rates[field] = n;
    }
    res.json({ rates });
  },
);

router.put(
  "/platform/cost-rates",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = putBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_rates" });
      return;
    }
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "seed_org_unresolved" });
      return;
    }
    const supabase = getOrgScopedClient(seedOrgId);

    const nowIso = new Date().toISOString();
    const rows = Object.entries(parsed.data).map(([field, value]) => ({
      key: KEY_BY_FIELD.get(field as RateField) as string,
      value: String(value),
      updated_by_user_id: req.platformAdminUserId ?? null,
      updated_by_email: req.platformAdminEmail ?? null,
      updated_at: nowIso,
    }));
    if (rows.length > 0) {
      const { error } = await supabase
        .from("app_config")
        .upsert(rows, { onConflict: "org_id,key" });
      if (error) {
        logger.error(
          { event: "platform_cost_rates_write_failed", err: error },
          "platform: cost-rate write failed",
        );
        res.status(500).json({ error: "cost_rates_write_failed" });
        return;
      }
    }

    // Echo back the full effective rate set so the client can re-render
    // without a second round-trip.
    const { data, error: readErr } = await supabase
      .from("app_config")
      .select("key, value")
      .in(
        "key",
        RATE_FIELDS.map(([, key]) => key),
      );
    if (readErr) {
      res.status(500).json({ error: "cost_rates_read_failed" });
      return;
    }
    const rates = emptyRates();
    for (const row of (data ?? []) as Array<{ key: string; value: unknown }>) {
      const field = FIELD_BY_KEY.get(row.key);
      if (!field) continue;
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) rates[field] = n;
    }
    res.json({ rates });
  },
);

export default router;
