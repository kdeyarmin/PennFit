// /admin/integrations/errors — sync-failure triage queue.
//
//   GET  /admin/integrations/errors
//        List every patient_integration_snapshots row with
//        fetch_status='error' from the last 30 days, newest first.
//
//   POST /admin/integrations/errors/retry
//        Body: { snapshotIds: [...] }
//        Retry each snapshot via its adapter. Each retry runs through
//        the same persistence path as the manual refresh endpoint.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  type IntegrationSource,
  integrationSnapshotSchema,
} from "@workspace/resupply-integrations";

import { getIntegrationAdapters } from "../../lib/integrations/registry";
import { persistTherapyNights } from "../../lib/integrations/persist-nights";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/integrations/errors",
  requireAdmin,
  async (_req, res) => {
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .select(
        "id, patient_id, source, partner_patient_id, fetch_status, fetch_error, fetched_at",
      )
      .eq("fetch_status", "error")
      .gte("fetched_at", cutoff)
      .order("fetched_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({
      errors: (data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        source: r.source,
        partnerPatientId: r.partner_patient_id,
        fetchError: r.fetch_error,
        fetchedAt: r.fetched_at,
      })),
    });
  },
);

const retryBody = z
  .object({
    snapshotIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

router.post(
  "/admin/integrations/errors/retry",
  requireAdmin,
  async (req, res) => {
    const parsed = retryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const adapters = getIntegrationAdapters();
    const { data: rows, error: lookupErr } = await supabase
      .schema("resupply")
      .from("patient_integration_snapshots")
      .select("id, patient_id, source, partner_patient_id")
      .in("id", parsed.data.snapshotIds);
    if (lookupErr) throw lookupErr;

    let retried = 0;
    let succeeded = 0;
    let failed = 0;
    for (const row of rows ?? []) {
      retried += 1;
      const source = row.source as IntegrationSource;
      const adapter = adapters.get(source);
      if (!adapter) {
        failed += 1;
        continue;
      }
      const result = await adapter.fetchSnapshot({
        partnerPatientId: row.partner_patient_id,
      });
      const fetchedAtIso = new Date().toISOString();
      if (!result.ok) {
        await supabase
          .schema("resupply")
          .from("patient_integration_snapshots")
          .update({
            fetch_status: "error",
            fetch_error: result.error,
            fetched_at: fetchedAtIso,
          })
          .eq("id", row.id);
        failed += 1;
        continue;
      }
      const parsedSnap = integrationSnapshotSchema.safeParse(result.snapshot);
      if (!parsedSnap.success) {
        await supabase
          .schema("resupply")
          .from("patient_integration_snapshots")
          .update({
            fetch_status: "error",
            fetch_error: "schema_invalid",
            fetched_at: fetchedAtIso,
          })
          .eq("id", row.id);
        failed += 1;
        continue;
      }
      await supabase
        .schema("resupply")
        .from("patient_integration_snapshots")
        .update({
          payload: parsedSnap.data as unknown as Record<string, unknown>,
          fetch_status: "ok",
          fetch_error: null,
          fetched_at: fetchedAtIso,
        })
        .eq("id", row.id);
      try {
        await persistTherapyNights(
          supabase,
          row.patient_id,
          source,
          parsedSnap.data.recentNights,
        );
      } catch (err) {
        logger.warn({ err }, "errors.retry persistTherapyNights failed");
      }
      succeeded += 1;
    }
    res.json({ retried, succeeded, failed });
  },
);

export default router;
