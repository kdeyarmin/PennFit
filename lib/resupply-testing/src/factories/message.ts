import { faker } from "@faker-js/faker";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { encrypt, messages } from "@workspace/resupply-db";

type MessageInsertValue = PgInsertValue<typeof messages>;

export interface MessageFixtureSpec {
  direction: "inbound" | "outbound";
  senderRole: "patient" | "operator" | "agent" | "system";
  /** Plaintext body — the factory wraps it in encrypt(). */
  body: string;
  deliveryStatus: string | null;
  deliveryError: string | null;
  vendorMetadata: Record<string, unknown>;
  sentAt: Date | null;
  deliveredAt: Date | null;
}

export function makeMessage(
  args: { conversationId: string } & Partial<MessageFixtureSpec>,
): MessageInsertValue {
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
    body: encrypt(body ?? faker.lorem.sentence()),
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
