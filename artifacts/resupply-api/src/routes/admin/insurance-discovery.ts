// POST /admin/billing/insurance-discovery — patient-less coverage search.
//
// "Find out what insurance this person has" without creating a patient: the
// operator types the demographics (name + DOB, optionally SSN / a stale
// member id / zip) and Office Ally searches its payer network for active
// coverage. NOTHING is persisted (see lib/billing/insurance-discovery.ts for
// the rationale and the real-time-only constraint).
//
// Gating: insurance discovery is a paid add-on, so the route is gated behind
// the `insurance.discovery` feature flag — a tenant without the add-on gets a
// 403 and never reaches the (billable) clearinghouse search.
//
// PHI posture: the request body is PHI. It is validated, handed to the
// discovery lib, and never logged; audit metadata carries outcome + timing +
// match counts only (no name / DOB / SSN / member id).

import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";

import { runInsuranceDiscovery } from "../../lib/billing/insurance-discovery";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Same budget as the eligibility verify / quick-check routes — each request
// is a paid clearinghouse round-trip.
const discoveryRateLimiter = rateLimit({
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

const discoveryBody = z
  .object({
    // Length caps mirror the X12 NM1 element widths (last 60 / first 35).
    firstName: z.string().trim().min(1).max(35),
    lastName: z.string().trim().min(1).max(60),
    dateOfBirth: z
      .string()
      .regex(ISO_DATE_RE)
      .refine(isPlausibleDob, "must be a real date between 1900 and today"),
    gender: z.enum(["M", "F", "U"]).optional(),
    // SSN optional; 9 digits (dashes stripped client-side or here).
    ssn: z
      .string()
      .trim()
      .transform((s) => s.replace(/\D/g, ""))
      .refine((s) => s === "" || s.length === 9, "SSN must be 9 digits")
      .optional(),
    memberId: z.string().trim().max(80).optional(),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{5}(-?\d{4})?$/, "ZIP must be 5 or 9 digits")
      .optional(),
    serviceDate: z.string().regex(ISO_DATE_RE).optional(),
  })
  .strict();

router.post(
  "/admin/billing/insurance-discovery",
  requirePermission("patients.update"),
  discoveryRateLimiter,
  async (req, res) => {
    // Paid add-on gate: a tenant without `insurance.discovery` can't reach
    // the billable clearinghouse search.
    if (!(await isFeatureEnabled("insurance.discovery", req.orgId))) {
      res.status(403).json({
        error: "addon_not_enabled",
        message:
          "Insurance discovery is an add-on that isn't enabled for your " +
          "account. Add it from Billing → Package & usage to turn it on.",
      });
      return;
    }

    const parsed = discoveryBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;
    try {
      const result = await runInsuranceDiscovery({
        subscriber: {
          firstName: body.firstName,
          lastName: body.lastName,
          dateOfBirth: body.dateOfBirth,
          gender: body.gender,
          ssn: body.ssn && body.ssn.length === 9 ? body.ssn : null,
          memberId: body.memberId ?? null,
          postalCode: body.postalCode ?? null,
        },
        serviceDate: body.serviceDate ?? null,
        orgId: req.orgId,
      });
      await logAudit({
        action: "insurance.discovery",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "clearinghouse_credentials",
        targetId: null,
        metadata: {
          // Outcome + timing + counts only — the demographics are PHI and
          // deliberately never leave the request/response cycle.
          status: result.status,
          latency_ms:
            result.status === "found" || result.status === "none"
              ? result.latencyMs
              : null,
          matched: result.status === "found" ? result.coverages.length : 0,
          active: result.status === "found" ? result.activeCount : 0,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "insurance.discovery audit write failed");
      });
      if (result.status === "found" || result.status === "none") {
        res.json(result);
        return;
      }
      // unavailable / failed → structured 409 so the SPA can render the
      // PHI-free reason inline (mirrors the quick-check route).
      res.status(409).json({
        error:
          result.status === "unavailable"
            ? "discovery_not_configured"
            : "discovery_failed",
        message: result.message,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "insurance.discovery failed");
      res.status(409).json({ error: "discovery_failed", message: msg });
    }
  },
);

export default router;
