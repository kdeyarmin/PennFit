// /admin/patients/:id/prior-authorizations/:paId/submit-davinci-pas
//
// FHIR-based prior auth submission per the Da Vinci PAS IG v2.2. The full
// build/submit/parse/persist core lives in lib/billing/submit-prior-auth.ts so
// the automation worker (worker/jobs/prior-auth-auto-submit.ts) reuses the
// exact same path; this route is a thin auth + validation wrapper that maps the
// helper's structured result to an HTTP response.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { submitPriorAuth } from "../../lib/billing/submit-prior-auth";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  paId: z.string().uuid(),
});

// Optional submit body. `quantity` overrides the default of 1 (e.g. supplies
// requested in multiple units); equipment PAs can omit it.
const submitBody = z
  .object({
    quantity: z.number().int().min(1).max(9999).optional(),
  })
  .strict();

router.post(
  "/admin/patients/:id/prior-authorizations/:paId/submit-davinci-pas",
  requirePermission("patients.update"),
  adminRateLimit({ name: "davinci_pas.submit", preset: "mutation" }),
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = submitBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const result = await submitPriorAuth({
      orgId,
      patientId: idParsed.data.id,
      paId: idParsed.data.paId,
      quantity: bodyParsed.data.quantity,
      actorEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    if (!result.ok) {
      res
        .status(result.httpStatus)
        .json(
          result.message
            ? { error: result.code, message: result.message }
            : { error: result.code },
        );
      return;
    }

    res.status(result.httpStatus).json({
      submissionId: result.submissionId,
      transportStatus: result.transportStatus,
      decision: result.decision,
      authNumber: result.authNumber,
      denialReason: result.denialReason,
      dispositionText: result.dispositionText,
      latencyMs: result.latencyMs,
    });
  },
);

export default router;
