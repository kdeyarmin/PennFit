/**
 * Legacy storefront admin-user routes.
 *
 * Staff management now lives at the tenant-scoped
 * `/resupply-api/admin/team` surface. The old `/api/admin/users/*` API
 * operated directly on global auth rows and cannot be made safe for
 * multi-tenant deployments without duplicating the newer team router.
 */

import { Router } from "express";

import { requireAdminOnly } from "../../middlewares/requireAdmin.js";

const router = Router();

function legacyTeamApiDisabledResponse() {
  return {
    error: "legacy_team_api_disabled",
    message: "Use /resupply-api/admin/team for staff management.",
  };
}

router.all("/admin/users", requireAdminOnly, (_req, res) => {
  res.status(410).json(legacyTeamApiDisabledResponse());
});

router.all(/^\/admin\/users\/.+$/, requireAdminOnly, (_req, res) => {
  res.status(410).json(legacyTeamApiDisabledResponse());
});

export default router;
