# Office Ally go-live — eligibility (270/271) + claims (837P)

**Audience:** Penn Home Medical Supply operator / deployer.
**Status:** The integration is **fully built and shipping** — it runs in
**stub / outbox mode** until the credentials below are set. Going live is a
**configuration** task: set the Office Ally variables in Railway, flip the
usage indicator to production, and validate. No code change is required.

## What this turns on

Once configured, these existing code paths transmit to Office Ally over SFTP
instead of writing files to the local outbox:

| Capability                                            | Built in                                                                                                                                 | Runs as                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Real-time eligibility **270** request / **271** parse | `lib/resupply-integrations-office-ally/src/edi/270.ts`, `parse-271.ts`; `artifacts/resupply-api/src/lib/billing/eligibility-verifier.ts` | `POST /admin/patients/:id/insurance-coverages/:coverageId/verify-eligibility` → `eligibility_checks` row |
| Claims **837P** submission                            | `office-ally/src/edi/837p.ts` + adapter                                                                                                  | Office Ally submissions queue                                                                            |
| Inbound **999 / 277CA / 835** poll                    | `artifacts/resupply-api/src/worker/jobs/office-ally-inbound-poll.ts`                                                                     | nightly/sweep worker                                                                                     |

**Stub fallback:** `readOfficeAllyConfigOrNull()` returns `null` (→ stub) if
**any** required variable below is missing, **or** if `OFFICE_ALLY_STUB=1`.
In stub mode, generated EDI is written to `OFFICE_ALLY_FILE_OUTBOX_DIR`
instead of transmitted. **A partial config silently degrades to stub** — set
all of them or none. `preflight:prod` now FAILS on a partial config.

## Required variables (set ALL of these in Railway → Variables)

| Variable                            | What it is                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| `OFFICE_ALLY_USERNAME`              | Your Office Ally SFTP submitter id                                |
| `OFFICE_ALLY_PRIVATE_KEY_PATH`      | Absolute path to the **0600** SSH private key file (see SSH note) |
| `OFFICE_ALLY_KNOWN_HOSTS_PATH`      | Absolute path to a `known_hosts` file pinning OA's host key       |
| `OFFICE_ALLY_ETIN`                  | Your submitter ETIN (assigned by Office Ally)                     |
| `OFFICE_ALLY_BILLING_NPI`           | Type-2 (organizational) NPI for the DME entity                    |
| `OFFICE_ALLY_BILLING_TAX_ID`        | 9-digit EIN, no dashes                                            |
| `OFFICE_ALLY_BILLING_ORG_NAME`      | Legal name as printed on the EIN                                  |
| `OFFICE_ALLY_BILLING_ADDRESS_LINE1` | Billing provider street                                           |
| `OFFICE_ALLY_BILLING_CITY`          | Billing provider city                                             |
| `OFFICE_ALLY_BILLING_STATE`         | 2-char USPS state (e.g. `PA`)                                     |
| `OFFICE_ALLY_BILLING_ZIP`           | 5- or 9-digit zip, no dash                                        |

## Optional / tuning variables

| Variable                         | Default                 | Notes                                                                                                 |
| -------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `OFFICE_ALLY_USAGE_INDICATOR`    | `T`                     | **Set to `P` to go live.** `T` = Office Ally's TEST environment. `preflight` WARNs while this is `T`. |
| `OFFICE_ALLY_HOST`               | `sftp10.officeally.com` | OA SFTP host                                                                                          |
| `OFFICE_ALLY_PORT`               | `22`                    |                                                                                                       |
| `OFFICE_ALLY_REMOTE_INBOX`       | `inbound`               | Remote dir to drop files                                                                              |
| `OFFICE_ALLY_CONTACT_NAME`       | `BILLING`               | PER segment                                                                                           |
| `OFFICE_ALLY_CONTACT_PHONE_E164` | `+10000000000`          | PER segment — set a real number                                                                       |
| `OFFICE_ALLY_FILE_OUTBOX_DIR`    | temp dir                | Stub-mode output dir only                                                                             |
| `OFFICE_ALLY_STUB`               | unset                   | Set `1` to force stub even with creds present                                                         |

## SSH key on Railway (important)

`OFFICE_ALLY_PRIVATE_KEY_PATH` / `OFFICE_ALLY_KNOWN_HOSTS_PATH` are **file
paths**, but Railway variables are strings. Two supported patterns:

1. **Railway volume (preferred):** mount a volume, place the `0600` private
   key and `known_hosts` on it, and point the two path vars at them.
2. **Write-at-boot:** store the key material in secret string vars (e.g.
   `OFFICE_ALLY_PRIVATE_KEY_B64`, `OFFICE_ALLY_KNOWN_HOSTS_B64`) and add a
   tiny prestart step that base64-decodes them to `/tmp/oa_key` (chmod 600)
   and `/tmp/oa_known_hosts`, then sets the two `_PATH` vars to those files.
   (This prestart shim is the one small piece not yet in the repo — add it to
   the start command if you choose this pattern; the volume pattern needs no
   code.)

Pin `known_hosts` to Office Ally's published host key — do **not** use
blind/`StrictHostKeyChecking=no` trust.

## Same-or-Similar (HETS)

Medicare Same-or-Similar (`/admin/.../same-or-similar`, table
`medicare_same_or_similar_checks`) is a **manual** CSR entry today — the CSR
runs the check in the CMS HETS portal and records the result + ticket number.
There is no separate HETS credential to set here. (Automating the HETS 270 is
a future enhancement; it requires a CMS HETS connection, separate from Office
Ally.)

## Go-live checklist

1. Set all **required** vars + `OFFICE_ALLY_USAGE_INDICATOR=T` first.
2. Provision the SSH key + `known_hosts` (see SSH note).
3. Run preflight — it now validates Office Ally:
   `pnpm --filter @workspace/scripts preflight:prod`
   Expect `OFFICE_ALLY … fully configured` and a WARN that you're still in `T`.
4. In the admin console, run a **test eligibility check** on a known patient
   (`/admin/billing/eligibility` worklist → verify) and confirm a 271 comes
   back and the `eligibility_checks` row resolves.
5. Confirm the inbound poll picks up the 999/277CA/271 from OA's outbound dir.
6. When the test cycle is clean, set `OFFICE_ALLY_USAGE_INDICATOR=P` and
   re-run preflight (the WARN clears).
7. After deploy, confirm routing with
   `pnpm --filter @workspace/scripts verify:deploy -- https://<host>`.

## Rollback

Set `OFFICE_ALLY_STUB=1` (or unset any required var) to immediately fall back
to outbox/stub mode — nothing transmits, and queued work is preserved.
