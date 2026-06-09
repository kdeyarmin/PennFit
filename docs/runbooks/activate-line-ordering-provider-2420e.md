# Runbook — validate & activate the line-level ordering provider (837P 2420E)

**Audience:** Penn Home Medical Supply biller / deployer with the Office Ally
account.
**What this turns on:** the DME accuracy item **A2** — emitting a line-level
ordering-provider loop (**2420E `NM1*DK`**, the prescribing physician + NPI +
address) on every 837P service line, so Medicare's PECOS edit binds at the
line. It is **additive** to the claim-level 2310D referring loop.

**Why it's gated.** Flipping it ON changes the bytes of every live 837P sent to
payers — an outward-facing, hard-to-reverse change. So it ships behind the
seeded-**OFF** feature flag `billing.line_ordering_provider` (migration 0251)
and must be confirmed against a real clearinghouse acknowledgment (**277CA**)
before production billing. With the flag OFF the 837P is **byte-identical** to
today.

> This step needs the **Office Ally account** — it can't be validated from a
> dev box or by code review. There's no 277CA to read until a batch is actually
> transmitted.

## Prerequisite — Office Ally must be configured

A 277CA only comes back if claims actually transmit. If Office Ally is still in
**stub / outbox mode** (no SFTP creds), there is nothing to validate yet —
finish [`office-ally-go-live.md`](./office-ally-go-live.md) first. Confirm via
**Admin → Billing → Config → Clearinghouse → Test connection** (green = live).
Leave the **usage indicator on `T` (test)** for this whole procedure.

## Step 1 — eyeball the EDI before sending (no transmission)

You can see the exact bytes the flag produces without touching a payer:

1. Set `OFFICE_ALLY_STUB=1` (forces outbox mode; writes the 837P to a file
   instead of SFTP — see `OFFICE_ALLY_FILE_OUTBOX_DIR`, default
   `outputs/office-ally/`).
2. Turn the flag **ON**: **Admin → Control Center → feature flags →
   `billing.line_ordering_provider`**.
3. Build a batch for one test claim that has a **referring (prescribing)
   provider with an NPI** attached (the ordering provider is sourced from the
   claim's referring provider; a claim without one emits no 2420E).
4. Open the written `.837` file and confirm each service line now carries:
   ```
   NM1*DK*1*<LastName>*<FirstName>*...*XX*<10-digit NPI>~
   N3*<street>~                 (only if the provider has a practice address)
   N4*<city>*<ST>*<zip>~
   ```
   right after the line's `DTP*472` service date. If you don't see `NM1*DK`,
   the claim's referring provider is missing or has no NPI — fix that first.
5. Unset `OFFICE_ALLY_STUB` when done previewing.

## Step 2 — transmit a test batch (usage indicator `T`)

1. With the connection live and usage indicator **`T`**, and the flag still
   **ON**, batch-submit **one** real claim (one that has a prescribing provider)
   to Office Ally.
2. Wait for the inbound poll to pick up the acknowledgments (or check the
   Office Ally portal): you want the **999** (syntax accepted) and then the
   **277CA** (front-end claims acknowledgment).

## Step 3 — read the 277CA

- **Accepted** (277CA status = accepted, no 2420E/`NM1*DK`/ordering-provider
  edit) → the loop is good. Proceed to Step 4.
- **Rejected** citing the ordering provider / 2420E / a duplicate provider loop
  → the payer doesn't want the line-level ordering provider alongside the
  claim-level 2310D referring loop. **Roll back** (Step 5) and open a follow-up:
  the fix is to drop the 2310D referring loop for that path (emit the ordering
  provider at the line **instead of** the referring at the claim), which is a
  one-line change in `office-ally-batch` — but only make it with the 277CA
  evidence in hand.
- **Rejected for an unrelated reason** (eligibility, member id, …) → that's not
  about 2420E; fix the underlying claim and re-test.

## Step 4 — leave it on for production

Once a clean 277CA is confirmed in the `T` cycle, leave
`billing.line_ordering_provider` **ON**. When you later flip the Office Ally
usage indicator to **`P`**, production claims carry the 2420E loop. No further
change needed — the flag persists in `resupply.feature_flags`.

## Step 5 — rollback (instant, no deploy)

Flip `billing.line_ordering_provider` **OFF** in the Control Center. The next
batch (cache TTL ~5s) emits the prior, byte-identical 837P with no 2420E loop.
Nothing else changes; no migration or deploy involved.

## Where the code lives

| Piece                                       | Location                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Flag seed (OFF)                             | `lib/resupply-db/drizzle/0251_billing_line_ordering_provider_flag.sql`                                |
| Flag enum                                   | `artifacts/resupply-api/src/lib/feature-flags.ts`                                                     |
| Per-line attach (gated)                     | `artifacts/resupply-api/src/lib/billing/office-ally-batch.ts` (`buildOneDetail` → `orderingProvider`) |
| EDI emit (2420E `NM1*DK` + N3/N4 + REF\*0B) | `lib/resupply-integrations-office-ally/src/edi/837p.ts`                                               |
