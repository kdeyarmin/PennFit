// /admin/billing/gl-account-mappings — configure the QuickBooks export's
// GL account names (owner #O3), so the bookkeeper stops re-mapping every
// line on import.
//
//   GET /admin/billing/gl-account-mappings   reports.read
//     Resolved accounts (configured value or default) + which are custom.
//   PUT /admin/billing/gl-account-mappings/:key   cost.write
//     Upsert one mapping (deposit | revenue | refund | patient_pay).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  GL_ACCOUNT_DEFAULTS,
  GL_ACCOUNT_KEYS,
  resolveGlAccounts,
  type GlAccountKey,
  type GlAccountMappingRow,
} from "../../lib/billing/gl-accounts";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const KEY_TO_RESOLVED: Record<GlAccountKey, keyof typeof GL_ACCOUNT_DEFAULTS> =
  {
    deposit: "deposit",
    revenue: "revenue",
    refund: "refund",
    patient_pay: "patientPay",
  };

router.get(
  "/admin/billing/gl-account-mappings",
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("gl_account_mappings")
      .select("mapping_key, account_name, updated_at");
    if (error) throw error;
    const rows = (data ?? []) as GlAccountMappingRow[];
    const resolved = resolveGlAccounts(rows);
    const configured = new Set(rows.map((r) => r.mapping_key));
    res.json({
      accounts: GL_ACCOUNT_KEYS.map((key) => ({
        key,
        accountName: resolved[KEY_TO_RESOLVED[key]],
        isCustom: configured.has(key),
        default: GL_ACCOUNT_DEFAULTS[KEY_TO_RESOLVED[key]],
      })),
    });
  },
);

const putBody = z
  .object({ accountName: z.string().trim().min(1).max(160) })
  .strict();
const keyParam = z.enum(GL_ACCOUNT_KEYS);

router.put(
  "/admin/billing/gl-account-mappings/:key",
  requirePermission("cost.write"),
  adminRateLimit({ name: "gl_account_mappings.upsert", preset: "mutation" }),
  async (req, res) => {
    const key = keyParam.safeParse(req.params.key);
    if (!key.success) {
      res.status(404).json({ error: "unknown_mapping_key" });
      return;
    }
    const parsed = putBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("gl_account_mappings")
      .upsert(
        {
          mapping_key: key.data,
          account_name: parsed.data.accountName,
          updated_by_email: req.adminEmail ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "mapping_key" },
      );
    if (error) throw error;
    await logAudit({
      action: "gl_account_mapping.upsert",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "gl_account_mappings",
      targetId: key.data,
      metadata: { mapping_key: key.data },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "gl_account_mapping.upsert audit write failed");
    });
    res.json({ ok: true, key: key.data, accountName: parsed.data.accountName });
  },
);

export default router;
