# XPS Ship shipping-label integration

XPS Ship (`xpsshipper.com`) is a multi-carrier shipping-label platform
widely used by DME suppliers. This integration lets staff create shipping
labels **with the patient's address merged in automatically** — no
re-keying into XPS's Webship UI — rate-shop carriers, print the label,
and have tracking auto-fill on the order.

It is **optional and per-tenant**: each DME brings its own XPS account.
When the credentials are unset the feature stays dormant and orders can
still be shipped by entering tracking manually (the existing
`POST /admin/shop/orders/:id/tracking` flow).

## How XPS's API works (and why the flow looks the way it does)

XPS's eCommerce REST API is a **stage-then-process** model. There is no
single "buy this label" call:

1. **Put Order** stages an order in XPS carrying the merged
   patient/address/parcel data and the chosen service.
2. XPS turns the staged order into a **booked shipment** (with a
   `bookNumber`, tracking number, and printable label) — via the
   operator's Webship rules or auto-processing.
3. We **resolve** the booked shipment by searching for our order id
   (Search Shipments), then **Retrieve Shipment** (tracking/carrier/cost)
   and **Retrieve Shipping Label** (the PDF bytes).

Auto-processing usually books within a second or two, so the create-label
endpoint stages the order and then polls a couple of times to resolve it
immediately. If XPS hasn't booked it yet, the order is left in the
`staged` state and the UI offers a **Sync** action (and the
`/sync` endpoint) to resolve it later.

## Architecture

| Layer                                      | Location                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter (HTTP client, error normalisation) | `lib/resupply-integrations-xps-ship`                                                                                                         |
| API routes                                 | `artifacts/resupply-api/src/routes/admin/xps-shipping.ts`                                                                                    |
| DB columns                                 | migration `0404_shop_orders_xps_shipping.sql` (`xps_book_number`, `xps_label_status`, `shipping_service_code`; reuses `shipping_cost_cents`) |
| Admin UI                                   | `artifacts/cpap-fitter/src/pages/admin/admin-shipping.tsx` (`/admin/shipping`)                                                               |
| Config catalog                             | `CATEGORY_XPS_SHIP` in `app-config/catalog.ts` (tenant-scoped)                                                                               |

Like the other outbound integrations (Office Ally, DaVinci PAS), the
adapter is **imported directly by the route layer** (no registry entry),
reads its config from `getEffectiveEnvForOrg(orgId)` at **call** time
(credential rotation honoured without a restart), and **never imports the
data layer** — persistence + audit live in the route.

## Endpoints

All under `requirePermission("returns.manage")`:

- `GET  /admin/shipping/xps/status` — adapter availability.
- `GET  /admin/shipping/xps/queue` — paid, ship-method, unshipped orders.
- `POST /admin/shop/orders/:id/shipping/rates` — rate-shop carriers.
- `POST /admin/shop/orders/:id/shipping/label` — stage + resolve + book.
  On a booked shipment it stamps `shipped_at` + tracking and fires the
  existing patient shipping notification (email/SMS/push), exactly like
  the manual tracking flow. Enforces the same signed-paperwork gate.
- `POST /admin/shop/orders/:id/shipping/sync` — resolve a staged order.
- `GET  /admin/shop/orders/:id/shipping/label.pdf` — stream the label PDF
  (`Cache-Control: no-store` — the label carries PHI).
- `POST /admin/shop/orders/:id/shipping/void` — cancel a staged label.

## Configuration

Set these under **Admin → System Configuration → "Shipping labels (XPS
Ship)"** (or as env vars). The integration activates once the API key,
customer id, integration id, and a ship-from address (name, line 1, city,
state, zip) are all present.

| Key                       | Purpose                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `XPS_SHIP_API_KEY`        | REST API key (sent as `Authorization: RSIS <key>`).                   |
| `XPS_SHIP_CUSTOMER_ID`    | XPS customer id (the `:customerId` URL segment).                      |
| `XPS_SHIP_INTEGRATION_ID` | REST API integration id (Put-Order segment).                          |
| `XPS_SHIP_API_BASE_URL`   | Override the REST base (default `https://xpsshipper.com/restapi/v1`). |
| `XPS_SHIP_LABEL_FORMAT`   | `PDF` (default) or `PNG`.                                             |
| `XPS_SHIP_FROM_*`         | Ship-from / return-to address printed on every label.                 |

Generate the API key + integration id in **XPS Webship → Settings → API**.

## PHI posture

The label's purpose is to carry the patient's name + address, so those
flow to XPS. We never log the address, the label bytes, or XPS response
bodies — only structural counts, order ids, and carrier codes. The label
PDF endpoint sets `Cache-Control: no-store`.

## Efficiency tooling

- **Batch labels** — select orders on the queue and `POST
/admin/shipping/xps/batch-label { orderIds, shippingService }` stages +
  resolves them all, parcel auto-computed from per-product presets.
- **Background auto-resolve** — the `xps.resolve-staged` pg-boss cron
  (every 5 min, opt-in via `XPS_RESOLVE_STAGED_CRON_ENABLED=1`) resolves
  `staged` orders so tracking + the patient notification land without
  anyone clicking Sync. Per-tenant + fail-soft (unconfigured tenants do no
  work).
- **Per-product parcel presets** — `product_ship_specs` (migration 0405)
  stores a weight (oz) + optional dimensions per Stripe product id. The
  create-label form and the batch path pre-fill the parcel by summing each
  order line's preset × quantity (`computeParcelForOrder`); missing presets
  fall back to `XPS_SHIP_DEFAULT_WEIGHT_OZ` (default 16 oz). Managed inline
  on the Shipping page (`GET`/`PUT /admin/shipping/xps/product-specs`).
- **Pre-book address validation** — `validateReceiverAddress` (pure, in the
  integration package) structurally checks the destination (required
  fields, 2-letter state, US ZIP) before staging; the queue flags
  questionable addresses and the label/batch paths return `invalid_address`
  with per-field issues rather than failing at XPS. Carrier-side existence
  is still validated by XPS at quote/book time.
