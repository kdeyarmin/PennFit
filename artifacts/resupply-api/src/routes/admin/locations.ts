// /admin/locations — business-location (branch) registry (owner #O1
// groundwork). CRUD only — NOTHING in the app scopes data by location
// yet; this is the foundation a later multi-branch rollout builds on.
//
//   GET   /admin/locations          reports.read   (list + resolved primary)
//   POST  /admin/locations          admin-only     (create)
//   PATCH /admin/locations/:id       admin-only     (update / set-primary / deactivate)
//
// Setting a location primary clears the flag on the others first (a
// partial unique index enforces at most one primary at the DB level).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { pickPrimaryLocation } from "../../lib/locations/pick-primary";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const SELECT =
  "id, name, code, address_line1, address_line2, city, state, postal_code, phone_e164, npi, is_primary, is_active, created_at, updated_at";

const baseFields = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().max(40).nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(40).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  phoneE164: z.string().trim().max(20).nullable().optional(),
  npi: z.string().trim().max(20).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
const createBody = baseFields.strict();
const patchBody = baseFields
  .extend({ isActive: z.boolean().optional() })
  .partial()
  .strict();
const idParam = z.string().uuid();

function toColumns(d: z.infer<typeof patchBody>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d.name !== undefined) out.name = d.name;
  if (d.code !== undefined) out.code = d.code;
  if (d.addressLine1 !== undefined) out.address_line1 = d.addressLine1;
  if (d.addressLine2 !== undefined) out.address_line2 = d.addressLine2;
  if (d.city !== undefined) out.city = d.city;
  if (d.state !== undefined) out.state = d.state;
  if (d.postalCode !== undefined) out.postal_code = d.postalCode;
  if (d.phoneE164 !== undefined) out.phone_e164 = d.phoneE164;
  if (d.npi !== undefined) out.npi = d.npi;
  if (d.isActive !== undefined) out.is_active = d.isActive;
  return out;
}

/** Clear is_primary on every currently-primary row (before setting a new one). */
async function clearExistingPrimary(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("locations")
    .update({ is_primary: false, updated_at: new Date().toISOString() })
    .eq("is_primary", true);
  if (error) throw error;
}

router.get(
  "/admin/locations",
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("locations")
      .select(SELECT)
      .order("name", { ascending: true })
      .limit(500);
    if (error) throw error;
    const rows = data ?? [];
    const primary = pickPrimaryLocation(rows);
    res.json({ locations: rows, primaryId: primary?.id ?? null });
  },
);

// Per-branch operational rollup (multi-location #O1 phase 4): patient +
// staff counts per location, plus an `unassigned` bucket (the RPC's
// NULL-location_id row). Names are merged in from `locations` so the
// page can render counts beside each branch without a second client
// call. Counts only — no PHI.
router.get(
  "/admin/locations/rollup",
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const [{ data: locs, error: locErr }, { data: roll, error: rollErr }] =
      await Promise.all([
        supabase
          .schema("resupply")
          .from("locations")
          .select("id, name, is_active")
          .order("name", { ascending: true })
          .limit(500),
        supabase.schema("resupply").rpc("location_rollup"),
      ]);
    if (locErr) throw locErr;
    if (rollErr) throw rollErr;

    type RollRow = {
      location_id: string | null;
      patient_count: number | string;
      active_patient_count: number | string;
      staff_count: number | string;
    };
    const byId = new Map<string | null, RollRow>();
    for (const r of (roll ?? []) as RollRow[]) byId.set(r.location_id, r);
    const counts = (id: string | null) => {
      const r = byId.get(id);
      return {
        patientCount: Number(r?.patient_count ?? 0),
        activePatientCount: Number(r?.active_patient_count ?? 0),
        staffCount: Number(r?.staff_count ?? 0),
      };
    };

    res.json({
      branches: (locs ?? []).map((l) => ({
        locationId: l.id,
        name: l.name,
        isActive: l.is_active,
        ...counts(l.id),
      })),
      // Patients/staff with no branch assigned (RPC's NULL row).
      unassigned: counts(null),
    });
  },
);

router.post(
  "/admin/locations",
  requireAdminOnly,
  adminRateLimit({ name: "locations.create", preset: "mutation" }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    if (parsed.data.isPrimary) await clearExistingPrimary(supabase);
    const { data, error } = await supabase
      .schema("resupply")
      .from("locations")
      .insert({
        ...toColumns(parsed.data),
        is_primary: parsed.data.isPrimary ?? false,
      })
      .select("id")
      .single();
    if (error) throw error;
    await audit(req, "location.create", data.id, { name: parsed.data.name });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/locations/:id",
  requireAdminOnly,
  adminRateLimit({ name: "locations.update", preset: "mutation" }),
  async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    if (parsed.data.isPrimary) await clearExistingPrimary(supabase);
    const update = {
      ...toColumns(parsed.data),
      ...(parsed.data.isPrimary !== undefined
        ? { is_primary: parsed.data.isPrimary }
        : {}),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .schema("resupply")
      .from("locations")
      .update(update)
      .eq("id", id.data)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await audit(req, "location.update", id.data, {});
    res.json({ ok: true });
  },
);

async function audit(
  req: import("express").Request,
  action: string,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    action,
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "locations",
    targetId,
    metadata,
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err, action }, "locations audit write failed");
  });
}

export default router;
