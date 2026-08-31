# PacWare shipment confirmations — data dictionary and validation

**What this closes.** `/admin/pacware/export/resupply-due.csv` hands
PacWare a worklist of what to pick, ship and bill. This is the return
leg: PacWare's shipment report comes back, and `fulfillments.shipped_at`
finally gets a writer.

**Why that matters more than it sounds.** A ship date imported here
becomes the **date of service on an 837P**. It also re-times the
patient's next refill and closes their current cycle. It is not a
hygiene field, and nothing in this workflow treats it as one.

---

## The file

A CSV exported from PacWare. Column order does not matter; headers are
matched case-insensitively against the aliases below. Unknown columns are
ignored and reported.

Template:
[`templates/pacware-shipment-confirmations-template.csv`](./templates/pacware-shipment-confirmations-template.csv)

### Columns

| Canonical field    | Header aliases                                                | Required | Format                                            | Notes                                                                                                             |
| ------------------ | ------------------------------------------------------------- | -------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pennfitEpisodeId` | `pennfit_episode_id`, `episode_id`, `pennfit_id`              | no       | UUID                                              | **The strongest key.** Round-trips from the resupply-due export; ask PacWare to keep it in the order notes.       |
| `pacwareOrderRef`  | `pacware_order_ref`, `order_ref`, `order_number`, `so_number` | no       | ≤64 chars                                         | PacWare's own order number. Unknown on the first import; stamped on match, so every later import is an exact key. |
| `pacwareId`        | `pacware_id`, `patient_id`, `account`, `account_number`       | **yes**  | ≤64 chars                                         | The patient's PacWare account number.                                                                             |
| `itemSku`          | `item_sku`, `sku`, `hcpcs`, `item`                            | **yes**  | ≤64 chars                                         |                                                                                                                   |
| `quantity`         | `quantity`, `qty`, `units`                                    | no       | 1–999                                             |                                                                                                                   |
| `shippedDate`      | `shipped_date`, `ship_date`, `date_shipped`                   | **yes**  | `YYYY-MM-DD` (MM/DD/YYYY accepted and normalized) | **Becomes the date of service.**                                                                                  |
| `deliveredDate`    | `delivered_date`, `delivery_date`                             | no       | same                                              | Must not precede the ship date.                                                                                   |
| `trackingNumber`   | `tracking_number`, `tracking`                                 | no       | ≤128 chars                                        |                                                                                                                   |
| `carrier`          | `carrier`, `ship_via`, `shipper`                              | no       | ≤64 chars                                         |                                                                                                                   |
| `rowStatus`        | `status`, `order_status`                                      | no       | free text                                         | `cancelled` / `canceled` / `voided` are **never** treated as a dispense.                                          |

A row must carry **at least one usable match key**: an episode id, an
order reference, or the patient account + SKU pair. A row with none is
unmatched by construction and is rejected at parse time.

---

## How a row is matched

Three strategies, tried in order. Each one is stronger than the next.

1. **`pennfitEpisodeId`** — our own handle. Unambiguous when present.
2. **`pacwareOrderRef`** — exact, once it has been stamped.
3. **`pacwareId` + `itemSku`** — the most recent unshipped queued line
   for that patient and SKU, inside a 120-day window, that could
   plausibly have produced this ship (a ship cannot precede the queue by
   more than a day).

**An ambiguous key is never retried against a weaker one.** When a
strategy yields more than one candidate the row is reported `ambiguous`
and left for a person. Attaching a ship date to the wrong fulfillment
does not merely mis-report: it sets the date of service on the wrong
patient's claim and re-times their refills. A row an operator has to look
at costs minutes; a wrong one costs a denied claim and a patient who runs
out of supplies.

---

## Dispositions

Every row lands in exactly one, decided in this precedence:

| Disposition        | Applied? | Meaning and remedy                                                                                                                                                            |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid`          | no       | The row could not be parsed. The reason names the column, never the value.                                                                                                    |
| `cancelled`        | no       | The report itself says the order was voided.                                                                                                                                  |
| `future_dated`     | no       | A date of service that has not happened. One day of slack for a warehouse in a later timezone.                                                                                |
| `too_old`          | no       | Older than 180 days (configurable). Importing it would mint a claim at **timely-filing risk (CARC 29)**. Expected on a first backfill — raise `maxBackdateDays` deliberately. |
| `duplicate`        | no       | The same order line already appeared earlier in this file. A split shipment or a duplicated export; only the first occurrence is applied.                                     |
| `ambiguous`        | no       | More than one order could be meant. Candidate ids are reported.                                                                                                               |
| `unmatched`        | no       | Nothing in this tenant matches any key on the row.                                                                                                                            |
| `already_recorded` | no       | Same shipment, same date, already on file. A re-import changes nothing.                                                                                                       |
| `date_conflict`    | no       | A **different** date is already on file. See below.                                                                                                                           |
| `matched`          | **yes**  | Usable.                                                                                                                                                                       |

Counts are always reported for **every** disposition, including zeros —
a category that is merely empty must not look absent.

---

## Ship-date corrections

`fulfillments.shipped_at` is the date of service a payer was told. Once a
claim carries it, it cannot be corrected in place: overwriting it would
make the claim and the record disagree with nobody knowing, and the
disagreement surfaces as a denial weeks later.

So a `date_conflict` on a **billed** fulfillment opens a
`shipment_date_exceptions` row (migration 0541) and nothing is written.
One open exception per fulfillment, enforced by a partial unique index —
a repeated import of the same conflicting file cannot queue the same
decision ten times.

Work them at `GET /admin/pacware/shipment-exceptions`:

| Resolution         | Effect                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kept_recorded`    | The recorded date stands. The report was wrong.                                                                                                                                                                           |
| `corrected`        | **The only one that rewrites the date.** A deliberate, attributed act. The claim must be corrected separately — re-submitting a claim is a billing decision with its own approval gate, and this route does not touch it. |
| `duplicate_report` | The report duplicated a shipment already recorded.                                                                                                                                                                        |
| `invalid_report`   | The report is wrong and no correction applies.                                                                                                                                                                            |

Before 0541 the new date was silently dropped. Safe, but the correction
the warehouse sent was lost.

---

## Idempotency, at two levels

**Per row.** `recordShipmentEvidence` claims the fulfillment with
`.is("shipped_at", null)`. Two concurrent imports of the same file both
run the UPDATE; Postgres serialises them and the loser matches zero rows.
A replay writes nothing.

**Per file.** A SHA-256 of the normalized report text is recorded on every
commit. Normalized — line endings, BOM, trailing newline — so a file
re-saved from Excel is recognised as the same file; those edits change
every byte and no meaning.

The `Idempotency-Key` header stops a double-submit of the same _request_.
It does nothing about the same _file_ uploaded from a fresh tab, by a
colleague, or after a timeout that had actually succeeded. Those are
different requests with identical content, and only the content can tell.

A re-commit is **refused with 409** unless the caller sends
`acknowledgeReimport: true`. Without that signal the second import
reports the same counts as the first with everything "unchanged" — which
is indistinguishable from a file that genuinely contained nothing new.

**Previews claim no hash.** A preview is a question, not an event;
previewing the same file five times while working out what it will do is
free.

---

## Validating a real file, before touching production

Nobody in this repository has seen a real PacWare shipment export. The
first look should not be inside production.

```bash
pnpm --filter @workspace/scripts pacware:validate-shipments -- \
  --file=/absolute/path/to/report.csv --show-headers
```

- Reads the file **from where it is**. Never copies, uploads, or echoes
  it. No database, no network, no writes.
- Prints counts, row numbers and category names. **No cell values.**
  `--show-headers` additionally prints column header labels, which are not
  patient data and are the single most useful thing when a report does
  not map.
- `--json` for a machine-readable artifact to attach to a ticket.
- Exits `1` when there are invalid or future-dated rows.

**What it cannot tell you.** Matching needs the tenant's fulfillments, so
every parseable row comes back `unmatched`. That is expected and is not a
finding. What it does answer is the first-look question: does the header
map, do the dates parse, which match keys does this report actually
carry, and are there duplicates, splits or cancelled rows?

---

## PHI

| Surface                    | Carries                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Preview / commit response  | Counts, a file hash, row numbers. **No row content** — a sample would put PHI in a response body, and with an `Idempotency-Key` the idempotency middleware would persist it.                                                                                                                                       |
| `report.csv` download      | Row numbers, category names, reasons built from constants, internal UUIDs. **No name, account number, SKU, tracking number or date drawn from the file.** That is what makes it safe to attach to a ticket. The operator finds the offending line by row number in their own copy, which never left their machine. |
| Application log            | Fulfillment ids and error class names. Never a row.                                                                                                                                                                                                                                                                |
| `pacware_shipment_imports` | A hash and counts. The report body is never stored.                                                                                                                                                                                                                                                                |

---

## Production-validation checklist

Nothing below has been performed — no real PacWare file exists in this
repository. Record results in
[`../reviews/external-validation-checklist.md`](../reviews/external-validation-checklist.md).

| #   | Step                                                   | Who      | Command / screen                                               | Expected                                                                                                      | Evidence to retain                       |
| --- | ------------------------------------------------------ | -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Export a shipment report from PacWare covering ~1 week | Operator | PacWare reporting                                              | A CSV with a header row                                                                                       | The file stays on the operator's machine |
| 2   | Validate it offline                                    | Operator | `pacware:validate-shipments -- --file=… --show-headers --json` | Exit 0; `parseErrors: 0`; `unmappedHeaders` empty or explained                                                | The `--json` output (contains no PHI)    |
| 3   | Confirm the match keys                                 | Operator | same output                                                    | `withEpisodeId` or `withOrderRef` > 0. If both are 0 every match falls back to patient+SKU — the weakest key. | The `keyCoverage` block                  |
| 4   | Preview against the tenant                             | Operator | `/admin/pacware` → Import shipments → Preview                  | `willApply` > 0; `ambiguous` and `unmatched` understood                                                       | Screenshot of the preview summary        |
| 5   | Download the dispositions                              | Operator | Preview → Download report                                      | A CSV of row numbers + categories                                                                             | The CSV (contains no PHI)                |
| 6   | Work every non-`matched` row                           | CSR      | operator's own copy of the file                                | Each row explained                                                                                            | Notes on the ticket                      |
| 7   | Commit                                                 | Operator | Preview → Commit                                               | `applied` equals the preview's `willApply`                                                                    | Screenshot of the commit summary         |
| 8   | Verify the lifecycle moved                             | Operator | `/admin/analytics/order-outcomes`                              | `shipped` climbs by `applied`; `assumed_shipped` does **not**                                                 | Before/after screenshots                 |
| 9   | Re-run the same file                                   | Operator | Commit again                                                   | **409 `already_imported`**                                                                                    | Screenshot                               |
| 10  | Verify claim dates of service                          | Biller   | `/admin/billing` on an affected claim                          | DOS equals the ship date from the file, not today                                                             | Screenshot                               |
| 11  | Check the exception queue                              | Biller   | `/admin/pacware/shipment-exceptions`                           | Empty, or every entry understood                                                                              | Screenshot                               |

**Only after steps 1–11 pass may this workflow be marked
"Production Validated".** Fixture coverage is not live validation, and
this document does not claim it is.

---

## Related

- [`pacware.md`](./pacware.md) — the wider PacWare file exchange.
- [`../runbooks/pacware-import-export.md`](../runbooks/pacware-import-export.md) — the operator manual.
- [`../runbooks/resupply-lifecycle-cutover.md`](../runbooks/resupply-lifecycle-cutover.md) — `ship_evidence_required` depends on this import being real.
