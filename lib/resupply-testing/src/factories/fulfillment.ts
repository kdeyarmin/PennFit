import { faker } from "@faker-js/faker";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { fulfillments } from "@workspace/resupply-db";

type FulfillmentInsertValue = PgInsertValue<typeof fulfillments>;

export interface FulfillmentFixtureSpec {
  itemSku: string;
  /** Stored as text in the schema — kept stringy for round-trip fidelity. */
  quantity: string;
  status:
    | "queued"
    | "submitted_to_pacware"
    | "in_fulfillment"
    | "shipped"
    | "delivered"
    | "canceled"
    | "failed";
  pacwareOrderRef: string | null;
  shipmentMetadata: Record<string, unknown>;
  submittedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
}

export function makeFulfillment(
  args: {
    patientId: string;
    episodeId: string;
  } & Partial<FulfillmentFixtureSpec>,
): FulfillmentInsertValue {
  const {
    patientId,
    episodeId,
    itemSku,
    quantity,
    status,
    pacwareOrderRef,
    shipmentMetadata,
    submittedAt,
    shippedAt,
    deliveredAt,
  } = args;

  return {
    patientId,
    episodeId,
    itemSku: itemSku ?? "MASK-NASAL-MED",
    quantity: quantity ?? "1",
    status: status ?? "queued",
    pacwareOrderRef:
      pacwareOrderRef === undefined
        ? `PW-${faker.string.alphanumeric({ length: 10, casing: "upper" })}`
        : pacwareOrderRef,
    shipmentMetadata:
      shipmentMetadata ??
      {
        carrier: "USPS",
        trackingNumber: faker.string.numeric(20),
      },
    submittedAt: submittedAt === undefined ? null : submittedAt,
    shippedAt: shippedAt === undefined ? null : shippedAt,
    deliveredAt: deliveredAt === undefined ? null : deliveredAt,
  };
}
