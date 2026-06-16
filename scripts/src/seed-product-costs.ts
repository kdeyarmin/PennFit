// seed-product-costs — bulk-load per-SKU unit cost (COGS) into
// resupply.product_costs from an operator-maintained CSV cost sheet.
// Closes the cost-capture foundation (migration 0193).
//
// Run with:
//   pnpm --filter @workspace/scripts run seed:product-costs -- <costs.csv> [--dry-run]
//
// CSV columns (header row optional): sku,unit_cost_cents,cost_source,notes
//   - unit_cost_cents : integer CENTS, not dollars (4200 = $42.00).
//   - cost_source     : manual|invoice|catalog|estimate (default catalog)
//   - notes           : free text (last column; may contain commas)
//
// Idempotent: upserts on the natural sku PK, so re-running updates costs
// in place. --dry-run parses + reports without writing (and needs no DB
// env). Per-row parse errors are printed and the bad rows skipped.
//
// Scope note: this seeds GOING-FORWARD cost only. Historic
// shop_order_items / insurance_claim_line_items rows whose SKU was not
// persisted stay "unknown" — the margin layer (computeMargin) surfaces
// that honestly via the costed/uncosted split rather than guessing.

import { readFileSync } from "node:fs";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { parseProductCostCsv } from "./product-cost-csv";

function fail(msg: string): never {
  process.stderr.write(`[seed:product-costs] ${msg}\n`);
  process.exit(1);
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const csvPath = args.find((a) => !a.startsWith("--"));
if (!csvPath) {
  fail("usage: seed:product-costs -- <path/to/costs.csv> [--dry-run]");
}

const { rows, errors } = parseProductCostCsv(readFileSafe(csvPath));
for (const e of errors) {
  process.stderr.write(`[seed:product-costs] line ${e.line}: ${e.message}\n`);
}
if (rows.length === 0) {
  fail(`no valid rows parsed (${errors.length} error(s)). Nothing to do.`);
}
process.stdout.write(
  `[seed:product-costs] parsed ${rows.length} valid row(s), ${errors.length} error(s).\n`,
);

if (dryRun) {
  for (const r of rows) {
    process.stdout.write(`  ${r.sku}\t${r.unitCostCents}\t${r.costSource}\n`);
  }
  process.stdout.write("[seed:product-costs] --dry-run: no writes.\n");
  process.exit(errors.length > 0 ? 1 : 0);
}

// product_costs is per-tenant since migration 0357 (composite PK
// (org_id, sku)). This operator bulk-load seeds the SEED tenant's cost
// sheet; the org-scoped client injects org_id and the conflict target
// must include it. Onboarding a second tenant's costs is a future
// per-tenant flag on this script.
const seedOrgId = await resolveSeedOrgId();
if (!seedOrgId) {
  fail("could not resolve the seed org — is the organizations table seeded?");
}
const supabase = getOrgScopedClient(seedOrgId);
const nowIso = new Date().toISOString();
let written = 0;
for (const r of rows) {
  const { error } = await supabase.from("product_costs").upsert(
    {
      sku: r.sku,
      unit_cost_cents: r.unitCostCents,
      currency: "usd",
      cost_source: r.costSource,
      notes: r.notes,
      effective_from: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "org_id,sku" },
  );
  if (error) {
    process.stderr.write(
      `[seed:product-costs] upsert failed for ${r.sku}: ${error.message}\n`,
    );
  } else {
    written += 1;
  }
}

process.stdout.write(
  `[seed:product-costs] upserted ${written}/${rows.length} row(s) into resupply.product_costs.\n`,
);
process.exit(written === rows.length && errors.length === 0 ? 0 : 1);
