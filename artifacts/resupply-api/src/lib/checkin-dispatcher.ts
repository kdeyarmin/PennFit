// Multi-channel onboarding check-in dispatcher.
//
// Shared between the HTTP route (POST /admin/onboarding/send-due,
// CSR-initiated "Run now") and the pg-boss daily cron. Both call
// `dispatchDueCheckins()` with a `Pool` and an actor descriptor and
// receive the same summary shape.
//
// Per-patient logic:
//   1. Compute the next due day from the journey row + ONBOARDING_DAYS.
//   2. Resolve the channel order: patient.channel_preference first
//      (when set), then the remaining channels in the order
//      [email, sms, voice].
//   3. For each channel in order, attempt a send. Every attempt
//      (success, skip, vendor-error) is logged to
//      patient_checkin_attempts.
//   4. Stamp `dayN_sent_at` on the first success and stop trying
//      further channels for this day.
//   5. Day-90 success additionally transitions the journey to
//      'completed'.
//
// PHI / log posture: structural metadata only in audit envelopes —
// patient_id, day_label, channel, outcome, vendor_ref. No message
// bodies, no phone/email plaintext.

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  ONBOARDING_DAYS,
  type CheckinAttemptChannel,
  type Database,
  type OnboardingDayLabel,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";

type JourneyUpdate =
  Database["resupply"]["Tables"]["patient_onboarding_journeys"]["Update"];

import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioClient,
  createTwilioSmsClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "./logger";
import { withRetry } from "./with-retry";

export interface CheckinActor {
  /** "admin" when an authenticated CSR pressed Run-now; "system" when the cron fired. */
  kind: "admin" | "system";
  email?: string | null;
  userId?: string | null;
}

export interface DispatchOptions {
  /** Optional Supabase client. Defaults to the shared singleton. */
  supabase?: ResupplySupabaseClient;
  /** Defaults to `new Date()`. Tests pass a fixed clock. */
  asOf?: Date;
  /** Cap per-run sends to bound the cron's work. Default 50. */
  cap?: number;
  actor: CheckinActor;
  /** Optional override for the public base URL the voice TwiML lives on. */
  publicBaseUrl?: string;
}

export interface DispatchSummary {
  attempted: number;
  /** Journeys where at least one channel succeeded for the due day. */
  delivered: number;
  /** Journeys where every channel attempt failed (vendor errors). */
  failed: number;
  /** Journeys skipped because the patient has no contact for any channel. */
  skippedNoContact: number;
  completedJourneys: number;
  remaining: number;
}

interface JourneyRow {
  journeyId: string;
  patientId: string;
  startedAt: Date;
  day1SentAt: Date | null;
  day3SentAt: Date | null;
  day7SentAt: Date | null;
  day30SentAt: Date | null;
  day60SentAt: Date | null;
  day90SentAt: Date | null;
  firstName: string | null;
  email: string | null;
  phoneE164: string | null;
  channelPreference: "sms" | "email" | "voice" | null;
}

const DEFAULT_CAP = 50;
const ALL_CHANNELS: CheckinAttemptChannel[] = ["email", "sms", "voice"];

export async function dispatchDueCheckins(
  opts: DispatchOptions,
): Promise<DispatchSummary> {
  const now = opts.asOf ?? new Date();
  const cap = opts.cap ?? DEFAULT_CAP;
  const supabase = opts.supabase ?? getSupabaseServiceRoleClient();

  // PostgREST has no JOIN. Fetch active journeys + every patient we
  // need in two passes and stitch in JS.
  const { data: journeyRows, error: journeyErr } = await supabase
    .schema("resupply")
    .from("patient_onboarding_journeys")
    .select(
      "id, patient_id, started_at, day1_sent_at, day3_sent_at, day7_sent_at, day30_sent_at, day60_sent_at, day90_sent_at",
    )
    .eq("status", "active")
    .limit(500);
  if (journeyErr) throw journeyErr;
  const journeys = journeyRows ?? [];
  if (journeys.length === 0) {
    return {
      attempted: 0,
      delivered: 0,
      failed: 0,
      skippedNoContact: 0,
      completedJourneys: 0,
      remaining: 0,
    };
  }

  // .in() the patient_ids in chunks (URL-length safety).
  const patientIds = Array.from(new Set(journeys.map((j) => j.patient_id)));
  const patientById = new Map<
    string,
    {
      legal_first_name: string | null;
      email: string | null;
      phone_e164: string | null;
      channel_preference: string | null;
    }
  >();
  for (let i = 0; i < patientIds.length; i += 200) {
    const batch = patientIds.slice(i, i + 200);
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, email, phone_e164, channel_preference")
      .in("id", batch);
    if (error) throw error;
    for (const p of data ?? []) {
      patientById.set(p.id, {
        legal_first_name: p.legal_first_name,
        email: p.email,
        phone_e164: p.phone_e164,
        channel_preference: p.channel_preference,
      });
    }
  }

  const rows: JourneyRow[] = [];
  for (const j of journeys) {
    const p = patientById.get(j.patient_id);
    if (!p) continue;
    const channelPref = p.channel_preference;
    rows.push({
      journeyId: j.id,
      patientId: j.patient_id,
      startedAt: new Date(j.started_at),
      day1SentAt: j.day1_sent_at ? new Date(j.day1_sent_at) : null,
      day3SentAt: j.day3_sent_at ? new Date(j.day3_sent_at) : null,
      day7SentAt: j.day7_sent_at ? new Date(j.day7_sent_at) : null,
      day30SentAt: j.day30_sent_at ? new Date(j.day30_sent_at) : null,
      day60SentAt: j.day60_sent_at ? new Date(j.day60_sent_at) : null,
      day90SentAt: j.day90_sent_at ? new Date(j.day90_sent_at) : null,
      firstName: p.legal_first_name,
      email: p.email,
      phoneE164: p.phone_e164,
      channelPreference:
        channelPref === "sms" || channelPref === "email" || channelPref === "voice"
          ? channelPref
          : null,
    });
  }

  // Build clients lazily — a missing vendor secret should NOT block
  // attempts on other channels. We track availability so the per-row
  // loop emits `skipped_not_configured` rather than throwing.
  const clients = buildClients(opts.publicBaseUrl);

  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  let skippedNoContact = 0;
  const completed: string[] = [];

  for (const row of rows) {
    if (attempted >= cap) break;
    const due = nextDueCheckin(
      row.startedAt,
      {
        day1: row.day1SentAt,
        day3: row.day3SentAt,
        day7: row.day7SentAt,
        day30: row.day30SentAt,
        day60: row.day60SentAt,
        day90: row.day90SentAt,
      },
      now,
    );
    if (!due) continue;
    attempted++;

    const channelOrder = resolveChannelOrder(row.channelPreference);
    let succeeded = false;
    let anyVendorError = false;
    let anyContactAvailable = false;

    for (const channel of channelOrder) {
      const result = await attemptChannel({
        supabase,
        clients,
        row,
        day: due,
        channel,
        actor: opts.actor,
        asOf: now,
      });

      if (result === "no_contact") continue;
      anyContactAvailable = true;
      if (result === "not_configured") continue;
      if (result === "vendor_error") {
        anyVendorError = true;
        continue;
      }
      // success
      succeeded = true;
      break;
    }

    if (succeeded) {
      const stampField = stampFieldForDay(due);
      const nowIso = now.toISOString();
      const update: JourneyUpdate = {
        [stampField]: nowIso,
        updated_at: nowIso,
      };
      if (due === "day90") update.status = "completed";
      // Conditional stamp: only writes if the column is still null,
      // so a concurrent dispatcher run can't re-stamp.
      const { error: updateErr } = await supabase
        .schema("resupply")
        .from("patient_onboarding_journeys")
        .update(update)
        .eq("id", row.journeyId)
        .is(stampField, null);
      if (updateErr) {
        logger.warn(
          {
            err: updateErr,
            journey_id: row.journeyId,
            day_label: due,
          },
          "patient_onboarding_journeys update failed",
        );
      }
      if (due === "day90") {
        completed.push(row.journeyId);
        await safeAudit(opts.actor, {
          action: "patient.onboarding.complete",
          targetTable: "patient_onboarding_journeys",
          targetId: row.journeyId,
          metadata: { patient_id: row.patientId },
        });
      }
      delivered++;
    } else if (!anyContactAvailable) {
      skippedNoContact++;
    } else if (anyVendorError) {
      failed++;
    }
  }

  return {
    attempted,
    delivered,
    failed,
    skippedNoContact,
    completedJourneys: completed.length,
    remaining: rows.length > attempted ? rows.length - attempted : 0,
  };
}

// ───────────────────────────────────────────────────────────────────
// Per-channel attempt
// ───────────────────────────────────────────────────────────────────

interface AttemptInput {
  supabase: ResupplySupabaseClient;
  clients: BuiltClients;
  row: JourneyRow;
  day: OnboardingDayLabel;
  channel: CheckinAttemptChannel;
  actor: CheckinActor;
  asOf: Date;
}

type AttemptResult = "ok" | "no_contact" | "not_configured" | "vendor_error";

async function attemptChannel(input: AttemptInput): Promise<AttemptResult> {
  const { supabase, clients, row, day, channel, actor, asOf } = input;

  let outcome: AttemptResult;
  let vendorRef: string | null;
  let errorCode: string | null;

  try {
    if (channel === "email") {
      ({ outcome, vendorRef, errorCode } = await sendEmail(
        clients,
        row,
        day,
      ));
    } else if (channel === "sms") {
      ({ outcome, vendorRef, errorCode } = await sendSms(clients, row, day));
    } else {
      ({ outcome, vendorRef, errorCode } = await placeVoiceCall(
        clients,
        row,
        day,
        asOf,
      ));
    }
  } catch (err) {
    // Unexpected (non-vendor) failure — log + treat as vendor_error so
    // downstream channels still get a shot.
    logger.warn(
      { err, journey_id: row.journeyId, day_label: day, channel },
      "checkin attempt threw",
    );
    outcome = "vendor_error";
    vendorRef = null;
    errorCode = "unexpected";
  }

  // Persist attempt row. Best-effort — failure here MUST NOT abort the
  // run (if it did, a transient DB blip would silently skip a day's
  // worth of patients).
  const persistedOutcome =
    outcome === "ok"
      ? "sent"
      : outcome === "no_contact"
        ? "skipped_no_contact"
        : outcome === "not_configured"
          ? "skipped_not_configured"
          : "vendor_error";
  try {
    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_checkin_attempts")
      .insert({
        journey_id: row.journeyId,
        patient_id: row.patientId,
        day_label: day,
        channel,
        outcome: persistedOutcome,
        vendor_ref: vendorRef,
        error_code: errorCode,
      });
    if (insertErr) {
      logger.warn(
        {
          err: insertErr,
          journey_id: row.journeyId,
          day_label: day,
          channel,
        },
        "patient_checkin_attempts insert failed",
      );
    }
  } catch (err) {
    logger.warn(
      { err, journey_id: row.journeyId, day_label: day, channel },
      "patient_checkin_attempts insert failed",
    );
  }

  await safeAudit(actor, {
    action: "patient.onboarding.checkin_sent",
    targetTable: "patient_onboarding_journeys",
    targetId: row.journeyId,
    metadata: {
      patient_id: row.patientId,
      day_label: day,
      channel,
      outcome:
        outcome === "ok"
          ? "sent"
          : outcome === "no_contact"
            ? "skipped_no_contact"
            : outcome === "not_configured"
              ? "skipped_not_configured"
              : "vendor_error",
      ...(errorCode ? { error_code: errorCode } : {}),
    },
  });

  return outcome;
}

// ───────────────────────────────────────────────────────────────────
// Channel senders
// ───────────────────────────────────────────────────────────────────

async function sendEmail(
  clients: BuiltClients,
  row: JourneyRow,
  day: OnboardingDayLabel,
): Promise<{
  outcome: AttemptResult;
  vendorRef: string | null;
  errorCode: string | null;
}> {
  if (!row.email) {
    return { outcome: "no_contact", vendorRef: null, errorCode: null };
  }
  if (!clients.sg) {
    return { outcome: "not_configured", vendorRef: null, errorCode: null };
  }
  const greeting = greetingFor(row.firstName);
  try {
    const r = await clients.sg.sendEmail({
      to: row.email,
      subject: subjectForDay(day),
      text: textBodyForDay(day, greeting),
      html: htmlBodyForDay(day, greeting),
      customArgs: { kind: "onboarding_checkin", day },
    });
    return {
      outcome: "ok",
      vendorRef: r?.messageId ?? null,
      errorCode: null,
    };
  } catch (err) {
    return {
      outcome: "vendor_error",
      vendorRef: null,
      errorCode: "sendgrid:" + ((err as Error).name ?? "error"),
    };
  }
}

async function sendSms(
  clients: BuiltClients,
  row: JourneyRow,
  day: OnboardingDayLabel,
): Promise<{
  outcome: AttemptResult;
  vendorRef: string | null;
  errorCode: string | null;
}> {
  if (!row.phoneE164) {
    return { outcome: "no_contact", vendorRef: null, errorCode: null };
  }
  if (!clients.sms) {
    return { outcome: "not_configured", vendorRef: null, errorCode: null };
  }
  try {
    // Retry on 5xx / network failures only. 4xx errors from Twilio
    // (invalid number, opted-out destination, blocked content) are
    // permanent — replays would just stack identical failures and
    // burn opt-out reputation. TwilioApiError without a status is a
    // network-level failure (DNS / TLS / undici timeout) and is
    // worth retrying once.
    const r = await withRetry(
      () =>
        clients.sms!.client.sendSms({
          to: row.phoneE164!,
          body: smsBodyForDay(day, greetingFor(row.firstName)),
          // No status callback URL — onboarding SMS attempts are tracked
          // in patient_checkin_attempts, not the conversations table.
          statusCallbackUrl: "",
        }),
      {
        attempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 1_500,
        isRetriable: (err) => {
          if (err instanceof TwilioApiError) {
            return err.status === undefined || err.status >= 500;
          }
          // TwilioConfigError is permanent — propagate.
          if (err instanceof TwilioConfigError) return false;
          // Other errors (network / undici / DNS) — retry once.
          return true;
        },
      },
    );
    return {
      outcome: "ok",
      vendorRef: r.messageSid,
      errorCode: null,
    };
  } catch (err) {
    if (err instanceof TwilioApiError) {
      return {
        outcome: "vendor_error",
        vendorRef: null,
        errorCode: `twilio:${err.code ?? err.status ?? "error"}`,
      };
    }
    if (err instanceof TwilioConfigError) {
      return { outcome: "not_configured", vendorRef: null, errorCode: null };
    }
    throw err;
  }
}

async function placeVoiceCall(
  clients: BuiltClients,
  row: JourneyRow,
  day: OnboardingDayLabel,
  asOf: Date,
): Promise<{
  outcome: AttemptResult;
  vendorRef: string | null;
  errorCode: string | null;
}> {
  if (!row.phoneE164) {
    return { outcome: "no_contact", vendorRef: null, errorCode: null };
  }
  if (!clients.voice) {
    return { outcome: "not_configured", vendorRef: null, errorCode: null };
  }
  // Quiet-hours guard: never auto-dial outside the patient-facing
  // call window. We don't have per-patient timezone yet, so we use
  // America/New_York as a defensible default for our US-East patient
  // base. A patient who'd rather we call earlier/later sets
  // `channel_preference='voice'` and waits for a CSR-driven manual
  // call from /voice/place-call instead.
  if (!isWithinCallWindow(asOf)) {
    return {
      outcome: "not_configured",
      vendorRef: null,
      errorCode: "quiet_hours",
    };
  }
  try {
    // Same retry posture as sendSms above — 5xx + network failures
    // get up to 3 attempts; 4xx (invalid number, blocked, opt-out)
    // is permanent.
    const r = await withRetry(
      () =>
        clients.voice!.client.placeCall({
          to: row.phoneE164!,
          from: clients.voice!.from,
          // Public TwiML endpoint — Twilio fetches this when the callee
          // answers. We pass `day` AND `patientId` so the press-1 callback
          // can attribute the manual alert to the right patient without
          // touching the database first.
          url: `${clients.voice!.publicBaseUrl}/voice/checkin-twiml?day=${encodeURIComponent(day)}&patientId=${encodeURIComponent(row.patientId)}&journeyId=${encodeURIComponent(row.journeyId)}`,
          statusCallbackUrl: `${clients.voice!.publicBaseUrl}/voice/status-callback`,
          record: false,
          timeLimit: 120,
        }),
      {
        attempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 1_500,
        isRetriable: (err) => {
          if (err instanceof TwilioApiError) {
            return err.status === undefined || err.status >= 500;
          }
          if (err instanceof TwilioConfigError) return false;
          return true;
        },
      },
    );
    return { outcome: "ok", vendorRef: r.sid, errorCode: null };
  } catch (err) {
    if (err instanceof TwilioApiError) {
      return {
        outcome: "vendor_error",
        vendorRef: null,
        errorCode: `twilio:${err.code ?? err.status ?? "error"}`,
      };
    }
    if (err instanceof TwilioConfigError) {
      return { outcome: "not_configured", vendorRef: null, errorCode: null };
    }
    throw err;
  }
}

/**
 * 9am-7pm ET, Monday-Saturday. Sunday is excluded because patients
 * tend to ignore unfamiliar Sunday calls and FCC quiet-hours rules
 * are stricter on weekends. Exported for tests.
 */
export function isWithinCallWindow(
  now: Date,
  timeZone = "America/New_York",
): boolean {
  // Intl.DateTimeFormat exposes the wall-clock parts in the requested
  // zone without us having to ship a tz-conversion library.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = parseInt(hourStr, 10);
  if (weekday === "Sun") return false;
  return hour >= 9 && hour < 19;
}

// ───────────────────────────────────────────────────────────────────
// Channel order resolution
// ───────────────────────────────────────────────────────────────────

function resolveChannelOrder(
  pref: "sms" | "email" | "voice" | null,
): CheckinAttemptChannel[] {
  if (!pref) return ALL_CHANNELS;
  return [pref, ...ALL_CHANNELS.filter((c) => c !== pref)];
}

// ───────────────────────────────────────────────────────────────────
// Vendor client construction (lazy, fault-tolerant)
// ───────────────────────────────────────────────────────────────────

interface BuiltClients {
  sg: ReturnType<typeof createSendgridClient> | null;
  sms: { client: ReturnType<typeof createTwilioSmsClient> } | null;
  voice: {
    client: ReturnType<typeof createTwilioClient>;
    from: string;
    publicBaseUrl: string;
  } | null;
}

function buildClients(publicBaseUrlOverride?: string): BuiltClients {
  let sg: BuiltClients["sg"] = null;
  try {
    sg = createSendgridClient();
  } catch (err) {
    if (!(err instanceof EmailConfigError)) {
      logger.warn({ err }, "sendgrid client construction failed");
    }
  }

  let sms: BuiltClients["sms"] = null;
  const accountSid = process.env["TWILIO_ACCOUNT_SID"];
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  const phoneNumber = process.env["TWILIO_PHONE_NUMBER"];
  const messagingServiceSid = process.env["TWILIO_MESSAGING_SERVICE_SID"];
  if (accountSid && authToken && (phoneNumber || messagingServiceSid)) {
    try {
      sms = {
        client: createTwilioSmsClient({
          accountSid,
          authToken,
          from: phoneNumber,
          messagingServiceSid,
        }),
      };
    } catch (err) {
      if (!(err instanceof TwilioConfigError)) {
        logger.warn({ err }, "twilio sms client construction failed");
      }
    }
  }

  let voice: BuiltClients["voice"] = null;
  const publicBaseUrl =
    publicBaseUrlOverride ??
    process.env["RESUPPLY_VOICE_PUBLIC_BASE_URL"] ??
    (process.env["REPLIT_DEV_DOMAIN"]
      ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
      : "");
  if (accountSid && authToken && phoneNumber && publicBaseUrl) {
    try {
      voice = {
        client: createTwilioClient({ accountSid, authToken }),
        from: phoneNumber,
        publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
      };
    } catch (err) {
      if (!(err instanceof TwilioConfigError)) {
        logger.warn({ err }, "twilio voice client construction failed");
      }
    }
  }

  return { sg, sms, voice };
}

// ───────────────────────────────────────────────────────────────────
// Pure helpers (exported for the route + tests)
// ───────────────────────────────────────────────────────────────────

export function nextDueCheckin(
  startedAt: Date,
  sent: Record<OnboardingDayLabel, Date | null>,
  now: Date,
): OnboardingDayLabel | null {
  const startedMs = startedAt.getTime();
  for (const { label, offsetDays } of ONBOARDING_DAYS) {
    if (sent[label]) continue;
    const dueAt = startedMs + offsetDays * 24 * 60 * 60 * 1000;
    if (now.getTime() >= dueAt) return label;
    return null;
  }
  return null;
}

export function stampFieldForDay(label: OnboardingDayLabel): string {
  switch (label) {
    case "day1":
      return "day1SentAt";
    case "day3":
      return "day3SentAt";
    case "day7":
      return "day7SentAt";
    case "day30":
      return "day30SentAt";
    case "day60":
      return "day60SentAt";
    case "day90":
      return "day90SentAt";
  }
}

export function subjectForDay(label: OnboardingDayLabel): string {
  switch (label) {
    case "day1":
    case "day3":
      return "Quick check-in — first few days of therapy";
    case "day7":
      return "How's your first week going?";
    case "day30":
      return "30 days in — here's what helps most";
    case "day60":
      return "60 days in — staying on track";
    case "day90":
      return "90-day check-in from PennPaps";
  }
}

export function textBodyForDay(
  label: OnboardingDayLabel,
  greeting: string,
): string {
  switch (label) {
    case "day1":
    case "day3":
      return `${greeting},\n\nYou're a few days into therapy — this is the window where most patients hit their first comfort issue. Common day-3 fixes:\n* Mask leaks at the corners → tighten the lower headgear strap first.\n* Air feels too strong → look for the "ramp" button; it ramps up over 20 minutes.\n* Dry mouth → if your machine has a humidifier, set it to 3 and adjust.\n\nReply to this email if anything is uncomfortable. We answer within a business day.\n\n— PennPaps customer service\n`;
    case "day7":
      return `${greeting},\n\nA week in. Most patients hit at least one comfort issue by day 7 — common ones are mask seal at the corner of the mouth, ramp pressure feeling too low, and waking up with a dry mouth.\n\nQuick triage:\n1. Refit the mask while the machine is running (so you can hear leaks).\n2. Bump humidifier one notch.\n3. If the ramp is too short, lengthen it from the menu.\n\nIf you'd rather talk to a human, reply to this email.\n\n— PennPaps customer service\n`;
    case "day30":
      return `${greeting},\n\n30 days in. By now you've felt the better-rest payoff — and you might be due for a fresh cushion. Cushion seal degrades over the first month and replacing it makes the next month dramatically easier.\n\nIf you have insurance through us, your replacement is already eligible. Reply YES and we'll ship a fresh one.\n\n— PennPaps customer service\n`;
    case "day60":
      return `${greeting},\n\n60 days in — the biggest predictor of long-term success is staying consistent through the post-acclimation slump. If usage has dipped recently, a quick re-fit of the mask is the single highest-impact thing you can do this week.\n\nReply to this email if anything has changed (mask discomfort, dry mouth, machine noise) — we can usually solve it in one call.\n\n— PennPaps customer service\n`;
    case "day90":
      return `${greeting},\n\nYou've made it to 90 days — the threshold most patients miss. Insurance now considers you adherent and most plans renew supply eligibility automatically.\n\nWe'll keep an eye on your supply schedule and ship replacements before they're due. If you've been struggling, reply to this email and we'll set up a call with one of our therapists.\n\n— PennPaps customer service\n`;
  }
}

export function htmlBodyForDay(
  label: OnboardingDayLabel,
  greeting: string,
): string {
  const safeGreeting = greeting.replace(/[<>&]/g, "");
  const heading = subjectForDay(label);
  const paragraphs = textBodyForDay(label, safeGreeting)
    .split("\n\n")
    .map(
      (p) =>
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#0a1f44;">${p
          .replace(/[<>&]/g, "")
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background: #f8fafc; padding: 24px;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
      <h2 style="margin:0 0 16px;color:#0a1f44;font-size:18px;">${heading}</h2>
      ${paragraphs}
    </td></tr>
  </table>
</body></html>`;
}

export function smsBodyForDay(
  label: OnboardingDayLabel,
  greeting: string,
): string {
  // SMS bodies are intentionally short (<160 chars where possible) so
  // they render as a single segment on most carriers.
  switch (label) {
    case "day1":
    case "day3":
      return `${greeting}, this is PennPaps. You're a few days into therapy — common early issues are mask leaks and dry mouth. Reply HELP if anything is uncomfortable.`;
    case "day7":
      return `${greeting}, PennPaps here — one week in! Most patients hit a comfort issue by now. Reply HELP and we'll triage.`;
    case "day30":
      return `${greeting}, PennPaps — you're 30 days in. Cushion seals degrade fast in the first month; reply YES for a replacement on file.`;
    case "day60":
      return `${greeting}, PennPaps — 60 day check-in. If usage has dipped, reply HELP and we'll re-fit your mask.`;
    case "day90":
      return `${greeting}, PennPaps — 90 days! You've cleared the adherence threshold. Reply HELP if you'd like a follow-up call.`;
  }
}

export function voiceScriptForDay(label: OnboardingDayLabel): string {
  // Read aloud by Twilio's <Say> verb. Keep under ~30 seconds.
  switch (label) {
    case "day1":
    case "day3":
      return "Hi, this is an automated check-in from Penn Paps. You are a few days into your therapy. Most patients run into a comfort issue this week. If anything feels off — mask leaks, dry mouth, or pressure feeling too strong — please call us back, or reply to the text message we just sent. Thank you.";
    case "day7":
      return "Hi, this is an automated check-in from Penn Paps. You are one week into your therapy. If you are running into any issues with comfort, mask seal, or the machine itself, please call us back. We can usually resolve it in a single call. Thank you.";
    case "day30":
      return "Hi, this is an automated check-in from Penn Paps. You are 30 days into your therapy. You may be due for a fresh mask cushion. Please call us back to confirm a replacement, or reply yes to the text message we just sent. Thank you.";
    case "day60":
      return "Hi, this is an automated check-in from Penn Paps. You are 60 days into your therapy. If your usage has dipped recently, a quick mask refit is usually the fix. Please call us back if anything has changed. Thank you.";
    case "day90":
      return "Hi, this is an automated check-in from Penn Paps. Congratulations — you are 90 days into your therapy. Insurance now considers you adherent. If you would like a follow-up call with one of our therapists, please call us back. Thank you.";
  }
}

function greetingFor(firstName: string | null): string {
  if (!firstName) return "Hi";
  const first = firstName.split(/\s+/)[0] ?? "";
  return first ? `Hi ${first}` : "Hi";
}

// ───────────────────────────────────────────────────────────────────
// Audit helper — never throws.
// ───────────────────────────────────────────────────────────────────

async function safeAudit(
  actor: CheckinActor,
  payload: {
    action: string;
    targetTable: string;
    targetId: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await logAudit({
      action: payload.action,
      adminEmail: actor.kind === "admin" ? (actor.email ?? null) : null,
      adminUserId: actor.kind === "admin" ? (actor.userId ?? null) : null,
      targetTable: payload.targetTable,
      targetId: payload.targetId,
      metadata: payload.metadata,
      ip: null,
      userAgent: null,
    });
  } catch (err) {
    logger.warn({ err, action: payload.action }, "audit write failed");
  }
}
