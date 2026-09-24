import { randomUUID } from "node:crypto";
import {
  getOrgScopedClient,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";
import {
  sendInfoSmsArgs,
  type ToolArgsByName,
  type SendInfoSmsResult,
} from "@workspace/resupply-ai";
import {
  createTwilioSmsClient,
  TwilioApiError,
  type TwilioSmsClient,
} from "@workspace/resupply-telecom";
import { logger } from "../logger";

export const CAREMETRIC_PHONE = "+18775212890";
export const CAREMETRIC_SMS_CONSENT_VERSION = "2026-09-24.one-time.v1";
export const CAREMETRIC_SMS_CONSENT_SCRIPT =
  "May CareMetric send the links and information you requested in one text to your confirmed mobile number? Message and data rates may apply. Reply STOP to opt out or HELP for help. This is optional and does not sign you up for recurring messages.";

// Only public, reviewed content. The model cannot supply a body, URL, account
// token, patient details, payment link, or an arbitrary third-party recipient list.
export const CAREMETRIC_SMS_RESOURCES = {
  support:
    "Support and customer service: https://support-hub-web-production.up.railway.app/help",
  software:
    "CareMetric software information: https://caremetricadvisors.com/software",
  advisors:
    "CareMetric Healthcare Advisors contact form: https://caremetricadvisors.com/contact",
  account_access:
    "Account access: open your app's sign-in page and use its recovery option if available. Never share passwords or verification codes. For help, call (877) 521-2890.",
  troubleshooting:
    "Support steps: save your work, check your connection, and reopen the affected page. If the issue continues, note the app, sanitized error, browser, and steps tried. Call (877) 521-2890. Do not send patient details.",
  breathe:
    "CareMetric Breathe information: https://caremetricadvisors.com/software/breathe",
} as const;

export function buildCareMetricSms(
  resources: ToolArgsByName["send_info_sms"]["resources"],
): string {
  return [
    "CareMetric: Here is the information you requested on our call.",
    ...resources.map((key) => CAREMETRIC_SMS_RESOURCES[key]),
    "Reply STOP to opt out; HELP for help. Msg & data rates may apply.",
  ].join("\n\n");
}

export function readCareMetricSmsConfig(env = process.env) {
  const serviceSid = env.CAREMETRIC_PHONE_SMS_MESSAGING_SERVICE_SID?.trim();
  if (
    env.CAREMETRIC_PHONE_SMS_ENABLED !== "true" ||
    !/^MG[0-9a-f]{32}$/i.test(serviceSid ?? "") ||
    !env.TWILIO_ACCOUNT_SID ||
    !env.TWILIO_AUTH_TOKEN
  )
    return null;
  return {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    messagingServiceSid: serviceSid!,
    from: CAREMETRIC_PHONE,
    // Signed callback URL must be identical at send and verification time.
    publicBaseUrl: "https://cmbreathe.com",
  };
}

interface SmsDeps {
  orgId: string;
  twilioCallSid?: string;
  supabase?: ResupplySupabaseClient;
  client?: TwilioSmsClient;
}

function resultForStatus(status: string): SendInfoSmsResult {
  if (status === "delivered") return { ok: true, status: "delivered" };
  if (status === "accepted") return { ok: true, status: "submitted" };
  if (status === "failed" || status === "undelivered")
    return { ok: false, status: "failed", reason: "delivery_failed" };
  return {
    ok: false,
    status: "unknown",
    reason: "send_not_confirmed_do_not_retry",
  };
}

/** Shared business line only; never resolves a tenant's messaging sender. */
export async function sendCareMetricPhoneSms(
  rawArgs: ToolArgsByName["send_info_sms"],
  deps: SmsDeps,
): Promise<SendInfoSmsResult> {
  const parsed = sendInfoSmsArgs.safeParse(rawArgs);
  if (!parsed.success)
    return {
      ok: false,
      status: "not_sent",
      reason: "confirmed_mobile_and_consent_required",
    };
  const args = parsed.data;
  const config = readCareMetricSmsConfig();
  if (!config)
    return { ok: false, status: "not_sent", reason: "texting_unavailable" };
  if (!/^CA[0-9a-f]{32}$/i.test(deps.twilioCallSid ?? ""))
    return { ok: false, status: "not_sent", reason: "live_call_required" };
  const db = getOrgScopedClient(deps.orgId, deps.supabase)
    .raw()
    .schema("resupply");
  const resources = [...new Set(args.resources)].sort();
  const id = randomUUID();
  try {
    const claim = await db.from("shared_phone_sms").insert({
      id,
      twilio_call_sid: deps.twilioCallSid,
      recipient: args.mobile,
      resources,
      consent_version: CAREMETRIC_SMS_CONSENT_VERSION,
      delivery_status: "submitting",
    });
    if (claim.error) {
      if (claim.error.code !== "23505") throw claim.error;
      const prior = await db
        .from("shared_phone_sms")
        .select("recipient, resources, delivery_status")
        .eq("twilio_call_sid", deps.twilioCallSid)
        .maybeSingle();
      if (prior.error || !prior.data)
        throw prior.error ?? new Error("Missing claim");
      if (
        prior.data.recipient !== args.mobile ||
        JSON.stringify(prior.data.resources) !== JSON.stringify(resources)
      )
        return {
          ok: false,
          status: "not_sent",
          reason: "one_followup_per_call",
        };
      return {
        ...resultForStatus(prior.data.delivery_status),
        already_requested: true,
      };
    }
  } catch {
    logger.warn(
      { event: "caremetric_sms_claim_failed" },
      "Text request could not be recorded",
    );
    return { ok: false, status: "not_sent", reason: "request_not_saved" };
  }

  let submittedResult: SendInfoSmsResult | undefined;
  // No automatic POST retries: a timeout can happen after Twilio accepts it.
  // Keep the durable claim even on failure; never imply a retry is safe.
  try {
    const client =
      deps.client ??
      createTwilioSmsClient({
        ...config,
        pinFrom: true,
        retry: { maxAttempts: 1 },
      });
    const sent = await client.sendSms({
      to: args.mobile,
      body: buildCareMetricSms(resources),
      statusCallbackUrl: `${config.publicBaseUrl}/resupply-api/sms/caremetric-status?id=${id}`,
    });
    submittedResult = { ok: true, status: "submitted" };
    const stamp = await db
      .from("shared_phone_sms")
      .update({
        twilio_message_sid: sent.messageSid,
        delivery_status: "accepted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("delivery_status", "submitting");
    if (stamp.error)
      logger.warn(
        { event: "caremetric_sms_stamp_failed", id },
        "Text accepted; status stamp failed",
      );
    const delivery = await client.confirmDelivery(sent.messageSid, {
      timeoutMs: 3500,
      pollIntervalMs: 1000,
    });
    if (delivery.terminal) {
      submittedResult = resultForStatus(delivery.status);
      await updateCareMetricSmsDelivery(
        deps.orgId,
        id,
        sent.messageSid,
        delivery.status,
        delivery.errorCode === null ? null : String(delivery.errorCode),
        deps.supabase,
      );
      return resultForStatus(delivery.status);
    }
    return { ok: true, status: "submitted" };
  } catch (err) {
    if (submittedResult) {
      logger.warn(
        { event: "caremetric_sms_tracking_failed", id },
        "Text submitted; delivery tracking degraded",
      );
      return submittedResult;
    }
    const definiteRejection =
      err instanceof TwilioApiError &&
      typeof err.status === "number" &&
      err.status >= 400 &&
      err.status < 500;
    const errorCode =
      err instanceof TwilioApiError && err.code != null
        ? String(err.code)
        : null;
    await db
      .from("shared_phone_sms")
      .update({
        delivery_status: definiteRejection ? "failed" : "unknown",
        error_code: errorCode,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("delivery_status", "submitting");
    logger.warn(
      { event: "caremetric_sms_send_unconfirmed", id, errorCode },
      "Text was not confirmed",
    );
    return {
      ok: false,
      status: definiteRejection ? "failed" : "unknown",
      reason:
        errorCode === "21610"
          ? "recipient_opted_out"
          : "send_not_confirmed_do_not_retry",
    };
  }
}

export async function updateCareMetricSmsDelivery(
  orgId: string,
  id: string,
  messageSid: string,
  status: string,
  errorCode: string | null,
  supabase?: ResupplySupabaseClient,
): Promise<void> {
  if (!["delivered", "failed", "undelivered"].includes(status)) return;
  const db = getOrgScopedClient(orgId, supabase).raw().schema("resupply");
  const { error } = await db
    .from("shared_phone_sms")
    .update({
      delivery_status: status,
      error_code: errorCode,
      twilio_message_sid: messageSid,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("delivery_status", ["submitting", "accepted", "unknown"])
    .or(`twilio_message_sid.is.null,twilio_message_sid.eq.${messageSid}`);
  if (error) throw error;
}
