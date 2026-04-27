import { faker } from "@faker-js/faker";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { conversations } from "@workspace/resupply-db";

type ConversationInsertValue = PgInsertValue<typeof conversations>;

export interface ConversationFixtureSpec {
  channel: "sms" | "voice" | "email";
  status: "open" | "awaiting_patient" | "awaiting_operator" | "closed";
  externalRef: string | null;
  lastMessageAt: Date | null;
}

export function makeConversation(
  args: {
    patientId: string;
    episodeId: string;
  } & Partial<ConversationFixtureSpec>,
): ConversationInsertValue {
  const { patientId, episodeId, channel, status, externalRef, lastMessageAt } =
    args;

  const resolvedChannel = channel ?? "sms";

  return {
    patientId,
    episodeId,
    channel: resolvedChannel,
    status: status ?? "open",
    externalRef:
      externalRef === undefined
        ? // Vendor-side handle shape varies by channel — Twilio
          // conversation SIDs start with `CH`, SendGrid thread IDs are
          // opaque hex. Both are operationally indistinguishable to
          // tests, so we just produce something representative.
          resolvedChannel === "sms"
          ? `CH${faker.string.alphanumeric({ length: 32, casing: "lower" })}`
          : faker.string.uuid()
        : externalRef,
    lastMessageAt:
      lastMessageAt === undefined ? new Date() : lastMessageAt,
  };
}
