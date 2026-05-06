import type { FastifyBaseLogger } from "fastify";

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
  logger: FastifyBaseLogger,
  metric: AdminOperationMetric,
): void {
  logger.info(metric, "admin operation metric");
}
