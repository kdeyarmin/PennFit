// POST /admin/resupply/bootstrap-prescriptions — seed standard consumable
// Rx lines (+ outreach episodes) for active patients with none yet.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";

import {
  commitBootstrapPrescriptions,
  previewBootstrapPrescriptions,
} from "../../lib/resupply/bootstrap-prescriptions.js";
import { logger } from "../../lib/logger.js";
import { redactDbErr } from "../../lib/redact-db-err.js";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit.js";
import { requireAdmin } from "../../middlewares/requireAdmin.js";
import { withIdempotency } from "../../middlewares/idempotency.js";

const router: IRouter = Router();

const bodySchema = z
  .object({
    mode: z.enum(["preview", "commit"]),
    /** Default true — typical post-PacWare-import cohort. */
    onlyPacwarePatients: z.boolean().optional(),
  })
  .strict();

router.post(
  "/admin/resupply/bootstrap-prescriptions",
  adminWriteRateLimiter,
  requireAdmin,
  withIdempotency("POST /admin/resupply/bootstrap-prescriptions"),
  async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
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

    const input = {
      orgId,
      onlyPacwarePatients: parsed.data.onlyPacwarePatients,
    };

    try {
      if (parsed.data.mode === "preview") {
        const preview = await previewBootstrapPrescriptions(input);
        res.status(200).json(preview);
        return;
      }

      const result = await commitBootstrapPrescriptions(input);

      await logAudit({
        action: "resupply.bootstrap_prescriptions",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "prescriptions",
        targetId: null,
        metadata: {
          eligible_patients: result.eligiblePatients,
          patients_bootstrapped: result.patientsBootstrapped,
          prescriptions_created: result.prescriptionsCreated,
          episodes_opened: result.episodesOpened,
          episode_open_failures: result.episodeOpenFailures,
          only_pacware_patients: result.onlyPacwarePatients,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn(
          { err: redactDbErr(err) },
          "resupply.bootstrap_prescriptions audit write failed",
        );
      });

      res.status(200).json(result);
    } catch (err) {
      logger.error(
        { err: redactDbErr(err), event: "bootstrap_prescriptions_failed" },
        "bootstrap-prescriptions route failed",
      );
      res.status(500).json({ error: "bootstrap_failed" });
    }
  },
);

export default router;
