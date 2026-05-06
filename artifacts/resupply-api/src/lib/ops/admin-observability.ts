import type { Logger } from "pino";

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
  logger: Logger,
  metric: AdminOperationMetric,
): void {
  logger.info(metric, "admin operation metric");
}
