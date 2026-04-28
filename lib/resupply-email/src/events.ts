// @workspace/resupply-email — SendGrid Event Webhook payload parsing.
//
// SendGrid POSTs a JSON ARRAY of event objects (batched) to the webhook
// endpoint. We model only the fields we currently react to. Unknown
// fields pass through untouched — SendGrid sometimes adds new fields
// to existing event types and we don't want a parse error to drop a
// whole batch over an unmodelled column.

import { z } from "zod";

/**
 * Event-type enum. SendGrid emits a long list (processed, deferred,
 * delivered, open, click, bounce, dropped, spamreport, unsubscribe,
 * group_unsubscribe, group_resubscribe). The audit handler treats
 * anything outside this list as `other` and logs it without acting.
 */
export const SENDGRID_HANDLED_EVENTS = [
  "processed",
  "delivered",
  "deferred",
  "bounce",
  "dropped",
  "spamreport",
  "unsubscribe",
] as const;

export type SendgridHandledEvent = (typeof SENDGRID_HANDLED_EVENTS)[number];

export const sendgridEventSchema = z
  .object({
    email: z.string().optional(),
    timestamp: z.number().optional(),
    event: z.string(),
    sg_message_id: z.string().optional(),
    sg_event_id: z.string().optional(),
    reason: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    /**
     * SendGrid echoes the customArgs we set on send. We use this to
     * carry conversationId + outboundMessageId through the bounce.
     */
    conversation_id: z.string().optional(),
    outbound_message_id: z.string().optional(),
  })
  .passthrough();

export type SendgridEvent = z.infer<typeof sendgridEventSchema>;

export const sendgridEventBatchSchema = z.array(sendgridEventSchema);

export type SendgridEventBatch = z.infer<typeof sendgridEventBatchSchema>;

export function parseSendgridEventBatch(raw: unknown): SendgridEventBatch {
  return sendgridEventBatchSchema.parse(raw);
}
