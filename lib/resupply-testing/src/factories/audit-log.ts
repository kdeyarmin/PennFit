import { faker } from "@faker-js/faker";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { auditLog } from "@workspace/resupply-db";

type AuditLogInsertValue = PgInsertValue<typeof auditLog>;

export interface AuditLogFixtureSpec {
  operatorEmail: string | null;
  operatorClerkId: string | null;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  occurredAt: Date;
}

export function makeAuditLog(
  overrides: Partial<AuditLogFixtureSpec> = {},
): AuditLogInsertValue {
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
    // intentionally request-shaped, not patient-shaped.
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
    occurredAt: overrides.occurredAt ?? new Date(),
  };
}
