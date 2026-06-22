// recordPatientAccess — middleware that records staff access to
// patient information for the admin Audit Trail report.
//
// How it works: it attaches a `res.on("finish")` hook and returns
// immediately, so it adds ZERO latency to the request and the DB write
// happens after the response has been flushed. On finish it reads the
// admin identity that `requireAdmin` attached to the request during
// handling (`req.adminUserId` / `req.adminEmail` / `req.orgId`); if
// those are absent the request was not authenticated staff, so nothing
// is recorded. The path is then classified (see classifyPatientAccess)
// and only patient-data surfaces produce a row.
//
// Posture (matches the rest of the access-log design):
//   - Fire-and-forget. A failed insert is logged with a stable
//     `event=patient_access_log_write_failed` tag and otherwise
//     swallowed — auditing must never break the request it observes.
//   - Tenant-scoped through getOrgScopedClient(), which auto-tags
//     `org_id` on the insert.
//   - PHI-safe: only ids + method + path are stored (the query string
//     is dropped — it can carry patient-name search terms).
//
// This is NOT the retired `@workspace/resupply-audit` / `audit_log`
// machinery; it writes the plain `resupply.patient_access_log` table
// (migration 0456).

import type { NextFunction, Request, Response } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { classifyPatientAccess } from "./classify-patient-access";

export function recordPatientAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.on("finish", () => {
    try {
      const adminUserId = req.adminUserId;
      const adminEmail = req.adminEmail;
      const orgId = req.orgId;
      // Only authenticated staff requests (requireAdmin populated these)
      // are eligible. Public / customer / unauthenticated requests carry
      // no admin identity and are skipped.
      if (!adminUserId || !adminEmail || !orgId) return;

      const pathOnly = (req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
      const descriptor = classifyPatientAccess(req.method, pathOnly);
      if (!descriptor) return;

      const row = {
        admin_user_id: adminUserId,
        admin_email: adminEmail,
        admin_role: req.adminRole ?? null,
        action: descriptor.action,
        method: req.method,
        path: pathOnly.slice(0, 512),
        target_table: descriptor.targetTable,
        target_id: descriptor.targetId,
        patient_id: descriptor.patientId,
        status_code: res.statusCode,
        ip: req.ip ?? null,
        user_agent: (req.get("user-agent") ?? null)?.slice(0, 512) ?? null,
        impersonator_user_id: req.impersonatorUserId ?? null,
      };

      const onError = (err: unknown): void => {
        logger.error(
          {
            event: "patient_access_log_write_failed",
            action: descriptor.action,
            adminUserId,
            err,
          },
          "Failed to record patient access",
        );
      };

      // Fire-and-forget: trigger the PostgREST insert and handle either
      // a returned `{ error }` or a thrown/rejected promise.
      void getOrgScopedClient(orgId)
        .from("patient_access_log")
        .insert(row)
        .then((result: { error: unknown }) => {
          if (result.error) onError(result.error);
        }, onError);
    } catch (err) {
      logger.error(
        { event: "patient_access_log_write_failed", err },
        "Failed to record patient access (synchronous)",
      );
    }
  });
  next();
}
