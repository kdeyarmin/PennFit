// POST /admin/billing/eligibility-quick-check — patient-less 270/271.
//
// "Just check this person's insurance" without creating a patient: the
// operator types the subscriber demographics + member id, picks a payer
// profile, and gets the parsed real-time 271 back inline. NOTHING is
// persisted — no patients row, no coverage, no eligibility_checks row
// (see lib/billing/eligibility-quick-check.ts for the rationale and the
// real-time-only constraint).
//
// PHI posture: the request body is PHI. It is validated, handed to the
// quick-check lib, and never logged; audit metadata carries payer +
// outcome + timing only (no name / DOB / member id).

import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";

import {
  PayerProfileNotFoundError,
  quickCheckEligibility,
} from "../../lib/billing/eligibility-quick-check";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Same budget as the patient-attached verify-eligibility route — each
// request is a paid clearinghouse round-trip.
const quickCheckRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlausibleDob(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  // Reject normalized rollovers (e.g. 2000-02-31 → Mar 2).
  if (date.toISOString().slice(0, 10) !== value) return false;
  const year = date.getUTCFullYear();
  return year >= 1900 && date.getTime() <= Date.now();
}

const quickCheckBody = z
  .object({
    payerProfileId: z.string().uuid(),
    // Length caps mirror the X12 270 NM1 element widths the builder
    // truncates to (last 60 / first 35).
    firstName: z.string().trim().min(1).max(35),
    lastName: z.string().trim().min(1).max(60),
    memberId: z.string().trim().min(1).max(80),
    dateOfBirth: z
      .string()
      .regex(ISO_DATE_RE)
      .refine(isPlausibleDob, "must be a real date between 1900 and today"),
    gender: z.enum(["M", "F", "U"]).optional(),
    hcpcsCode: z
      .string()
      .regex(/^[A-Z]\d{4}$/)
      .optional(),
  })
  .strict();

router.post(
  "/admin/billing/eligibility-quick-check",
  requirePermission("patients.update"),
  quickCheckRateLimiter,
  async (req, res) => {
    const parsed = quickCheckBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    try {
      const result = await quickCheckEligibility({
        payerProfileId: body.payerProfileId,
        subscriber: {
          firstName: body.firstName,
          lastName: body.lastName,
          memberId: body.memberId,
          dateOfBirth: body.dateOfBirth,
          gender: body.gender,
        },
        hcpcsCode: body.hcpcsCode ?? null,
      });
      await logAudit({
        action: "eligibility.quick_check",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "payer_profiles",
        targetId: body.payerProfileId,
        metadata: {
          // Outcome + timing only — the subscriber fields are PHI and
          // deliberately never leave the request/response cycle.
          payer_profile_id: body.payerProfileId,
          hcpcs: body.hcpcsCode ?? null,
          status: result.status,
          latency_ms: result.status === "parsed" ? result.latencyMs : null,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "eligibility.quick_check audit write failed");
      });
      if (result.status === "parsed") {
        res.json(result);
        return;
      }
      // unavailable / failed → structured 409 so the SPA can render the
      // PHI-free reason inline (mirrors verify_failed on the
      // patient-attached route).
      res.status(409).json({
        error:
          result.status === "unavailable"
            ? "realtime_not_configured"
            : "quick_check_failed",
        message: result.message,
      });
    } catch (err) {
      if (err instanceof PayerProfileNotFoundError) {
        res.status(404).json({ error: "payer_not_found" });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "eligibility.quick_check failed");
      res.status(409).json({ error: "quick_check_failed", message: msg });
    }
  },
);

export default router;
