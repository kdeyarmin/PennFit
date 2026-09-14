import { createHash } from "node:crypto";
import { z } from "zod";
import type { Json } from "@workspace/resupply-db";

const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(2).max(50),
  zip: z.string().trim().min(3).max(20),
  country: z.string().trim().length(2).nullish(),
});

export function pricingShippingAddress(raw: Json | null) {
  const address =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  // PacWare imports predate the carrier form and store postalCode. Normalize
  // only for rate/scope calculations; the saved snapshot remains untouched.
  const parsed = addressSchema.safeParse({
    ...address,
    zip:
      typeof address?.zip === "string" && address.zip.trim()
        ? address.zip
        : address?.postalCode,
  });
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    name: "Shipping quote",
    address1: a.line1,
    address2: a.line2 ?? null,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country ?? "US",
  };
}

/** Private quote provenance; the original snapshot is compared again before use. */
export function pricingDestinationFingerprint(raw: Json | null): string {
  return createHash("sha256")
    .update(JSON.stringify(pricingShippingAddress(raw)))
    .digest("hex");
}
