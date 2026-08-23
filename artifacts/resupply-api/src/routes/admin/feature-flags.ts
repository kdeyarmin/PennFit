// /admin/feature-flags — Control Center backing API.
//
//   GET   /admin/feature-flags         list every flag + current state
//   PATCH /admin/feature-flags/:key    toggle one flag (super_admin only)
//
// The list endpoint is reports.read-gated so anyone who can see the
// Control Center can read the current state without elevation.
// Toggling is admin.tools.manage-gated (collapses to super_admin in
// the current 3-role catalog) — the same posture as macros, message
// templates, and other admin-only knobs.
//
// Audit
// -----
// Every PATCH writes a `feature_flag.toggle` row to resupply.audit_log
// with the key, the old + new values, and the operator's email. No PHI
// — flag keys are static constants.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import {
  isPresetExemptFlag,
  resolvePlanFlagPreset,
} from "@workspace/resupply-domain";

import {
  FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  invalidateFeatureFlagCache,
} from "../../lib/feature-flags";
import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import { resolveTenantPlanCode } from "../../lib/product-scope";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["feature_flags"]["Row"];

const keyParam = z.object({
  key: z.enum(FEATURE_FLAG_KEYS),
});

const patchBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const featureFlagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  description: z.string(),
  category: z.string(),
  // True when THIS running build's catalog (FEATURE_FLAG_KEYS) knows
  // the key, i.e. PATCH would accept a toggle. False for a flag seeded
  // by a newer migration than the running build — see rowToApi below.
  manageable: z.boolean(),
  updatedByEmail: z.string().nullable(),
  updatedAt: z.string(),
});

const listResponseSchema = z.object({
  flags: z.array(featureFlagSchema),
});

const patchResponseSchema = z.object({
  flag: featureFlagSchema,
});

// The PATCH handler validates `:key` against FEATURE_FLAG_KEYS before it
// will write (z.enum → 404 `unknown_flag` otherwise). So a flag whose key
// is NOT in THIS build's catalog is a dead toggle: it still LISTS (the
// list reads DB rows), but every toggle 404s. That happens during a
// deploy-drift window — the database has been migrated forward to seed a
// newer flag while the running build predates the catalog entry. Expose
// that state as `manageable` so the Control Center can disable the switch
// and explain *why* instead of letting the operator hit the raw 404.
const MANAGEABLE_KEYS: ReadonlySet<string> = new Set(FEATURE_FLAG_KEYS);

function rowToApi(r: Row) {
  return {
    key: r.key,
    enabled: r.enabled,
    description: r.description,
    category: r.category,
    manageable: MANAGEABLE_KEYS.has(r.key),
    updatedByEmail: r.updated_by_email,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/feature-flags",
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("feature_flags")
      .select(
        "key, enabled, description, category, updated_by_email, updated_at",
      )
      .eq("org_id", orgId)
      .order("category", { ascending: true })
      .order("key", { ascending: true });
    if (error) throw error;
    const response = listResponseSchema.parse({
      flags: (data ?? []).map((r) => rowToApi(r as Row)),
    });
    res.json(response);
  },
);

router.patch(
  "/admin/feature-flags/:key",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "feature_flags.toggle", preset: "mutation" }),
  async (req, res) => {
    const paramParsed = keyParam.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(404).json({ error: "unknown_flag" });
      return;
    }
    const bodyParsed = patchBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const key = paramParsed.data.key as FeatureFlagKey;
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId).raw();

    // Read the prior state so the audit row carries before/after.
    const { data: priorRow, error: priorErr } = await supabase
      .schema("resupply")
      .from("feature_flags")
      .select(
        "key, enabled, description, category, updated_by_email, updated_at",
      )
      .eq("org_id", orgId)
      .eq("key", key)
      .maybeSingle();
    if (priorErr) throw priorErr;
    if (!priorRow) {
      // Every tenant is provisioned a full set of rows (the seed
      // migration for the seed org; `tenant:onboard` for new orgs). A
      // missing row means this org wasn't provisioned — refuse rather
      // than upsert blindly so we don't paper over an onboarding bug.
      res.status(404).json({ error: "flag_not_seeded", key });
      return;
    }
    if (priorRow.enabled === bodyParsed.data.enabled) {
      const response = patchResponseSchema.parse({
        flag: rowToApi(priorRow as Row),
      });
      res.json(response);
      return;
    }

    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("feature_flags")
      .update({
        enabled: bodyParsed.data.enabled,
        updated_by_user_id: req.adminUserId ?? null,
        updated_by_email: req.adminEmail ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("org_id", orgId)
      .eq("key", key)
      .select(
        "key, enabled, description, category, updated_by_email, updated_at",
      )
      .single();
    if (updateErr) throw updateErr;

    invalidateFeatureFlagCache(key);

    // Two writes for two distinct consumers (kept side by side, NOT a
    // try-then-catch chain, so neither one's failure masks the other):
    //
    //   1. logAudit — historical compatibility. The audit lib is a
    //      no-op stub now (CLAUDE.md / migration 0156); this call is
    //      retained so any SOC tooling still scanning audit_log for
    //      pre-stub rows keeps seeing consistent shape.
    //
    //   2. feature_flag_events INSERT — the durable record that drives
    //      the Control Center's "Recent toggle activity" panel. The
    //      GET /admin/feature-flags/activity handler reads from here
    //      now (previously it read from audit_log, which is silently
    //      empty since the stub).
    //
    // Both are fire-and-forget on failure: a flag toggle that
    // mutated successfully must NOT 5xx because a history row
    // couldn't be written. Failures land in the application log.
    await logAudit({
      action: "feature_flag.toggle",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "feature_flags",
      targetId: key,
      metadata: {
        key,
        from: priorRow.enabled,
        to: bodyParsed.data.enabled,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err: redactDbErr(err) },
        "feature_flag.toggle audit write failed",
      );
    });

    const { error: eventErr } = await supabase
      .schema("resupply")
      .from("feature_flag_events")
      .insert({
        org_id: orgId,
        key,
        previous_enabled: priorRow.enabled,
        next_enabled: bodyParsed.data.enabled,
        operator_email: req.adminEmail ?? null,
      });
    if (eventErr) {
      logger.warn(
        { err: eventErr, key },
        "feature_flag_events insert failed (activity panel will miss this toggle)",
      );
    }

    const response = patchResponseSchema.parse({
      flag: rowToApi(updated as Row),
    });
    res.json(response);
  },
);

// ─────────────────────────────────────────────────────────────────
// POST /admin/feature-flags/apply-preset — re-baseline this tenant's
// flags to the recommended bundle for its current billing plan.
//
// The plan presets (lib/resupply-domain/feature-flag-presets.ts) mirror
// the marketed tiers; new tenants already land on them at onboarding. This
// lets an EXISTING tenant adopt the recommended set after picking/switching
// a plan — one click instead of toggling dozens of switches. Pass
// `{ dryRun: true }` to get the exact diff WITHOUT writing, so the UI can
// confirm the change first.
//
// Only flags THIS build knows (FEATURE_FLAG_KEYS) and that exist as rows
// for the tenant are touched; the per-key cache invalidation, the
// feature_flag_events history rows, and the updated_by/updated_at stamps all
// match the single-flag PATCH path. Gated `admin.tools.manage` like PATCH.
// 409 `no_plan_preset` when the tenant has no active plan to derive from.
// ─────────────────────────────────────────────────────────────────

const applyPresetBody = z.object({ dryRun: z.boolean().optional() }).strict();

router.post(
  "/admin/feature-flags/apply-preset",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "feature_flags.apply_preset", preset: "mutation" }),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const bodyParsed = applyPresetBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const dryRun = bodyParsed.data.dryRun ?? false;

    const planCode = await resolveTenantPlanCode(orgId);
    const preset = resolvePlanFlagPreset(planCode);
    if (!planCode || !preset) {
      // No active plan (or a plan with no preset) → nothing to derive from.
      res.status(409).json({ error: "no_plan_preset", planCode: planCode });
      return;
    }

    const supabase = getOrgScopedClient(orgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("feature_flags")
      .select("key, enabled")
      .eq("org_id", orgId);
    if (error) throw error;

    // Only manageable (in-catalog) flags that actually have a row —
    // minus the keys presets deliberately don't govern. A preset turns
    // OFF everything it doesn't list, so leaving `module.*` in here would
    // make "apply my plan's recommended bundle" wipe out the tenant's own
    // choices about which parts of the console they navigate.
    const current = new Map<string, boolean>();
    for (const r of data ?? []) {
      const row = r as { key: string; enabled: boolean };
      if (!MANAGEABLE_KEYS.has(row.key)) continue;
      if (isPresetExemptFlag(row.key)) continue;
      current.set(row.key, row.enabled);
    }

    const changes: { key: string; from: boolean; to: boolean }[] = [];
    for (const [key, was] of current) {
      const want = preset.has(key);
      if (want !== was) changes.push({ key, from: was, to: want });
    }
    const enabledCount = [...current.keys()].filter((k) =>
      preset.has(k),
    ).length;

    if (dryRun) {
      res.json({
        planCode,
        dryRun: true,
        total: current.size,
        enabledCount,
        changes,
      });
      return;
    }

    // Apply each change row-by-row (catalog is ~66 rows; changes are
    // bounded) so the stamps + per-key cache busting match PATCH exactly.
    const nowIso = new Date().toISOString();
    for (const ch of changes) {
      const { error: upErr } = await supabase
        .schema("resupply")
        .from("feature_flags")
        .update({
          enabled: ch.to,
          updated_by_user_id: req.adminUserId ?? null,
          updated_by_email: req.adminEmail ?? null,
          updated_at: nowIso,
        })
        .eq("org_id", orgId)
        .eq("key", ch.key);
      if (upErr) throw upErr;
      invalidateFeatureFlagCache(ch.key as FeatureFlagKey);
    }

    if (changes.length > 0) {
      // History rows (one per change) + a single audit row, both
      // best-effort — a successful re-baseline must not 5xx on a log write.
      const { error: evErr } = await supabase
        .schema("resupply")
        .from("feature_flag_events")
        .insert(
          changes.map((ch) => ({
            org_id: orgId,
            key: ch.key,
            previous_enabled: ch.from,
            next_enabled: ch.to,
            operator_email: req.adminEmail ?? null,
          })),
        );
      if (evErr) {
        logger.warn(
          { err: evErr, planCode },
          "apply-preset feature_flag_events insert failed (activity panel will miss these)",
        );
      }
      await logAudit({
        action: "feature_flag.apply_preset",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "feature_flags",
        targetId: planCode,
        metadata: { planCode, changed: changes.length },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn(
          { err: redactDbErr(err) },
          "feature_flag.apply_preset audit write failed",
        );
      });
    }

    res.json({
      planCode,
      dryRun: false,
      total: current.size,
      enabledCount,
      changes,
    });
  },
);

// ─────────────────────────────────────────────────────────────────
// GET /admin/feature-flags/activity — recent toggle events.
//
// Read-only feed of the last `limit` (default 20, max 100) toggle
// events from `resupply.feature_flag_events`. Drives the "Recent
// toggle activity" panel on the Control Center.
//
// Source changed in migration 0163: previously SELECTed from
// `resupply.audit_log` filtered by `action='feature_flag.toggle'`.
// The audit lib became a no-op stub when the HIPAA tamper-evident
// chain was retired (migration 0156), so new toggles stopped
// landing rows there and this panel went stale. The PATCH handler
// above now also writes a row to feature_flag_events; that's the
// table this reader hits.
//
// Permission: reports.read (same as the list endpoint above).
//
// PHI posture: feature-flag toggle records never contain PHI
// (the keys are static constants), so the response is safe to
// surface in the admin UI as-is.
// ─────────────────────────────────────────────────────────────────

const ACTIVITY_DEFAULT_LIMIT = 20;
const ACTIVITY_MAX_LIMIT = 100;

interface ToggleActivityRow {
  occurredAt: string;
  operatorEmail: string | null;
  key: string;
  from: boolean;
  to: boolean;
}

const activityQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return ACTIVITY_DEFAULT_LIMIT;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return ACTIVITY_DEFAULT_LIMIT;
      return Math.min(n, ACTIVITY_MAX_LIMIT);
    }),
});

router.get(
  "/admin/feature-flags/activity",
  requirePermission("reports.read"),
  async (req, res) => {
    // `safeParse` (not `.parse()`): a repeated query param
    // (`?limit=1&limit=2`) makes `req.query.limit` an array, which
    // fails `z.string()` and would throw a `ZodError` → unhandled 500.
    // The schema already coerces bad limit values to the default, so a
    // malformed shape should degrade the same way, not 5xx.
    const parsedQuery = activityQuerySchema.safeParse(req.query);
    const limit = parsedQuery.success
      ? parsedQuery.data.limit
      : ACTIVITY_DEFAULT_LIMIT;

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId).raw();
    const { data, error } = await supabase
      .schema("resupply")
      .from("feature_flag_events")
      .select(
        "occurred_at, operator_email, key, previous_enabled, next_enabled",
      )
      .eq("org_id", orgId)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    const activity: ToggleActivityRow[] = (data ?? []).map((r) => ({
      occurredAt: r.occurred_at,
      operatorEmail: r.operator_email ?? null,
      key: r.key,
      from: r.previous_enabled,
      to: r.next_enabled,
    }));
    res.json({ activity });
  },
);

export default router;
