// Claims-workflow handlers — the pages PennPilot's "process a claim
// end to end" answer deep-links: Eligibility, Auto-submit, ERA files,
// Denials worklist (plus Statement send, same family). Without these
// the router's empty-object GET fallback crashes each page into the
// admin error boundary, so the very workflow the assistant pitches was
// unexplorable in demo mode.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoAutoSubmitReady,
  demoAutoSubmitStatus,
  demoDenialsWorklist,
  demoEligibilityRecent,
  demoEraFiles,
  demoPendingStatements,
  demoStatementMailQueue,
} from "../fixtures/billing-claims";

export const billingClaimsHandlers: DemoHandler[] = [
  route("GET", "/resupply-api/admin/billing/eligibility-recent", (req) =>
    json(demoEligibilityRecent(req.query.get("status"))),
  ),
  route("GET", "/resupply-api/admin/billing/era-files", () =>
    json(demoEraFiles()),
  ),
  route("GET", "/resupply-api/admin/billing/denials-worklist", () =>
    json(demoDenialsWorklist()),
  ),
  route("GET", "/resupply-api/admin/billing/auto-submit/ready", () =>
    json(demoAutoSubmitReady()),
  ),
  route("GET", "/resupply-api/admin/billing/auto-submit/status", () =>
    json(demoAutoSubmitStatus()),
  ),
  route("GET", "/resupply-api/admin/billing/statements/pending", () =>
    json(demoPendingStatements()),
  ),
  route("GET", "/resupply-api/admin/billing/statements/mail-queue", () =>
    json(demoStatementMailQueue()),
  ),
];
