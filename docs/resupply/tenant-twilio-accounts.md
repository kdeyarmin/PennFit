# Tenant Twilio accounts

CareMetric operates the parent Twilio account. Each independent Breathe business uses a dedicated subaccount with its own business identity, numbers and Messaging Services. The shared CareMetric support / Healthcare Advisors number, **+18775212890**, stays outside tenant mappings.

This release supports dedicated account routing. It does **not** create provider accounts, transfer numbers, submit business registrations, or infer carrier approval. Existing mapped numbers keep their legacy routing until operations completes their migration. A non-seed tenant without a sending identity is blocked from using the platform default.

## Configure a connection

Store `TWILIO_TENANT_ACCOUNTS_JSON` only as a server deployment secret. It is a JSON array with these fields per connection:

| Field | Meaning |
| --- | --- |
| `orgId` | Existing Breathe organization UUID |
| `businessName` | Tenant's verified business / trading name |
| `accountSid` | Tenant subaccount SID (`AC…`) |
| `parentAccountSid` | Must match server `TWILIO_ACCOUNT_SID` |
| `apiKeySid`, `apiKeySecret` | API key created inside that subaccount |
| `authToken` | Subaccount Auth Token for validating Twilio callbacks |
| `numbers` | Nonempty list of E.164 numbers actually assigned to that account |
| `messagingServiceSids` | List of its Messaging Service SIDs (`MG…`), possibly empty |
| `state` | `staged` or `active` |
| `smsApproved` | `true` only after all configured SMS senders and use cases have the required provider approval |

Set `TWILIO_TENANT_CALLBACK_KEY` to a securely generated secret of at least 32 characters before activating any connection. Keep it stable while calls and delivery callbacks are in flight. It binds each outbound callback URL and its record identifiers to the platform; the tenant Auth Token alone is not sufficient authorization.

Account IDs, tenant IDs and resources must be unique across connections. Malformed configuration fails closed without displaying secret values. Only sanitized account metadata is returned to the phone settings page. Never put credentials into the Hub phone inventory, source control, chat, or browser settings.

## Migrate one business

1. Confirm the tenant's legal name, registration details, website, business email domain, authorized representative and consent evidence. A rejected Penn Home Medical Supply business profile must be corrected using that business's accurate information; do not relabel it CareMetric to bypass a mismatch.
2. Create the tenant subaccount under the CareMetric parent. Create its API key and Messaging Service, register the tenant's actual messaging brand/use case, and obtain required number verification. Record identifiers and real review status in the Hub.
3. Prepare unused numbers in `staged` state. Do not add a currently live parent number to this configuration before its planned cutover: staging deliberately blocks traffic for any resource listed there. Use the Hub's `planned` status for preparations that must not affect traffic.
4. Configure number / service inbound webhooks with **POST** to the approved public origin: `/resupply-api/voice/inbound-reorder` and `/resupply-api/sms/inbound`. Outbound calls and texts generate signed callback URLs automatically. Keep the shared CareMetric support webhooks separate.
5. During the cutover, pause that tenant's outbound jobs and allow pending legacy callbacks to drain. Transfer or assign provider resources, verify their actual child-account ownership, update the server secret and organization number/service bindings, then activate. Do not mix a parent number with a child Messaging Service. Phone settings cannot purchase new-tenant numbers in the parent account.
6. Keep `smsApproved:false` until approval for **every** configured texting sender and use case is confirmed. Voice can be active independently. This flag records an operator's verified decision; it does not query or override Twilio registration status.
7. Verify one authorized inbound and outbound call, an authorized opted-in text, media retrieval if used, and delivery callbacks. Check the expected organization owns all resulting records. Mark the Hub migration `active` only after those checks. Resume jobs.

If a connection or organization lookup fails, active tenants cannot fall back to the parent sender. Inbound callbacks must match the account, destination number and organization. Status updates from child accounts additionally constrain writes to that organization.

## Rollback

Pause tenant jobs first. Restore provider resource ownership, webhooks, organization bindings and deployment secrets together using the captured pre-cutover values. Simply removing an active secret does not move a number back to the parent. Restore the inventory's observed state after provider checks. Do not delete accounts or release numbers as part of rollback.

## Support Hub inventory

The central phone registry tracks tenant, account structure/SIDs, business profile status, texting registration and migration status alongside number purpose, routing and dated usage evidence. Registry changes are metadata only; they do not provision accounts, change routing, or approve texting. Current shared numbers remain labeled shared until their migration is verified.
