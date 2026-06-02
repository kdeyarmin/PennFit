// POST /admin/patients/:id/integrations/refresh-supplies — re-fetch
// the vendor's supply roster after a resupply ships.
//
// Why a dedicated endpoint vs. piggy-backing on the existing
// /integrations/refresh:
//   * Today /refresh requires a `source` parameter; the post-ship
//     hook doesn't know which therapy-link source this patient is
//     on. This handler iterates EVERY active link for the patient.
//   * It only mirrors the snapshot's `supplies` field — therapy
//     nights are out of scope for this hook (a fresh shipment
//     doesn't add nights).
//
// CSR / worker flow:
//   1. Fulfillment dispatched to Pacware → tracking entered.
//   2. Tracking webhook marks delivered.
//   3. (this endpoint) → vendor updates "last_replaced_date" on
//      the supply row, the resupply scanner sees the new floor and
//      doesn't re-trigger the same SKU prematurely.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  type IntegrationSource,
  integrationSnapshotSchema,
} from "@workspace/resupply-integrations";

import { getIntegrationAdaptersWithDbOverrides } from "../../lib/integrations/registry";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.post(
  "/admin/patients/:id/integrations/refresh-supplies",
  // Post-shipment hook that re-fetches the vendor supply roster
  // for one patient — `patients.update` matches the other
  // patient-integration write surfaces (refresh, therapy-links
  // CRUD, etc.) so the same roles can drive the workflow end-to-
  // end.
  requirePermission("patients.update"),
  adminRateLimit({
    name: "integrations.refresh_supplies",
    preset: "mutation",
  }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = idParse.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data: links, error } = await supabase
      .schema("resupply")
      .from("patient_therapy_links")
      .select("source, partner_patient_id")
      .eq("patient_id", patientId)
      .eq("status", "active");
    if (error) throw error;
    if (!links || links.length === 0) {
      res.json({ refreshed: 0, sources: [] });
      return;
    }
    const adapters = await getIntegrationAdaptersWithDbOverrides();
    const refreshedSources: string[] = [];
    let failed = 0;
    for (const link of links) {
      const source = link.source as IntegrationSource;
      const adapter = adapters.get(source);
      if (!adapter) continue;
      const result = await adapter.fetchSnapshot({
        partnerPatientId: link.partner_patient_id,
      });
      if (!result.ok) {
        failed += 1;
        continue;
      }
      const parsed = integrationSnapshotSchema.safeParse(result.snapshot);
      if (!parsed.success) {
        failed += 1;
        continue;
      }
      // Read the prior payload, replace only the `supplies` field, and
      // upsert. Preserves recent nights + settings from the last good
      // pull so we never destructively overwrite working data with a
      // partial fetch.
      const { data: prior } = await supabase
        .schema("resupply")
        .from("patient_integration_snapshots")
        .select("payload")
        .eq("patient_id", patientId)
        .eq("source", source)
        .limit(1)
        .maybeSingle();
      const priorPayload =
        prior?.payload &&
        typeof prior.payload === "object" &&
        !Array.isArray(prior.payload)
          ? (prior.payload as Record<string, unknown>)
          : null;
      const mergedPayload = priorPayload
        ? { ...priorPayload, supplies: parsed.data.supplies }
        : parsed.data;
      await supabase
        .schema("resupply")
        .from("patient_integration_snapshots")
        .upsert(
          {
            patient_id: patientId,
            source,
            partner_patient_id: link.partner_patient_id,
            payload: mergedPayload as unknown as Record<string, unknown>,
            fetch_status: "ok",
            fetch_error: null,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "patient_id,source" },
        );
      refreshedSources.push(source);
    }
    await logAudit({
      action: "patient.integration_snapshot.supplies_refreshed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_integration_snapshots",
      targetId: null,
      metadata: {
        patient_id: patientId,
        refreshed_sources: refreshedSources,
        failed,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "supplies_refreshed audit failed");
    });
    res.json({
      refreshed: refreshedSources.length,
      sources: refreshedSources,
      failed,
    });
  },
);

export default router;
