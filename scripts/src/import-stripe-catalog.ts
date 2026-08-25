// import-stripe-catalog — one-time migration of a tenant's Stripe product
// catalog into `resupply.products`.
//
// WHY
//   The catalog used to BE Stripe: each SKU was a Stripe Product and its
//   on-hand count lived in `metadata.stock_count`. Migration 0520 moved
//   both into Postgres, but schema alone deploys an EMPTY catalog — every
//   tenant would lose its visible SKU registry and stock balances, queued
//   fulfillments would hit the un-catalogued fail-soft path and stop
//   decrementing, and low-stock monitoring would report nothing. This
//   copies the live Stripe catalog across so the cutover is continuous.
//
// Run with:
//   pnpm --filter @workspace/scripts run import:catalog -- --org=<uuid>
//   pnpm --filter @workspace/scripts run import:catalog -- --org=<uuid> --dry-run
//
// Reads STRIPE_SECRET_KEY (the legacy patient/storefront account) plus the
// usual SUPABASE_* runtime credentials.
//
// IDEMPOTENT. Keyed on `(org_id, sku)`: re-running updates the descriptive
// fields of a SKU that already exists and never duplicates it.
//
// STOCK IS SET ONLY ON FIRST IMPORT. On a re-run an existing SKU's
// stock_count is left ALONE — by then Postgres is the source of truth and
// movements have been ledgered against it, so copying a now-stale Stripe
// number over the top would silently contradict that history. Use the
// Catalog page to correct a count.

import Stripe from "stripe";

import { getOrgScopedClient } from "@workspace/resupply-db";

interface Args {
  orgId: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let orgId = "";
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith("--org=")) orgId = a.slice("--org=".length).trim();
    else if (a === "--dry-run") dryRun = true;
  }
  if (!orgId) {
    throw new Error("Usage: import:catalog -- --org=<tenant uuid> [--dry-run]");
  }
  return { orgId, dryRun };
}

/** Non-negative int or null. Mirrors the old products-meta parsers. */
function parseCount(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 1_000_000);
}

interface ImportRow {
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  manufacturer: string | null;
  model_number: string | null;
  stock_count: number | null;
  low_stock_threshold: number | null;
  active: boolean;
}

export function projectStripeProduct(p: Stripe.Product): ImportRow | null {
  const meta = (p.metadata ?? {}) as Record<string, string | undefined>;
  // `shop_sku` is the stable warehouse identifier the seed script wrote and
  // the rest of the system joins on (fulfillments.item_sku,
  // product_hcpcs_map, shop_backorders). A product without one was never a
  // real catalog SKU, so fall back to the Stripe id rather than dropping
  // it — an operator can rename it, but silently losing a row is worse.
  const sku = meta.shop_sku?.trim() || p.id;
  if (!sku) return null;
  return {
    sku,
    name: p.name,
    description: p.description ?? null,
    category: meta.category?.trim() || null,
    manufacturer: meta.manufacturer?.trim() || null,
    model_number: meta.model_number?.trim() || null,
    stock_count: parseCount(meta.stock_count),
    low_stock_threshold: parseCount(meta.low_stock_threshold),
    // Archived Stripe products come across INACTIVE rather than being
    // skipped: a backorder or substitution rule can still reference one.
    active: p.active,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set — nothing to import from. Point it at " +
        "the account that held the storefront catalog.",
    );
  }
  const stripe = new Stripe(secretKey, { typescript: true });

  // Page the whole catalog, active AND archived. Bounded at 50 pages
  // (5000 products) as defense-in-depth against an unbounded loop.
  const rows: ImportRow[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 50; page++) {
    const list: Stripe.ApiList<Stripe.Product> = await stripe.products.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const p of list.data) {
      const row = projectStripeProduct(p);
      if (row) rows.push(row);
    }
    if (!list.has_more || list.data.length === 0) break;
    startingAfter = list.data[list.data.length - 1]!.id;
  }

  console.log(`[import-stripe-catalog] read ${rows.length} product(s)`);
  if (args.dryRun) {
    for (const r of rows) {
      console.log(
        `  ${r.sku.padEnd(24)} ${r.active ? " " : "(archived) "}${r.name}` +
          ` — stock ${r.stock_count ?? "untracked"}`,
      );
    }
    console.log("[import-stripe-catalog] dry run — nothing written");
    return;
  }

  const db = getOrgScopedClient(args.orgId);
  const { data: existingRows, error: readErr } = await db
    .from("products")
    .select("sku");
  if (readErr) throw readErr;
  const existing = new Set(
    ((existingRows ?? []) as { sku: string }[]).map((r) => r.sku),
  );

  let created = 0;
  let updated = 0;
  for (const r of rows) {
    if (existing.has(r.sku)) {
      // Descriptive fields only — see the stock note in the header.
      const { sku, stock_count: _stock, ...fields } = r;
      const { error } = await db
        .from("products")
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq("sku", sku);
      if (error) throw error;
      updated += 1;
    } else {
      const { error } = await db.from("products").insert(r);
      if (error) throw error;
      created += 1;
    }
  }

  console.log(
    `[import-stripe-catalog] created ${created}, updated ${updated}` +
      ` (org ${args.orgId})`,
  );
}

main().catch((err: unknown) => {
  console.error(
    "[import-stripe-catalog]",
    err instanceof Error ? err.message : err,
  );
  process.exitCode = 1;
});
