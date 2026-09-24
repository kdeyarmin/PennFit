import { Router, type IRouter } from "express";
import { z } from "zod";
import { resolveSeedOrgId } from "@workspace/resupply-db";
import { requireTwilioSignature } from "@workspace/resupply-telecom";
import { logger } from "../../lib/logger";
import {
  CAREMETRIC_PHONE,
  CAREMETRIC_SMS_CONSENT_SCRIPT,
  CAREMETRIC_SMS_RESOURCES,
  readCareMetricSmsConfig,
  updateCareMetricSmsDelivery,
} from "../../lib/voice/caremetric-phone-sms";

const router: IRouter = Router();
const signature = requireTwilioSignature({
  getAuthToken: () => process.env.TWILIO_AUTH_TOKEN,
  buildPublicUrl: (req) => `https://cmbreathe.com${req.originalUrl ?? ""}`,
});
const emptyResponse = "<Response/>";
const formFields = z.record(z.string(), z.string());

router.post("/sms/caremetric-status", signature, async (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode, AccountSid, From } =
    formFields.safeParse(req.body).data ?? {};
  const id = req.query.id;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(id) ||
    typeof MessageSid !== "string" ||
    !/^SM[0-9a-f]{32}$/i.test(MessageSid) ||
    AccountSid !== process.env.TWILIO_ACCOUNT_SID ||
    From !== CAREMETRIC_PHONE ||
    typeof MessageStatus !== "string" ||
    !["delivered", "failed", "undelivered"].includes(MessageStatus)
  ) {
    res.status(200).type("text/xml").send(emptyResponse);
    return;
  }
  try {
    const orgId = await resolveSeedOrgId();
    if (!orgId) throw new Error("Platform context unavailable");
    await updateCareMetricSmsDelivery(
      orgId,
      id,
      MessageSid,
      MessageStatus,
      typeof ErrorCode === "string" && /^\d{1,8}$/.test(ErrorCode)
        ? ErrorCode
        : null,
    );
    res.status(200).type("text/xml").send(emptyResponse);
  } catch {
    logger.warn(
      { event: "caremetric_sms_callback_failed", id },
      "Delivery status was not saved",
    );
    // Retrying this conditional status update is safe. Do not acknowledge
    // persistence failure as success and silently discard delivery evidence.
    res.status(503).type("text/xml").send(emptyResponse);
  }
});

// Link follow-ups are not a second AI conversation or a patient intake inbox.
// Twilio handles STOP/START at the sender/service; never send another response
// after its OptOutType acknowledgement or try to override an opt-out.
router.post("/sms/caremetric-inbound", signature, (req, res) => {
  const { AccountSid, To, Body, OptOutType } =
    formFields.safeParse(req.body).data ?? {};
  if (
    !readCareMetricSmsConfig() ||
    AccountSid !== process.env.TWILIO_ACCOUNT_SID ||
    To !== CAREMETRIC_PHONE ||
    OptOutType ||
    /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT|START|UNSTOP|YES)$/i.test(
      String(Body ?? "").trim(),
    )
  ) {
    res.status(200).type("text/xml").send(emptyResponse);
    return;
  }
  res
    .status(200)
    .type("text/xml")
    .send(
      "<Response><Message>CareMetric: For software support, customer service, or Healthcare Advisors, call (877) 521-2890 or visit https://support-hub-web-production.up.railway.app/help. This text service sends requested public links; please do not text patient details, passwords, or codes. Reply STOP to opt out.</Message></Response>",
    );
});

// Public, non-sensitive evidence of the actual opt-in workflow for callers
// and the toll-free verification reviewer. No phone-number collection form.
router.get("/caremetric/texting", (_req, res) => {
  res.type("text/html")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CareMetric requested text follow-ups</title></head><body><main style="max-width:48rem;margin:3rem auto;padding:1rem;font:18px/1.6 system-ui;color:#172b3a">
<h1>CareMetric requested text follow-ups</h1>
<p>When texting is available, callers to <a href="tel:+18775212890">(877) 521-2890</a> can request public links or general information about CareMetric software support, customer service, or CareMetric Healthcare Advisors.</p>
<p>This is optional: one follow-up text per call, containing up to three requested resources. It does not enroll you in recurring texts. Message and data rates may apply. Reply STOP to opt out, HELP for help, or call (877) 521-2890. Carriers are not liable for delayed or undelivered messages.</p>
<h2>How we ask permission</h2><ol><li>You request the information you want.</li><li>You give a mobile number that belongs to you. Our AI phone assistant reads it back and waits for your confirmation.</li><li>The assistant asks: <blockquote>${CAREMETRIC_SMS_CONSENT_SCRIPT}</blockquote></li><li>Only after you confirm both the number and permission does the assistant submit your requested text. If you decline, you can still receive help by phone.</li></ol>
<p>We record the request, number confirmation, consent version and time, originating call, selected resources, and delivery status. Phone opt-in applies only to this requested follow-up, not marketing or patient reminders. Mobile numbers and SMS consent are not shared with third parties for their marketing.</p>
<h2>What can be sent</h2><ul>${Object.values(CAREMETRIC_SMS_RESOURCES)
    .map((s) => `<li>${s}</li>`)
    .join("")}</ul>
<p>Texts do not include private account information, patient health information, passwords, verification codes, payment information, clinical advice, or appointment confirmations. The Advisors contact link is not an appointment booking. To discuss a request, call us or use the appropriate contact form.</p>
<p><a href="https://caremetric.ai/privacy-policy">Privacy policy</a> · <a href="https://caremetric.ai/terms">Terms</a></p></main></body></html>`);
});

export default router;
