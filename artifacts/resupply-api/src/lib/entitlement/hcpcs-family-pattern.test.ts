import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findSkuHcpcsMapping,
  hcpcsFamilyPattern,
} from "./resolve-sku-entitlement";

const mappings = [
  { sku_prefix: "MASK", hcpcs_code: "A7034" },
  { sku_prefix: "MASK-FULL", hcpcs_code: "A7030" },
  { sku_prefix: "MASK-FULL-NASAL", hcpcs_code: "A7034" },
  { sku_prefix: "NASAL-INTERFACE", hcpcs_code: "A7034" },
  { sku_prefix: "MASK-FULL-NASAL-PART", hcpcs_code: "A7032" },
  { sku_prefix: "CUSHION_(M)+.50%\\[X]", hcpcs_code: "A7032" },
];
const samples = [
  "MASK",
  "MASK-M",
  "MASK-FULL-L",
  "MASK-FULL-NASAL-M",
  "MASK-FULL-NASAL-PART-M",
  "NASAL-INTERFACE-S",
  "FILTER-DISP",
  "CUSHION_(M)+.50%\\[X]-L",
  "CUSHION_AMMMMM50XXX-X",
];
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
}, 20_000);
afterAll(async () => {
  await db?.close();
});

describe("HCPCS family filtering in PostgreSQL", () => {
  it.each(["A7034", "A7030", "A7032", "UNMAPPED"])(
    "matches the longest-prefix classifier for %s, including nested aliases and literal punctuation",
    async (code) => {
      const result = await db.query<{ sku: string }>(
        "SELECT sku FROM unnest($1::text[]) AS samples(sku) WHERE sku ~ $2 ORDER BY sku",
        [samples, hcpcsFamilyPattern(code, mappings)],
      );
      expect(result.rows.map((row) => row.sku).sort()).toEqual(
        samples
          .filter(
            (sku) => findSkuHcpcsMapping(sku, mappings)?.hcpcs_code === code,
          )
          .sort(),
      );
    },
  );
});
