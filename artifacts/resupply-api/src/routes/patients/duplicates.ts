// GET /patients/duplicates — likely-duplicate patient groups for CSR
// review (CSR #C1, detection half).
//
// The only uniqueness on resupply.patients is pacware_id, so fax/referral
// intake routinely creates a second record for an existing patient. This
// endpoint surfaces the collisions — grouped by a shared blocking key
// (same DOB + last name, same phone, or same email) — so a CSR can spot
// and reconcile them. Detection only: it never mutates anything. The
// destructive merge (repointing every patient_id FK) is a separate,
// deliberate change.
//
// Grouping is done server-side by the resupply.patient_duplicate_groups
// RPC (migration 0223), so the route only ever receives the small set of
// actual collisions, never the whole roster. PHI posture mirrors the
// patient list: names + DOB are returned (a CSR needs them to confirm a
// match), but phone/email VALUES are reduced to hasPhone/hasEmail markers.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const dupQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

interface DuplicateRow {
  group_key: string;
  match_reason: string;
  patient_id: string;
  legal_first_name: string | null;
  legal_last_name: string | null;
  date_of_birth: string | null;
  pacware_id: string | null;
  status: string;
  has_phone: boolean;
  has_email: boolean;
  created_at: string;
}

const router: IRouter = Router();

router.get(
  "/patients/duplicates",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = dupQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .rpc("patient_duplicate_groups", { p_max_groups: parsed.data.limit });
    if (error) {
      res.status(500).json({ error: "duplicate_scan_failed" });
      return;
    }

    // Fold the flat (group_key, patient) rows into groups. The RPC
    // already orders by group_key then created_at, so members arrive
    // grouped + oldest-first (the oldest record is the likely "primary").
    const byGroup = new Map<
      string,
      {
        groupKey: string;
        matchReason: string;
        members: Array<{
          patientId: string;
          firstName: string | null;
          lastName: string | null;
          dateOfBirth: string | null;
          pacwareId: string | null;
          status: string;
          hasPhone: boolean;
          hasEmail: boolean;
          createdAt: string;
        }>;
      }
    >();
    for (const r of (data ?? []) as DuplicateRow[]) {
      let g = byGroup.get(r.group_key);
      if (!g) {
        g = {
          groupKey: r.group_key,
          matchReason: r.match_reason,
          members: [],
        };
        byGroup.set(r.group_key, g);
      }
      g.members.push({
        patientId: r.patient_id,
        firstName: r.legal_first_name,
        lastName: r.legal_last_name,
        dateOfBirth: r.date_of_birth,
        pacwareId: r.pacware_id,
        status: r.status,
        hasPhone: r.has_phone,
        hasEmail: r.has_email,
        createdAt: r.created_at,
      });
    }

    const groups = [...byGroup.values()].map((g) => ({
      ...g,
      memberCount: g.members.length,
    }));
    res.json({ groups, groupCount: groups.length });
  },
);

export default router;
