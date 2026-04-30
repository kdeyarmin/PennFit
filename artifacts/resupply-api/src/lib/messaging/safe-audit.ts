// Helper: never let an audit-write failure bubble up past a successful
// (or already-failed) downstream response. Audit writes are best-effort
// from the caller's POV — there is a separate alert path for "audit
// writes are silently failing", and surfacing the failure to a Twilio
// or SendGrid webhook would just make those vendors retry their POST
// (which would re-double-audit the next time around).

import { logAudit } from "@workspace/resupply-audit";

import { logger } from "../logger";

export async function safeAudit(
  event: Parameters<typeof logAudit>[0],
  context?: string,
): Promise<void> {
  try {
    await logAudit(event);
  } catch (err) {
    logger.error(
      {
        event: "messaging_audit_failed",
        action: event.action,
        context: context ?? null,
        err: serializeErr(err),
      },
      "messaging: logAudit failed",
    );
  }
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}
