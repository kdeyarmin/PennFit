// Audit-log fixture factory.
//
// Produces an `AuditEvent` payload (the public input to
// `logAudit()` from `@workspace/resupply-audit`), NOT a Drizzle
// `PgInsertValue<typeof auditLog>`. Every audit-log INSERT must
// flow through the helper so the metadata sanitizer (PHI denylist
// + size + depth caps) cannot be bypassed; producing the helper's
// input type rather than Drizzle's row type makes the supported
// usage obvious:
//
//     await logAudit(makeAuditLog({ action: "patient.view" }));
//
// (See architecture-check Rule 8 in
// `scripts/check-resupply-architecture.sh` for the matching ban
// on direct Drizzle audit-log inserts outside the helper.)
//
// `targetTable` and `targetId` are deliberately defaulted as a
// pair to a patients-shaped row — most realistic audit verbs touch
// patients, so most fixtures want that default. Pass either field
// explicitly (including `null`) to override; the
// `undefined`-vs-key-present distinction is preserved so callers
// can write `targetId: null` to assert the schema's nullable
// column.
import { faker } from "@faker-js/faker";
import type { AuditEvent } from "@workspace/resupply-audit";

export interface AuditLogFixtureSpec {
  operatorEmail: string | null;
  operatorClerkId: string | null;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}

export function makeAuditLog(
  overrides: Partial<AuditLogFixtureSpec> = {},
): AuditEvent {
  return {
    operatorEmail:
      overrides.operatorEmail === undefined
        ? faker.internet.email().toLowerCase()
        : overrides.operatorEmail,
    operatorClerkId:
      overrides.operatorClerkId === undefined
        ? `user_${faker.string.alphanumeric({ length: 24, casing: "lower" })}`
        : overrides.operatorClerkId,
    action: overrides.action ?? "patient.view",
    targetTable:
      overrides.targetTable === undefined ? "patients" : overrides.targetTable,
    targetId:
      overrides.targetId === undefined
        ? faker.string.uuid()
        : overrides.targetId,
    // Per audit-log.ts schema comment: NEVER PHI. Default metadata is
    // intentionally request-shaped, not patient-shaped — and the
    // sanitizer in @workspace/resupply-audit will throw on any
    // PHI-shaped key here as a backstop.
    metadata:
      overrides.metadata ??
      {
        requestId: faker.string.uuid(),
        filters: {},
      },
    ip: overrides.ip === undefined ? faker.internet.ipv4() : overrides.ip,
    userAgent:
      overrides.userAgent === undefined
        ? faker.internet.userAgent()
        : overrides.userAgent,
  };
}
