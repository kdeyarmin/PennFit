// Public types shared between sendReminderSms / sendReminderEmail and
// their callers (API routes, worker jobs).
//
// The two helpers return a tagged-union "outcome" rather than throwing.
// HTTP-level callers translate each outcome to a status code; worker
// callers log + audit on non-ok outcomes. This keeps the helpers pure
// (no Express coupling) while still surfacing every distinguishable
// failure mode the routes were already producing in inline form.

/**
 * Who initiated the send. Drives audit fields ONLY — the actor never
 * influences which patient/episode is selected (that's the caller's
 * responsibility) or which Twilio/SendGrid creds are used.
 */
export type SendActor =
  | {
      kind: "admin";
      adminEmail: string | null;
      adminUserId: string | null;
      ip: string | null;
      userAgent: string | null;
    }
  | {
      kind: "system";
      /**
       * pg-boss job id, surfaced into the audit metadata so admins
       * can trace a reminder back to the worker run that produced it.
       */
      jobId: string | null;
    };

/**
 * Subset of MessagingConfig the helpers actually need. We intentionally
 * do NOT depend on the api package's MessagingConfig type — the helper
 * package is shared with the worker, which has its own env reader.
 */
export interface SmsSendConfig {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber?: string;
  twilioMessagingServiceSid?: string;
  publicBaseUrl: string;
  practiceName: string;
}

export interface EmailSendConfig {
  sendgridApiKey: string;
  sendgridFromEmail: string;
  sendgridFromName: string;
  publicBaseUrl: string;
  practiceName: string;
}

export type SendReminderOutcome =
  | { status: "ok"; conversationId: string; vendorRef: string }
  | { status: "patient_not_found" }
  | { status: "patient_not_active"; patientStatus: string }
  | { status: "patient_missing_phone" }
  | { status: "patient_missing_email" }
  | { status: "patient_phone_unnormalizable" }
  /**
   * The patient's normalized phone number HMAC is already bound to a
   * DIFFERENT patient_id in `phone_lookup`. We refuse to reassign the
   * lookup row because doing so silently re-routes inbound SMS replies
   * (including STOP/HELP keywords AND order confirmations) to whichever
   * patient the admin most recently sent a reminder to.
   *
   * This is a data-quality conflict — two patients in the system
   * sharing the same phone number — that requires admin triage
   * before any reminder can go out. The send is aborted, an audit row
   * (`messaging.phone_lookup.conflict`) is written so the conflict
   * surfaces in the admin console, and the caller decides how to
   * surface it (HTTP 409 from the API, log + skip from the worker).
   */
  | {
      status: "phone_in_use_by_other_patient";
      existingPatientId: string;
    }
  | { status: "no_episode_for_patient" }
  | { status: "episode_not_found" }
  | { status: "episode_patient_mismatch" }
  | { status: "conversation_create_failed" }
  | { status: "vendor_config_error"; vendor: "sms_vendor" | "email_vendor" }
  | {
      status: "vendor_api_error";
      vendor: "sms_vendor" | "email_vendor";
      vendorStatus: number | null;
      vendorCode: string | null;
    };
