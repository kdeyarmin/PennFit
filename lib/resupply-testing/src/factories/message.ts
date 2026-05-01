import { faker } from "@faker-js/faker";
import { messages, type InsertMessageRow } from "@workspace/resupply-db";

export interface MessageFixtureSpec {
  direction: "inbound" | "outbound";
  senderRole: "patient" | "admin" | "agent" | "system";
  /** Plaintext body — written verbatim into messages.body. */
  body: string;
  deliveryStatus: string | null;
  deliveryError: string | null;
  vendorMetadata: Record<string, unknown>;
  sentAt: Date | null;
  deliveredAt: Date | null;
}

void messages;

export function makeMessage(
  args: { conversationId: string } & Partial<MessageFixtureSpec>,
): InsertMessageRow {
  const {
    conversationId,
    direction,
    senderRole,
    body,
    deliveryStatus,
    deliveryError,
    vendorMetadata,
    sentAt,
    deliveredAt,
  } = args;

  const resolvedDirection = direction ?? "outbound";
  const resolvedSenderRole =
    senderRole ?? (resolvedDirection === "inbound" ? "patient" : "agent");

  return {
    conversationId,
    direction: resolvedDirection,
    senderRole: resolvedSenderRole,
    body: body ?? faker.lorem.sentence(),
    deliveryStatus:
      deliveryStatus === undefined
        ? resolvedDirection === "outbound"
          ? "delivered"
          : null
        : deliveryStatus,
    deliveryError: deliveryError === undefined ? null : deliveryError,
    vendorMetadata:
      vendorMetadata ??
      (resolvedDirection === "outbound"
        ? {
            sid: `SM${faker.string.alphanumeric({ length: 32, casing: "lower" })}`,
            segments: 1,
          }
        : {}),
    sentAt: sentAt === undefined ? new Date() : sentAt,
    deliveredAt:
      deliveredAt === undefined && resolvedDirection === "outbound"
        ? new Date()
        : deliveredAt === undefined
          ? null
          : deliveredAt,
  };
}
