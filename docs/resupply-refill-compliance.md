# Resupply refill compliance — Medicare / major-payer wiring

This note documents how PennFit (CareMetric Breathe) satisfies the CMS
DMEPOS **refill requirements** for recurring CPAP supplies, and the two
feature flags that govern the pieces added in migration **0404**.

## The requirement

CMS Standard Documentation Requirements (Program Integrity Manual Ch. 5,
"Refill Requirements") and the major commercial-payer DME contracts
require, for items supplied on a recurring basis, that the supplier:

1. **Contacts the beneficiary before each refill** — supplies are never
   auto-shipped on a fixed schedule.
2. **Documents an affirmative refill request** — at refill time the
   beneficiary (or an authorized representative) confirms that **(a)** they
   are still using the item and **(b)** their remaining supply is
   approaching exhaustion.
3. **Respects the refill timing window** — the supplier does not contact
   the beneficiary earlier than **14 days**, nor ship earlier than
   **10 days**, before the current supply's expected depletion.

## What already existed

- **No auto-ship.** An order is placed only on an affirmative SMS `YES`,
  email-link click, or voice confirmation (`placeResupplyOrderForConversation`).
- **Interval + quantity gate** (`resupply.entitlement_enforcement`,
  migrations 0171/0172) — blocks a confirm that isn't yet payable under
  the HCPCS replacement schedule (Medicare LCD L33718).
- **Coverage gate** (`resupply.eligibility_enforcement`) and
  **continued-use gate** (`resupply.usage_compliance_check`).
- ESIGN/UETA signature packets (AOB, NPP, proof of delivery, DMEPOS
  supplier standards) and SWO/DWO/CMN documents.

## What 0404 added

### 1. Refill attestation capture — `resupply.refill_affirmation_capture` (ON)

Every confirm channel now states the attestation the patient is agreeing
to, and the affirmation is persisted as one **`refill_confirmations`** row
per confirmed episode (the audit-grade proof a payer asks for):

| Channel | Where the attestation is shown                                                                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| SMS     | reminder copy asks them to reply `YES` only if still using it AND running low (`defaultReminderSmsBody`)                |
| Email   | the click-through landing page renders `REFILL_AFFIRMATION_STATEMENT` above the confirm button (`renderClickLanding`)   |
| Voice   | the agent confirms continued use + running low out loud before calling `place_resupply_order` (prompt `2026-06-19.v12`) |

The row records the channel, both attestation booleans, the exact
statement snapshot, the requester relationship, the computed expected
depletion date, and the IP / user-agent of the click where available. The
canonical statement lives in one place —
`REFILL_AFFIRMATION_STATEMENT` (`@workspace/resupply-domain`).

The write is **best-effort and happens after the order is placed** — a
write failure never blocks a ship. Recording is gated by the flag (seeded
**ON**: capturing the attestation is a compliance baseline, not a change
to the ship decision).

CSRs read a patient's attestations at
`GET /admin/patients/:id/refill-confirmations`.

### 2. Refill ship-window guard — `resupply.refill_window_enforcement` (OFF)

When ON, the confirm path blocks a ship that would land earlier than
**10 days** before the current supply's expected depletion
(`resolveRefillWindow`, `@workspace/resupply-domain`), routing it to a CSR
via a `resupply_refill_too_early` alert. Seeded **OFF** because it is a
behavior change on the patient-facing confirm path; the existing
interval/quantity entitlement gate (which requires the full interval) is
stricter and remains the default ship-timing floor. Fail-open: a first
fill, an unmapped SKU, or any lookup error allows the confirmation
through.

> The 14-day **contact** window is satisfied by construction: reminders
> fire on the configured replacement cadence (Medicare cadences seeded in
> migration 0070), i.e. at — not before — expected depletion, which is
> inside the 14-day contact window.

## Operating notes

- Enabling a tenant's refill-window enforcement is a System Configuration
  toggle; it composes with the entitlement gate (the stricter one wins).
- The `refill_confirmations` row is keyed `UNIQUE (episode_id)` so a
  duplicate confirm (email click + SMS `YES`) records exactly once.
- No PHI is logged: alerts and audit rows carry codes, counts, and dates
  only.
