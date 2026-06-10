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
  demoAutoSubmitRun,
  demoAutoSubmitStatus,
  demoDenialsWorklist,
  demoEligibilityRecent,
  demoEraFiles,
  demoPendingStatements,
  demoStatementBatchSend,
  demoStatementMailQueue,
  demoStatementSend,
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

  // The action buttons the seeded GETs enable. Each page derefs the
  // mutation response (result.failures.length, summary.scanned,
  // outcome.kind, marked), so the generic `{ ok: true }` mutation
  // fallback would crash the page the moment a visitor clicks the
  // very action the seed data invites them to try.
  route("POST", "/resupply-api/admin/billing/auto-submit/run", () =>
    json(demoAutoSubmitRun()),
  ),
  route("POST", "/resupply-api/admin/billing/statements/batch-send", () =>
    json(demoStatementBatchSend()),
  ),
  route("POST", "/resupply-api/admin/billing/statements/:id/send", () =>
    json(demoStatementSend()),
  ),
  route("POST", "/resupply-api/admin/billing/statements/mark-mailed", (req) => {
    const body = req.json<{ statementIds?: string[] }>() ?? {};
    return json({ marked: (body.statementIds ?? []).length });
  }),
];
