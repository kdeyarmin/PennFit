# CareMetric business-phone text follow-ups

The shared assistant at (877) 521-2890 can send one requested SMS per call,
bundling up to three approved public resources: software directory, Breathe
information, Support Hub, Advisors contact form, account-access guidance, and
safe troubleshooting steps. This is separate from patient outreach.

The caller must supply and confirm their own mobile number and explicitly
accept the spoken one-time SMS disclosure. No caller-ID-based consent, free-form
SMS body, private account link, patient information, marketing enrollment, or
automatic resend. The model uses `send_info_sms`; only the business-line caller
kind can dispatch it. `shared_phone_sms` stores consent version/time, resources,
recipient and delivery state. Its unique CallSid claims a send before Twilio is
called and prevents duplicates after reconnects or ambiguous timeouts.

## Activation status and registration

On September 24, 2026, the signed-in Twilio Console showed that 877-521-2890
was approved February 24 for **2FA and Customer Care**, described as EHR patient
reminders with **web-form consent**. This does not describe the new verbal
opt-in business support workflow. The new feature is deployed with
`CAREMETRIC_PHONE_SMS_ENABLED=false` pending an appropriate approved registration.
The assistant does not offer SMS or receive the SMS tool while disabled.

Twilio's approved-registration workflow requires deleting/replacing a
verification when changing the use case or opt-in flow. Deletion cannot be
undone and can interrupt SMS until reapproval. Obtain the account owner's
confirmation before this step; alternatively ask Twilio Support about retaining
the existing approval while adding the new use case. Do not remove the number,
its voice webhook, or a Messaging Service.

- Twilio guide: https://www.twilio.com/docs/messaging/compliance/toll-free/console-onboarding
- Public consent evidence: https://cmbreathe.com/resupply-api/caremetric/texting
- Proposed use category: Customer Care.
- Opt-in: Verbal, during an inbound call, with number readback and a later affirmative response.
- Use summary: CareMetric sends one optional, caller-requested informational
  follow-up after an inbound call about its software support, customer service,
  or Healthcare Advisors. A fixed template contains requested public links or
  general support steps. No recurring campaign, private patient information,
  medical advice, appointment confirmation, or unrelated promotion is sent.
- Estimated starting volume: 100 messages/month (existing registration estimate;
  revise when actual business volume is known).
- Samples: see the exact templates on the consent-evidence page. Each starts
  with CareMetric, identifies the requested information, and includes STOP/HELP.
- Privacy: https://caremetric.ai/privacy-policy ; terms: https://caremetric.ai/terms

## Production configuration after approval

The reviewed service is **CareMetric AI**, SID
`MGe4ff7c94d59f2728b463656302ce611e`; its only sender was +18775212890.

1. Confirm that the approved registration covers the actual use case and verbal
   consent. Preserve or separately migrate any existing patient reminder/2FA
   flows before replacing their registration.
2. Enable Advanced Opt-Out on that service; keep standard STOP/START keywords.
   Use a branded HELP reply with (877) 521-2890 and the Support Hub URL. Avoid
   duplicate opt-out replies: the application returns empty TwiML for OptOutType.
3. Route inbound messages on the service to POST
   `https://cmbreathe.com/resupply-api/sms/caremetric-inbound`.
   General replies direct the sender to phone/web support; this is not an AI SMS
   conversation or an inbox for patient information.
4. The API service uses `CAREMETRIC_PHONE_SMS_MESSAGING_SERVICE_SID` for this
   service and pins `From=+18775212890`. It never falls back to a tenant's
   `TWILIO_MESSAGING_SERVICE_SID`. Existing account credentials are reused.
5. Set `CAREMETRIC_PHONE_SMS_ENABLED=true` and deploy the API. Requests provide
   their own signed status-callback URL with an opaque request ID. The callback
   verifies Twilio signature, account, sender, identifier and terminal state.
6. Place a real inbound call and request a sample text to an explicitly
   authorized test mobile. Verify the originating number, content, actual
   delivered state and Hub phone-entry status; test STOP/HELP/START on that same
   authorized test recipient. Do not infer a test recipient from account data.

Only `delivered` permits the agent to say delivered. `accepted` means submitted,
with delivery unconfirmed; failures and ambiguous outcomes never trigger an
automatic retry. Status callbacks update conditional nonterminal rows so late
events cannot regress a terminal result. The Hub reads these states through its
existing native platform-admin authorization boundary, without provider SIDs.

Rollback: set `CAREMETRIC_PHONE_SMS_ENABLED=false` and redeploy. Voice support
and advisor message-taking continue; delivery callbacks can still settle
already submitted requests. Keep the consent/deduplication records.
