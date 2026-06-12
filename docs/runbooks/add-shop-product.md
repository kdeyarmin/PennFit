# Runbook: add a new item to the storefront

Audience: operators / admins. Goal: get a new product live on the
public shop (`/shop`) and purchasable through checkout, end to end.

There are two supported paths. The admin console is the everyday one;
the seed script is for bulk/initial catalog work.

## Path 1 — Admin console (recommended)

1. Sign in at `/admin/sign-in` with an account that has the
   `admin.tools.manage` permission (supervisor tier or above).
2. Go to **Shop → Inventory** (`/admin/shop/inventory`) and click
   **+ Add product** (`/admin/shop/product/new`).
3. Fill in the form:
   - **SKU** — lowercase letters/digits/hyphens, unique, permanent
     (e.g. `rm-mask-airfit-f20-medium`). Re-using an existing SKU is
     rejected with a link to edit the existing product.
   - **Name, description, category, price** — required. Price is in
     dollars; Stripe's minimum is $0.50.
   - **Product photo** — pick a PNG/JPEG/WebP file (≤ 5 MB). It
     uploads to the public Supabase Storage bucket and fills the
     Image URL field automatically, with a preview. If the
     environment has no public bucket (see prerequisites below), the
     uploader says so — paste an already-hosted HTTPS URL instead.
   - Optional: tagline, replacement hint, manufacturer, model number,
     initial stock count, low-stock threshold, bundle contents (for
     `bundle` category), and a Subscribe & Save cadence.
4. Click **Create product**. This creates the Stripe Product + Price
   (and the optional recurring Price) and returns you to the
   inventory list.
5. The storefront picks the product up within 60 seconds (the public
   catalog has a 60s in-process cache). Verify it renders on `/shop`
   under its category, then add it to the cart and confirm the Stripe
   Checkout page opens.

Later edits — price, stock count, low-stock threshold — are inline on
`/admin/shop/inventory`. Catalog copy — name, description, tagline,
replacement hint, manufacturer, model number, photo — is edited via
each row's **Edit details** link (`/admin/shop/inventory/<id>/edit`).
SKU and category are fixed (archive and re-create to change them).
Everything can also be edited directly in the Stripe Dashboard;
Stripe is the single source of truth for the catalog and both edit
paths produce the same storefront result.

## Path 2 — Seed script (bulk / initial catalog)

Append an entry to the `PRODUCTS` array in
`scripts/src/seed-stripe-products.ts` (same fields as the form) and
run:

```bash
pnpm --filter @workspace/scripts run seed:shop
```

The script is idempotent on `metadata.shop_sku`: re-running updates
existing products instead of duplicating them. Image paths are
relative to the cpap-fitter `public/` directory and resolved against
`SHOP_PUBLIC_BASE_URL`.

## Retiring an item

Open the product's **Edit details** page and use **Archive product**
(bottom of the page; requires the admin role — agents can add and
edit but not retire). This archives the product in Stripe: it leaves
the storefront within seconds, in-flight carts holding it are
rejected at checkout validation, order history is unaffected, and
existing subscriptions keep billing. To bring it back, open
**View archived** on the inventory page
(`/admin/shop/inventory/archived`) and click **Restore** — the
product returns to the storefront with its previous price, stock,
and photo (re-activating in the Stripe Dashboard or re-running the
seed script also works). Do **not** re-create the SKU through the
admin "Add product" form: its duplicate check only looks at active
products, so it would create a second Stripe product with the same
SKU instead of restoring the original. The in-app Restore guards
against the inverse case too — it refuses (409) when an active
product already carries the SKU.

## Prerequisites (one-time, per environment)

- `STRIPE_SECRET_KEY` set — without it the shop serves the built-in
  preview catalog and all catalog mutations 503.
- The `storefront.checkout` feature flag enabled in the admin Control
  Center — products render without it, but the cart/checkout CTA is
  disabled.
- `STRIPE_WEBHOOK_SECRET` set and the webhook endpoint
  (`/resupply-api/stripe/webhook`) registered in Stripe — this is
  what records paid orders (`shop_orders` / `shop_order_items`) and
  sends the confirmation email after checkout.
- For in-form photo uploads: `SUPABASE_STORAGE_BUCKET_PUBLIC` set to
  the name of a **public** bucket created in Supabase Studio →
  Storage. Without it, the form still works — paste a hosted HTTPS
  image URL instead.

## How it hangs together (for the curious)

Stripe is the catalog's single source of truth — there is no products
table. `GET /shop/products` lists active Stripe Products (60s cache);
checkout creates a Stripe Hosted Checkout session; the webhook mirrors
paid sessions into `shop_orders`/`shop_order_items`. Catalog fields
like category, stock count, and bundle contents live in Stripe product
metadata (see `artifacts/resupply-api/src/lib/stripe/products-meta.ts`).
The admin endpoints are in
`artifacts/resupply-api/src/routes/admin/shop-products.ts`.
