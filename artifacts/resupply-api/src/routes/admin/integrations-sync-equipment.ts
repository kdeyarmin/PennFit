// POST /admin/patients/:id/integrations/sync-equipment — backfill
// the equipment_assets + recall scan for a patient from their most
// recent cached integration snapshots. Useful when:
//   * The auto-link path landed before the recall table had the row
//     the device matches against — re-run picks up the new recall.
//   * A CSR added a new patient_therapy_links row by hand and wants
//     equipment + recall scan to fire without waiting for a refresh.
//
// Walks every (patient_id, source) row in patient_integration_snapshots
// for this patient, replays linkEquipmentFromSnapshot +
// scanRecallsForAsset, and returns the aggregate counts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import type { DeviceSettings } from "@workspace/resupply-integrations";

import { linkEquipmentFromSnapshot } from "../../lib/integrations/link-equipment";
import { scanRecallsForAsset } from "../../lib/integrations/scan-recalls-for-asset";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.post(
  "/admin/patients/:id/integrations/sync-equipment",
  requirePermission("patients.update"),
  adminRateLimit({ name: "integrations.sync_equipment", preset: "mutation" }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idParse.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data: snapshots, error } = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .select("source, payload, fetch_status")
      .eq("patient_id", patientId)
      .eq("fetch_status", "ok");
    if (error) throw error;

    let linked = 0;
    let recallsQueued = 0;
    let skipped = 0;
    for (const snap of snapshots ?? []) {
      const payload =
        snap.payload &&
        typeof snap.payload === "object" &&
        !Array.isArray(snap.payload)
          ? (snap.payload as { settings?: DeviceSettings | null })
          : null;
      const settings = payload?.settings ?? null;
      const outcome = await linkEquipmentFromSnapshot(
        supabase,
        patientId,
        settings,
      );
      if (outcome.kind === "inserted" || outcome.kind === "matched") {
        const scan = await scanRecallsForAsset(supabase, outcome.assetId);
        if (outcome.kind === "inserted") linked += 1;
        recallsQueued += scan.notificationsQueued;
      } else {
        skipped += 1;
      }
    }

    await logAudit({
      action: "patient.equipment.sync_from_snapshots",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: patientId,
      metadata: {
        patient_id: patientId,
        snapshots_scanned: snapshots?.length ?? 0,
        linked,
        recalls_queued: recallsQueued,
        skipped,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "equipment.sync_from_snapshots audit failed");
    });

    res.json({
      scanned: snapshots?.length ?? 0,
      linked,
      recallsQueued,
      skipped,
    });
  },
);

export default router;
