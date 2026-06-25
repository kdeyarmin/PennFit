// POST /admin/payer-fee-schedules/import-cms
//
// Import the Medicare CMS DMEPOS fee schedule (the quarterly public-use
// `DMEPOS<YY>_<MON>.csv` grid) into payer_fee_schedules for a payer + state.
// Parses the chosen state's non-rural (or rural) column, then REPLACES any
// prior `cms_published` rows for (payer, effective_from) so a re-import of the
// same quarter is idempotent.
//
// Body: { payerProfileId, state, rural?, effectiveFrom, csv }
// Returns: { accepted, replaced, warnings }
//
// Use for the Medicare DME MAC payer profile; commercial fee schedules still
// use the manual /import-csv path. The CMS national file is ~21 MB, but a
// state-filtered export is small; the body cap below sits above a typical
// single-state file.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { parseCmsDmeposFeeScheduleCsv } from "../../lib/billing/cms-dmepos-fee-schedule";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    payerProfileId: z.string().uuid(),
    state: z
      .string()
      .trim()
      .length(2)
      .transform((s) => s.toUpperCase()),
    rural: z.boolean().optional(),
    effectiveFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
    csv: z
      .string()
      .min(20)
      .max(30 * 1024 * 1024),
  })
  .strict();

router.post(
  "/admin/payer-fee-schedules/import-cms",
  requireAdminOnly,
  adminRateLimit({
    name: "payer_fee_schedules.import_cms",
    preset: "sensitive",
  }),
  async (req, res) => {
    const parsed = body.safeParse(req.body);
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const { payerProfileId, state, rural, effectiveFrom, csv } = parsed.data;
    const supabase = getOrgScopedClient(orgId);

    const { data: payer } = await supabase
      .from("payer_profiles")
      .select("id")
      .eq("id", payerProfileId)
      .limit(1)
      .maybeSingle();
    if (!payer) {
      res.status(404).json({ error: "payer_profile_not_found" });
      return;
    }

    const { rows, warnings } = parseCmsDmeposFeeScheduleCsv(csv, {
      state,
      rural,
    });
    if (rows.length === 0) {
      res.status(400).json({ accepted: 0, replaced: 0, warnings });
      return;
    }

    const note = `CMS DMEPOS ${state}${rural ? " rural" : ""}`;
    const payload = rows.map((r) => ({
      hcpcs_code: r.hcpcs,
      // The CMS grid is keyed by (HCPCS, Mod, Mod2). Persist BOTH modifiers
      // as the comma-joined set pickFeeScheduleRowByModifiers subset-matches
      // on — dropping Mod2 collapsed distinct fee rows that share Mod1 into
      // the same (hcpcs, Mod1) key, producing ambiguous duplicates and
      // mis-priced claims.
      modifier:
        [r.modifier, r.modifier2]
          .filter((m): m is string => Boolean(m))
          .map((m) => m.toUpperCase())
          .join(",") || null,
      allowed_cents: r.allowedCents,
      notes: note,
    }));

    // Atomic replace: drop the prior CMS import for this payer + quarter and
    // insert the new rows in ONE transaction (migration 0416). A failed
    // import leaves the prior COMPLETE schedule untouched — these rows drive
    // claim pricing, so a partial replace would mis-price claims.
    const { data: rpcData, error: rpcErr } = await supabase
      .raw()
      .schema("resupply")
      .rpc("replace_cms_fee_schedule", {
        p_org_id: orgId,
        p_payer_profile_id: payer.id,
        p_effective_from: effectiveFrom,
        p_rows: payload,
      });
    if (rpcErr) {
      // Log the error OBJECT (not `.message`) so the logger's err.* redaction
      // strips any row values a constraint violation might echo.
      logger.warn({ err: rpcErr }, "cms-fee-schedule.import: replace failed");
      res.status(500).json({ error: "import_failed", message: rpcErr.message });
      return;
    }
    const summary = (rpcData ?? {}) as {
      replaced?: number;
      accepted?: number;
    };
    const accepted =
      typeof summary.accepted === "number" ? summary.accepted : payload.length;
    const replaced =
      typeof summary.replaced === "number" ? summary.replaced : 0;

    await logAudit({
      action: "payer_fee_schedule.import_cms",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_fee_schedules",
      targetId: payer.id,
      metadata: {
        payer_profile_id: payer.id,
        state,
        rural: Boolean(rural),
        effective_from: effectiveFrom,
        accepted,
        replaced,
        warning_count: warnings.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_fee_schedule.import_cms audit write failed");
    });

    res.status(201).json({ accepted, replaced, warnings });
  },
);

export default router;
