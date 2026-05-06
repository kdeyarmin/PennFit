export type ConversionEventName =
  | "reorder_clicked"
  | "reorder_quote_loaded"
  | "reorder_checkout_started"
  | "reorder_paid"
  | "reorder_failed";

export interface ConversionEvent {
  eventName: ConversionEventName;
  sessionId: string;
  route: string;
  occurredAt: string;
  correlationId?: string;
  userId?: string;
  orderId?: string;
  skuIds?: string[];
  errorCode?: string;
  latencyMs?: number;
}

export function createConversionEvent(
  input: Omit<ConversionEvent, "occurredAt">,
): ConversionEvent {
  return {
    ...input,
    occurredAt: new Date().toISOString(),
  };
}
