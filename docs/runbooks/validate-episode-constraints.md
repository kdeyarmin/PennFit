# Runbook — validating the episode lifecycle constraints

**Owner:** whoever holds the production database.
**Applies to:** `resupply.episodes` — `episodes_status_enum` and
`episodes_closed_reason_enum`, added **NOT VALID** by migration 0538 and
validated by migration **0539**.

---

## Why an unvalidated constraint is not a loose end

`NOT VALID` is widely read as "the constraint only applies to new rows."
It does not mean that. It skips the **one-time back-scan**; Postgres still
enforces the constraint on every subsequent `INSERT` **and `UPDATE`** —
including an `UPDATE` that never touches the constrained column.

So one legacy row carrying an off-vocabulary `status` turns the next
patient confirm that touches that row into a **500, on a patient-facing
path**, with nothing anywhere warning you first.

That is why 0539 exists, and why the survey below is worth running before
it. The constraint being unvalidated is an armed landmine whose blast
radius nobody has measured.

---

## Step 1 — survey (read-only, no lock, safe on production)

```bash
DATABASE_URL=… node lib/resupply-db/scripts/constraint-preflight.mjs
```

The session sets `default_transaction_read_only = on`, so it **cannot**
write even by accident. Counting is database-native
(`SELECT count(*) … WHERE (<check body>) IS FALSE`), so there is no row cap
to paginate around and no window that can truncate — the count is complete
by construction.

`(body) IS FALSE`, not `NOT (body)`, is Postgres's own violation predicate:
a `CHECK` **passes** when it evaluates to `NULL`, so a `NULL` status is not
a violation and must not be counted as one.

Output per constraint:

```
  !! resupply.episodes / episodes_status_enum
     3 violating row(s). VALIDATE would fail, and every UPDATE that
     touches one of these rows already errors.
            2  status=pending
            1  status=approved
     sample ids: 0000…d1, 0000…d2, 0000…d3
```

| Flag               | Effect                                                      |
| ------------------ | ----------------------------------------------------------- |
| `--json`           | machine-readable report, suitable for attaching to a ticket |
| `--repair-plan`    | print reviewable, **commented-out** repair SQL              |
| `--schema=a,b`     | narrow the survey (default `resupply,public,resupply_auth`) |
| `--include-values` | print values from columns outside the vocabulary allowlist  |

**Exit codes:** `0` clean · `1` violations found · `2` the survey failed.

**PHI:** counts, constraint names and internal UUIDs are printed. Column
_values_ are printed only for low-cardinality vocabulary columns (`status`,
`closed_reason`, `kind`, …). Anything else is withheld unless you pass
`--include-values`.

---

## Step 2a — clean survey → just deploy

Migration 0539 surveys again inside the migration and validates. Nothing
else to do. `VALIDATE CONSTRAINT` takes `SHARE UPDATE EXCLUSIVE`: it does
**not** block `SELECT` / `INSERT` / `UPDATE` / `DELETE`, only other DDL and
`VACUUM`. One sequential scan; seconds at the current table size.

Confirm afterwards:

```sql
SELECT conname, convalidated
  FROM pg_constraint
 WHERE conrelid = 'resupply.episodes'::regclass AND contype = 'c';
```

Both rows must read `t`.

---

## Step 2b — violations found → repair deliberately

**0539 will refuse**, naming the offending values and counts. A failed
migration **gates the deploy**: Railway's `preDeployCommand` keeps the
_previous_ release serving, so the cost is a release that does not ship —
not an outage.

Do **not** work around it by rewriting statuses in bulk. An off-vocabulary
`status` records what the system believed happened to a patient's resupply
cycle. Coercing it to the nearest legal spelling destroys that and makes
the outcome funnel confidently wrong.

Instead:

```bash
node lib/resupply-db/scripts/constraint-preflight.mjs --repair-plan > repair.sql
```

Every statement comes out **commented**, with its row count and `<TARGET>`
left blank, so nothing can be run unthinkingly. For each group:

1. Find out what that value meant. Check when those rows were written and
   which code path wrote them (`git log -S'<value>'`).
2. Map it onto the vocabulary in
   `lib/resupply-domain/src/episode-status.ts`, or decide the rows should
   be closed rather than relabelled.
3. Record the decision in the ticket **before** running anything.
4. Run inside an explicit transaction you can roll back:

```sql
BEGIN;
UPDATE resupply.episodes SET status = 'expired' WHERE status = 'pending';
-- re-survey inside the transaction
SELECT count(*) FROM resupply.episodes
 WHERE status NOT IN ('outreach_pending','awaiting_response','address_hold',
                      'confirmed','fulfilled','declined','expired','canceled');
COMMIT;  -- or ROLLBACK
```

5. Re-run the survey. Deploy once it exits `0`.

Preserve the audit trail: the repair itself is a historical fact worth
recording in the ticket, with the before/after counts from the survey.

---

## Rollback

`VALIDATE CONSTRAINT` sets a flag; it changes no data. To undo:

```sql
ALTER TABLE resupply.episodes DROP CONSTRAINT episodes_status_enum;
ALTER TABLE resupply.episodes
  ADD CONSTRAINT episodes_status_enum
  CHECK (status IN ('outreach_pending','awaiting_response','address_hold',
                    'confirmed','fulfilled','declined','expired','canceled'))
  NOT VALID;
```

This restores the pre-0539 state exactly. Note it does **not** make the
constraint stop rejecting bad writes — that was never what `NOT VALID`
did.

---

## Deliberately not covered

`resupply.fulfillments.status` has **no** CHECK, in 0538 or 0539. The table
carries an unresolved spelling split: every filter in the app excludes
`cancelled` (double-L) while the admin badge renders `canceled` (single-L).
Adding a constraint before that is settled would arm the same landmine on
the confirm hot path. The vocabulary is pinned in TypeScript
(`FULFILLMENT_CANCELLED`) first; the constraint can follow once a survey
confirms only one spelling exists in the data.

---

## Verification performed in the repository

Migration 0539 was exercised end-to-end against a real PostgreSQL 16 with
the full migration chain replayed from scratch:

| Case                            | Result                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| Off-vocabulary rows present     | migration **fails**, naming `approved, pending` and the count |
| Rows repaired, migration re-run | applies; both constraints `convalidated = t`                  |
| Migrator re-run                 | no-op (idempotent)                                            |
| Survey re-run                   | `CLEAN`, exit 0                                               |

Automated coverage: `lib/resupply-db/scripts/constraint-preflight.test.ts`
(pure parsing and repair-plan rendering everywhere; live-database survey,
`NULL`-is-not-a-violation, read-only enforcement and value withholding when
`DATABASE_URL` is set).

**No production database was contacted for any of this.**
