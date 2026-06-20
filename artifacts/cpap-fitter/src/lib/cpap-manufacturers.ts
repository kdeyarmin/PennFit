// Known CPAP/DME manufacturer & brand names for type-ahead on the
// free-text "manufacturer" inputs (shop products, patient equipment,
// device registration).
//
// Seeded from the canonical machine manufacturers in CPAP_DEVICE_CATALOG
// so the suggested spelling matches the values the parts-finder filter
// (`shop_product_compatibility`) keys off of, plus the common mask /
// accessory brands a DME catalog routinely carries. Arbitrary text is
// still accepted — this is a spelling/consistency aid, not a constraint.

import { CPAP_DEVICE_CATALOG } from "./cpap-devices";

// Mask / accessory brands not represented in the device catalog.
const ADDITIONAL_BRANDS = [
  "3B Medical",
  "BMC Medical",
  "Löwenstein Medical",
  "Sefam",
  "Circadiance",
  "Sunset Healthcare",
  "Drive DeVilbiss",
  "Breas",
] as const;

export const CPAP_MANUFACTURERS: string[] = Array.from(
  new Set([
    ...CPAP_DEVICE_CATALOG.map((d) => d.manufacturer),
    ...ADDITIONAL_BRANDS,
  ]),
).sort((a, b) => a.localeCompare(b));
