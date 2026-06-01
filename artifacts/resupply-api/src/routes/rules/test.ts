// POST /rules/test — pure-function rule simulator.
//
// Lets an admin answer "given a hypothetical patient + prescription
// + the current set of frequency_rules, which rule would fire and
// what cadence/channel would the worker use?" without actually
// scheduling outreach.
//
// Reads the live rules table — the simulator reflects today's
// configuration, not a snapshot. No audit row is written: the
// simulation is read-only and returns only synthesized data the
// caller already supplied (no PHI in / no PHI out).

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  resolveOutreachPlan,
  type OutreachPatient,
  type OutreachPrescription,
  type OutreachRule,
} from "@workspace/resupply-domain";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const channelEnum = z.enum(["sms", "email", "voice"]);

const simBody = z
  .object({
    patient: z.object({
      createdAt: z
        .string()
        .datetime()
        .optional()
        .describe("ISO 8601; defaults to now"),
      tenureDays: z
        .number()
        .int()
        .min(0)
        .max(36500)
        .optional()
        .describe("Alternative to createdAt — backfilled to a date"),
      insurancePayer: z.string().trim().max(120).nullable().default(null),
      cadenceOverrideDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .nullable()
        .default(null),
      channelPreference: channelEnum.nullable().default(null),
      hasPhone: z.boolean().default(true),
    }),
    prescription: z.object({
      itemSku: z.string().trim().min(1).max(120),
      cadenceDays: z.number().int().min(1).max(3650),
    }),
  })
  .strict();

router.post(
  "/rules/test",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = simBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const now = new Date();
    const createdAt = parsed.data.patient.createdAt
      ? new Date(parsed.data.patient.createdAt)
      : parsed.data.patient.tenureDays !== undefined
        ? new Date(now.getTime() - parsed.data.patient.tenureDays * 86400_000)
        : now;

    const patient: OutreachPatient = {
      id: "sim",
      createdAt,
      insurancePayer: parsed.data.patient.insurancePayer,
      cadenceOverrideDays: parsed.data.patient.cadenceOverrideDays,
      channelPreference: parsed.data.patient.channelPreference,
      hasPhone: parsed.data.patient.hasPhone,
    };
    const prescription: OutreachPrescription = {
      itemSku: parsed.data.prescription.itemSku,
      cadenceDays: parsed.data.prescription.cadenceDays,
    };

    const supabase = getSupabaseServiceRoleClient();
    const { data: ruleRows, error } = await supabase
      .schema("resupply")
      .from("frequency_rules")
      .select("*")
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;

    const rules: OutreachRule[] = (ruleRows ?? []).map((r) => ({
      id: r.id,
      priority: r.priority,
      createdAt: new Date(r.created_at),
      active: r.active,
      matchItemSkuPrefix: r.match_item_sku_prefix,
      matchInsurancePayer: r.match_insurance_payer,
      minTenureDays: r.min_tenure_days,
      maxTenureDays: r.max_tenure_days,
      cadenceDays: r.cadence_days,
      defaultChannel: r.default_channel as "sms" | "email" | "voice" | null,
    }));

    const plan = resolveOutreachPlan({ patient, prescription, rules, now });

    // Walk the rule list ourselves to surface "why didn't rule X
    // fire?" — useful when the matched rule isn't the one the admin
    // expected.
    const tenureDays = Math.floor(
      (now.getTime() - createdAt.getTime()) / 86400_000,
    );
    const evaluated = rules.map((r) => {
      const reasons: string[] = [];
      if (!r.active) reasons.push("rule is inactive");
      if (
        r.matchItemSkuPrefix !== null &&
        !prescription.itemSku.startsWith(r.matchItemSkuPrefix)
      ) {
        reasons.push(
          `itemSku "${prescription.itemSku}" does not start with "${r.matchItemSkuPrefix}"`,
        );
      }
      if (r.matchInsurancePayer !== null) {
        if (patient.insurancePayer === null) {
          reasons.push("rule requires a payer; patient has none on file");
        } else if (patient.insurancePayer !== r.matchInsurancePayer) {
          reasons.push(
            `payer "${patient.insurancePayer}" ≠ "${r.matchInsurancePayer}"`,
          );
        }
      }
      if (r.minTenureDays !== null && tenureDays < r.minTenureDays) {
        reasons.push(
          `tenure ${tenureDays}d < minTenureDays ${r.minTenureDays}d`,
        );
      }
      if (r.maxTenureDays !== null && tenureDays > r.maxTenureDays) {
        reasons.push(
          `tenure ${tenureDays}d > maxTenureDays ${r.maxTenureDays}d`,
        );
      }
      return {
        id: r.id,
        priority: r.priority,
        cadenceDays: r.cadenceDays,
        defaultChannel: r.defaultChannel,
        matchItemSkuPrefix: r.matchItemSkuPrefix,
        matchInsurancePayer: r.matchInsurancePayer,
        minTenureDays: r.minTenureDays,
        maxTenureDays: r.maxTenureDays,
        active: r.active,
        matched: plan.matchedRuleId === r.id,
        reasonsForNoMatch: reasons,
      };
    });

    res.json({
      input: {
        patient: { ...parsed.data.patient, tenureDays },
        prescription: parsed.data.prescription,
        now: now.toISOString(),
      },
      plan,
      evaluated,
    });
  },
);

export default router;
