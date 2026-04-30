// Shared audit writer used by sendReminderSms / sendReminderEmail.
//
// Two responsibilities:
//   1. Translate the SendActor union into the adminEmail /
//      adminUserId / ip / userAgent fields logAudit expects.
//   2. Append `actor_kind` (and `job_id` for system runs) to the
//      structural metadata so downstream queries can filter
//      admin-initiated vs scheduled reminders without parsing
//      the timeline.
//
// Audit-write failures are swallowed here because:
//   - Twilio / SendGrid retry on any 5xx, which would multi-audit if
//     we surfaced the error to the route.
//   - There is a separate alert path on the audit_log write rate that
//     fires when this branch is exercised (see ADR 008).

import { logAudit } from "@workspace/resupply-audit";

import type { SendActor } from "./types";

export interface SafeAuditInput {
  action: string;
  actor: SendActor;
  /**
   * Both `targetTable` and `targetId` mirror `logAudit`'s nullable
   * shape. Most messaging audits point at a concrete row (a
   * `conversations` row, an `episodes` row, …) but a small number
   * are structural-only — e.g. `messaging.phone_lookup.conflict`
   * where the audit announces a data-quality issue rather than
   * mutating any single row. Allowing `null` here keeps those
   * structural audits expressible without a placeholder UUID.
   */
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export async function safeAuditFromActor(
  input: SafeAuditInput,
): Promise<void> {
  const adminEmail =
    input.actor.kind === "admin" ? input.actor.adminEmail : null;
  const adminUserId =
    input.actor.kind === "admin" ? input.actor.adminUserId : null;
  const ip = input.actor.kind === "admin" ? input.actor.ip : null;
  const userAgent =
    input.actor.kind === "admin" ? input.actor.userAgent : null;
  const metadata =
    input.actor.kind === "system"
      ? {
          ...input.metadata,
          actor_kind: "system",
          job_id: input.actor.jobId,
        }
      : { ...input.metadata, actor_kind: "admin" };
  try {
    await logAudit({
      action: input.action,
      adminEmail,
      adminUserId,
      targetTable: input.targetTable,
      targetId: input.targetId,
      metadata,
      ip,
      userAgent,
    });
  } catch {
    // See ADR 008 — caller has a separate alert path for missed audits.
  }
}
