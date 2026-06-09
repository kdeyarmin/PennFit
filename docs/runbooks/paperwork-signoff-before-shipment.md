# Runbook: require signed paperwork before shipment

A verification stop that blocks a patient-linked order from being marked
**shipped** until the patient's required intake paperwork is signed and on
file. The requirement can be turned on **globally** or **per payer**.

## What "required paperwork" means

The same three intake forms the dispense-readiness reviewer already treats
as required-before-dispense, read from `resupply.patient_form_acknowledgements`
(any `form_version` counts as signed):

| `form_kind`          | Label                             |
| -------------------- | --------------------------------- |
| `hipaa_npp`          | HIPAA Notice of Privacy Practices |
| `aob`                | Assignment of Benefits            |
| `supplier_standards` | Supplier Standards                |

Patients sign via the portal sign-and-acknowledge link
(`/admin/patients/:id/portal-invite`); CSRs can also record a paper scan
via `/admin/form-acknowledgements`.

## Where the stop fires

`POST /admin/shop/orders/:orderId/tracking` — the admin action that enters
carrier + tracking number and stamps `shipped_at`. When the order resolves
to a clinical patient and a requirement applies but the paperwork is not
all signed, the endpoint returns:

```
409 { "error": "order_requires_signed_paperwork",
      "missingForms": ["Assignment of Benefits", ...],
      "requirementSources": ["global"|"payer"] }
```

The order is left untouched (no `shipped_at` is stamped) so the ship can
be retried once paperwork lands. The stop only applies to orders that
resolve to a patient
(`shop_orders.customer_id → shop_customers.auth_user_id →
patients.portal_auth_user_id`); guest / cash-pay accessory orders have no
paperwork to sign and are never blocked.

## Turning it on

**Globally** — admin Control Center (feature flags): enable
`orders.require_signed_paperwork`. Seeded **OFF** by default (migration
0248); turning it on gates every patient-linked order. The flag toggle
takes effect within ~5s (feature-flag cache TTL), no deploy needed.

**Per payer** — `/admin/billing/config/payers` → edit a payer → turn on
**"Require signed paperwork before shipment?"**
(`payer_profiles.requires_signed_paperwork`). A patient whose **primary**
insurance coverage maps to that payer (case-insensitive `display_name`
match, same resolution as the claim composer) is then gated even while the
global flag stays off.

Either trigger is sufficient — the order is gated if the global flag is on
**or** the patient's payer requires it.

## Turning it off

Disable the `orders.require_signed_paperwork` flag and/or clear the payer
toggle. Nothing else is needed; the gate reads both live on each ship.
