// Structural logger shape that matches both pino's `Logger` (the one
// resupply-api actually uses, see `src/lib/logger.ts`) and any
// drop-in replacement that exposes `info(obj, msg?)`. The original
// version of this file imported `FastifyBaseLogger` from `fastify`,
// which isn't a workspace dependency — Express is. Keeping the type
// inline here removes the broken import without forcing a refactor
// of the (currently unused) admin-observability scaffolding.
interface AdminLogger {
  info(obj: unknown, msg?: string): void;
}

export interface AdminOperationMetric {
  event: "admin_operation";
  operation: string;
  actorUserId?: string;
  requestId?: string;
  latencyMs: number;
  ok: boolean;
  errorCode?: string;
}

export function logAdminOperation(
  logger: AdminLogger,
  metric: AdminOperationMetric,
): void {
  logger.info(metric, "admin operation metric");
}
