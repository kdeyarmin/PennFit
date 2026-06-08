# Office Ally go-live — eligibility (270/271) + claims (837P)

**Audience:** Penn Home Medical Supply operator / deployer.
**Status:** The integration is **fully built and shipping** — it runs in
**stub / outbox mode** until it's configured. Going live is a
**configuration** task; no code change is required.

There are **two ways to configure it**, in order of preference:

- **A. In the admin console (recommended — no global secrets).** Set the
  billing identity + clearinghouse connection in **Billing → Config**.
- **B. Environment variables (legacy fallback)** for dev / preview / any
  environment without a seeded DB row.

The `identity-resolver` resolves **DB row → env vars → stub**, so the
admin-UI config wins whenever it's present. The **only** thing that is a
real secret either way is the SSH **key file** (see "SSH key" below) —
everything else (NPI, tax ID, addresses, SFTP host/username, ETIN) is
non-secret config.

## What this turns on

Once configured, these existing code paths transmit to Office Ally over SFTP
instead of writing files to the local outbox:

| Capability                                            | Built in                                                                                                                                 | Runs as                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Real-time eligibility **270** request / **271** parse | `lib/resupply-integrations-office-ally/src/edi/270.ts`, `parse-271.ts`; `artifacts/resupply-api/src/lib/billing/eligibility-verifier.ts` | `POST /admin/patients/:id/insurance-coverages/:coverageId/verify-eligibility` → `eligibility_checks` row |
| Claims **837P** submission                            | `office-ally/src/edi/837p.ts` + adapter                                                                                                  | Office Ally submissions queue                                                                            |
| Inbound **999 / 277CA / 835** poll                    | `artifacts/resupply-api/src/worker/jobs/office-ally-inbound-poll.ts`                                                                     | nightly/sweep worker                                                                                     |

## A. Configure in the admin console (recommended)

Two pages under **Billing → Config**:

1. **Organization identity** (`/admin/billing/config/organization`) — legal
   name, tax ID, **organizational NPI**, taxonomy, addresses, accreditation.
   This is the billing identity printed on every claim / 270 / HCFA.
2. **Clearinghouse connection** (`/admin/billing/config/clearinghouse`) —
   SFTP host, username, **the two key-file paths**, remote dirs, **ETIN**,
   submitter contact, **usage indicator (T/P)**, and an **Active** toggle.

Then:

- Provision the **SSH key file + `known_hosts`** on the server (see "SSH
  key" below) and point the "Private key file path" / "known_hosts file
  path" fields at them. The key bytes are never entered in the UI or stored
  in the DB — only the paths.
- Click **Test connection** — it opens the SFTP session and lists the remote
  inbox; a green result confirms the key + host + credentials work.
- Leave **usage indicator = T** for the test cycle, then flip to **P** when
  ready to bill live.
- With both pages saved, you **do not need any `OFFICE_ALLY_*` env vars** —
  leave them unset (or delete them). The resolver uses the DB row.

## B. Configure via environment variables (legacy fallback)

Use this only where the DB row isn't seeded (local dev, preview). Set **all**
required vars or the resolver falls back to stub — `readOfficeAllyConfigOrNull()`
returns `null` on any missing var, and `preflight:prod` **FAILs** on a
partial set.

### Required (set ALL of these)

| Variable                            | What it is                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| `OFFICE_ALLY_USERNAME`              | Office Ally SFTP submitter id                                     |
| `OFFICE_ALLY_PRIVATE_KEY_PATH`      | Absolute path to the **0600** SSH private key file (see SSH note) |
| `OFFICE_ALLY_KNOWN_HOSTS_PATH`      | Absolute path to a `known_hosts` file pinning OA's host key       |
| `OFFICE_ALLY_ETIN`                  | Submitter ETIN (assigned by Office Ally)                          |
| `OFFICE_ALLY_BILLING_NPI`           | Type-2 (organizational) NPI                                       |
| `OFFICE_ALLY_BILLING_TAX_ID`        | 9-digit EIN, no dashes                                            |
| `OFFICE_ALLY_BILLING_ORG_NAME`      | Legal name as printed on the EIN                                  |
| `OFFICE_ALLY_BILLING_ADDRESS_LINE1` | Billing provider street                                           |
| `OFFICE_ALLY_BILLING_CITY`          | Billing provider city                                             |
| `OFFICE_ALLY_BILLING_STATE`         | 2-char USPS state                                                 |
| `OFFICE_ALLY_BILLING_ZIP`           | 5- or 9-digit zip, no dash                                        |

### Optional / tuning

| Variable                         | Default                 | Notes                                            |
| -------------------------------- | ----------------------- | ------------------------------------------------ |
| `OFFICE_ALLY_USAGE_INDICATOR`    | `T`                     | **`P` to go live.** `preflight` WARNs while `T`. |
| `OFFICE_ALLY_HOST`               | `sftp10.officeally.com` | OA SFTP host                                     |
| `OFFICE_ALLY_PORT`               | `22`                    |                                                  |
| `OFFICE_ALLY_REMOTE_INBOX`       | `inbound`               | Remote dir to drop files                         |
| `OFFICE_ALLY_CONTACT_NAME`       | `BILLING`               | PER segment                                      |
| `OFFICE_ALLY_CONTACT_PHONE_E164` | `+10000000000`          | PER segment — set a real number                  |
| `OFFICE_ALLY_FILE_OUTBOX_DIR`    | temp dir                | Stub-mode output dir only                        |
| `OFFICE_ALLY_STUB`               | unset                   | Set `1` to force stub even with creds present    |

## SSH key on the server (required for BOTH paths)

Both the UI and the env path store a **file path** to the key, not the key
bytes — so the `0600` private key + `known_hosts` file must exist on the
app server. Railway variables are strings, so use one of:

1. **Railway volume (preferred):** mount a volume, place the key +
   `known_hosts` on it, point the path field/var at them.
2. **Write-at-boot:** store the key material in secret string vars (e.g.
   `OFFICE_ALLY_PRIVATE_KEY_B64`), and add a prestart step that
   base64-decodes them to `/tmp/oa_key` (chmod 600) + `/tmp/oa_known_hosts`.
   (This prestart shim is the one piece not in the repo; the volume pattern
   needs no code.)

Pin `known_hosts` to Office Ally's published host key — never use blind /
`StrictHostKeyChecking=no` trust.

## Real-time eligibility (optional — instant 271)

By default an eligibility check submits the 270 over SFTP and the 271
arrives later via the inbound poll (minutes). Office Ally is CAQH
CORE-certified for **real-time** 270/271 over an HTTPS web service; when
that's configured, `verifyEligibility()` POSTs the 270 and parses the 271
**inline** (seconds), writing the check straight to `status='parsed'`.

This is **fully optional and fail-soft**: configure it and the real-time
path activates; leave it unconfigured (or hit a transient failure) and the
check transparently falls back to the SFTP submit-and-poll path. It uses
the real-time web-service credentials Office Ally issues **separately from
the SFTP key**.

### Two ways to configure (same resolution order as the SFTP path)

- **A. Admin console (recommended).** On **Billing → Config →
  Clearinghouse connection** there is a **Real-time eligibility (270/271)**
  card: an **Enabled** toggle, endpoint URL, username, CORE sender/receiver
  IDs, timeout, and **password**. All of these are saved to the
  `clearinghouse_credentials` row. The password field is write-only — the
  saved value is never shown back (GET returns only "set / not set"); leave
  it blank on edit to keep the current password.
- **B. Environment variables** (dev / preview, or no seeded DB row): set
  all of `OFFICE_ALLY_REALTIME_URL`, `_USERNAME`, `_PASSWORD` (plus the
  optional `_SENDER_ID` / `_RECEIVER_ID` / `_TIMEOUT_MS`).

The resolver prefers the **DB row's** real-time fields; the **password**
specifically uses the DB value when set and falls back to
`OFFICE_ALLY_REALTIME_PASSWORD`. (Security note: a DB-stored password is
held in **plaintext**, readable by the service-role client — unlike the
SFTP key, which stays a file path. Prefer the env var if you'd rather keep
the secret out of the database.)

| Variable                           | Notes                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `OFFICE_ALLY_REALTIME_PASSWORD`    | Password — DB value wins, this is the fallback. One of the two is required. |
| `OFFICE_ALLY_REALTIME_URL`         | Real-time eligibility endpoint (or set in the admin card)                   |
| `OFFICE_ALLY_REALTIME_USERNAME`    | Real-time web-service username (or set in the admin card)                   |
| `OFFICE_ALLY_REALTIME_SENDER_ID`   | Optional CORE SenderID (default: ETIN)                                      |
| `OFFICE_ALLY_REALTIME_RECEIVER_ID` | Optional CORE ReceiverID (default `OFFICEALLY`)                             |
| `OFFICE_ALLY_REALTIME_TIMEOUT_MS`  | Optional per-request timeout (default 30000)                                |

**Before going live, confirm against Office Ally's real-time companion
guide:** the exact endpoint URL, the `SOAPAction`/auth placement, the
`PayloadType` string, and whether the X12 payload is raw or base64. Those
spots are marked `CONFIRM(oa-spec)` in
`lib/resupply-integrations-office-ally/src/transport/realtime.ts`; the
CORE vC2.2.0 SOAP envelope is the shipped default. The check still records
the same `eligibility_checks` row and fires the same
`eligibility.completed` webhook as the SFTP path — only the latency
differs.

## Same-or-Similar (HETS)

Medicare Same-or-Similar (`/admin/.../same-or-similar`) is a **manual** CSR
entry today — the CSR runs the check in the CMS HETS portal and records the
result + ticket number. No separate HETS credential to set. (Automating the
HETS 270 is a future enhancement requiring a CMS HETS connection.)

## Validation

- **Admin-UI path:** use the Clearinghouse page's **Test connection** button,
  then run a **test eligibility check** (`/admin/billing/eligibility` →
  verify) and confirm a 271 comes back. Note: `preflight:prod`'s
  `OFFICE_ALLY` line validates the **env** path only — it can't read the DB
  config, so it will report "stub / no env vars" even when the UI config is
  live. That's expected; trust Test connection for the UI path.
- **Env path:** `pnpm --filter @workspace/scripts preflight:prod` —
  FAILs on a partial config, WARNs while usage indicator is `T`.

## Go-live checklist (admin-UI path)

1. Provision the SSH key + `known_hosts` on the server (volume / write-at-boot).
2. **Billing → Config → Organization identity** — fill + save.
3. **Billing → Config → Clearinghouse connection** — fill (point key paths at
   the provisioned files), usage indicator `T`, Active on, save.
4. Click **Test connection** — confirm OK.
5. Run a test eligibility check; confirm the 271 + `eligibility_checks` row
   resolve, and that the inbound poll picks up the ack/271.
6. When the test cycle is clean, set usage indicator **P** and save.
7. After deploy, confirm routing with
   `pnpm --filter @workspace/scripts verify:deploy -- https://<host>`.

## Rollback

- **UI path:** set the clearinghouse connection **Inactive** (or usage
  indicator back to `T`).
- **Env path:** set `OFFICE_ALLY_STUB=1` (or unset a required var).

Either falls back to stub/outbox immediately — nothing transmits, and queued
work is preserved.
