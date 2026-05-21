// /admin/denial-codes — CARC / RARC catalog browse + admin maintenance.
//
//   GET   /admin/denial-codes?codeSystem=carc&q=...&category=...
//   GET   /admin/denial-codes/:codeSystem/:code   (lookup by natural key)
//   POST  /admin/denial-codes        admin-only
//   PATCH /admin/denial-codes/:id    admin-only

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type DenialCodeRow = Database["resupply"]["Tables"]["denial_codes"]["Row"];

const CODE_SYSTEM_VALUES = ["carc", "rarc", "custom"] as const satisfies readonly DenialCodeRow["code_system"][];
const CATEGORY_VALUES = [
  "eligibility",
  "authorization",
  "documentation",
  "medical_necessity",
  "duplicate",
  "coverage_limit",
  "coding",
  "cob",
  "patient_liability",
  "timely_filing",
  "other",
] as const satisfies readonly DenialCodeRow["category"][];

const upsertBody = z
  .object({
    codeSystem: z.enum(CODE_SYSTEM_VALUES),
    code: z.string().trim().min(1).max(8).regex(/^[A-Za-z0-9]+$/),
    description: z.string().trim().min(1).max(400),
    category: z.enum(CATEGORY_VALUES),
    recommendedAction: z.string().trim().max(2000).nullable().optional(),
    isTerminal: z.boolean().default(false),
  })
  .strict();

const patchBody = upsertBody.partial();

const idParam = z.object({ id: z.string().uuid() });

function rowToApi(r: DenialCodeRow) {
  return {
    id: r.id,
    codeSystem: r.code_system,
    code: r.code,
    description: r.description,
    category: r.category,
    recommendedAction: r.recommended_action,
    isTerminal: r.is_terminal,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/denial-codes",
  requirePermission("reports.read"),
  async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("denial_codes")
    .select(
      "id, code_system, code, description, category, recommended_action, is_terminal, created_at, updated_at",
    )
    .order("code_system", { ascending: true })
    .order("code", { ascending: true })
    .limit(500);
  const codeSystem =
    typeof req.query.codeSystem === "string" ? req.query.codeSystem : undefined;
  if (codeSystem && (CODE_SYSTEM_VALUES as readonly string[]).includes(codeSystem)) {
    query = query.eq("code_system", codeSystem as DenialCodeRow["code_system"]);
  }
  const category =
    typeof req.query.category === "string" ? req.query.category : undefined;
  if (category && (CATEGORY_VALUES as readonly string[]).includes(category)) {
    query = query.eq("category", category as DenialCodeRow["category"]);
  }
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length > 0 && q.length <= 80) {
    const safe = q.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.ilike("description", `%${safe}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  res.json({ denialCodes: (data ?? []).map(rowToApi) });
});

router.get(
  "/admin/denial-codes/:codeSystem/:code",
  requirePermission("reports.read"),
  async (req, res) => {
    const { codeSystem, code } = req.params;
    const csParam = typeof codeSystem === "string" ? codeSystem : "";
    const cParam = typeof code === "string" ? code : "";
    if (!isCodeSystem(csParam)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("denial_codes")
      .select(
        "id, code_system, code, description, category, recommended_action, is_terminal, created_at, updated_at",
      )
      .eq("code_system", csParam)
      .eq("code", cParam.toUpperCase())
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ denialCode: rowToApi(data) });
  },
);

router.post(
  "/admin/denial-codes",
  requireAdminOnly,
  adminRateLimit({ name: "denial_codes.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = upsertBody.safeParse(req.body);
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
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("denial_codes")
      .insert({
        code_system: b.codeSystem,
        code: b.code.toUpperCase(),
        description: b.description,
        category: b.category,
        recommended_action: b.recommendedAction ?? null,
        is_terminal: b.isTerminal,
      })
      .select("id")
      .single();
    if (error) {
      if (typeof error.code === "string" && error.code === "23505") {
        res.status(409).json({ error: "code_conflict" });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "denial_code.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "denial_codes",
      targetId: data.id,
      metadata: { code_system: b.codeSystem, code: b.code },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "denial_code.create audit write failed");
    });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/denial-codes/:id",
  requireAdminOnly,
  adminRateLimit({ name: "denial_codes.update", preset: "mutation" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["denial_codes"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.codeSystem !== undefined) update.code_system = b.codeSystem;
    if (b.code !== undefined) update.code = b.code.toUpperCase();
    if (b.description !== undefined) update.description = b.description;
    if (b.category !== undefined) update.category = b.category;
    if (b.recommendedAction !== undefined)
      update.recommended_action = b.recommendedAction;
    if (b.isTerminal !== undefined) update.is_terminal = b.isTerminal;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("denial_codes")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "denial_code.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "denial_codes",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "denial_code.update audit write failed");
    });
    res.json({ ok: true });
  },
);

/**
 * Determines whether a string is a valid denial-code `code_system`.
 *
 * @param v - The string to test
 * @returns `true` if `v` is one of the allowed code system values (`"carc"`, `"rarc"`, or `"custom"`), `false` otherwise.
 */
function isCodeSystem(v: string): v is DenialCodeRow["code_system"] {
  return (CODE_SYSTEM_VALUES as readonly string[]).includes(v);
}

export default router;
