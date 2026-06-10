// Proactive clinical outreach (RT #23).
//
// Reach patients with an open non-adherence intervention (#21) using a
// short, supportive, templated nudge tuned to the assessment category —
// email (preferred) or SMS. Authorized outward contact, so it carries the
// full guardrail set:
//
//   * Consent + DND — `outreachChannelAllowed` mirrors the established
//     smart-trigger clinical-nudge policy EXACTLY: DND always blocks;
//     a patient with no prefs row is allowed (never had a chance to opt
//     out); otherwise the channel's marketing opt-in must be true.
//   * Frequency cap — skip any patient contacted within the cap window
//     (looked up from clinical_outreach_log).
//   * One From address — email funnels through createSendgridClient.
//   * Opt-out — SMS carries "Reply STOP"; the cap + marketing gate honour
//     prior opt-outs.
//   * No PHI in logs — category + channel + status only; never the body,
//     the patient name, or the contact.

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  getSupabaseServiceRoleClient,
  type CommunicationPreferences,
  type Json,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  DEFAULT_SENDGRID_FROM_EMAIL,
} from "@workspace/resupply-email";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { isInDndWindow, type DndOptions } from "../comm-prefs";
import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface OutreachMessagingConfig {
  sendgridApiKey: string | null;
  sendgridFromEmail: string;
  sendgridFromName: string | null;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioPhoneNumber: string | null;
  twilioMessagingServiceSid: string | null;
  practiceName: string;
}

export function readOutreachMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): OutreachMessagingConfig {
  return {
    sendgridApiKey: env.SENDGRID_API_KEY ?? null,
    sendgridFromEmail:
      env.SENDGRID_FROM_EMAIL?.trim() || DEFAULT_SENDGRID_FROM_EMAIL,
    sendgridFromName: env.SENDGRID_FROM_NAME ?? null,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? null,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? null,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER ?? null,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID ?? null,
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? "PennPaps",
  };
}

export function readOutreachPrefs(
  raw: Json | null,
): CommunicationPreferences | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    ...DEFAULT_COMMUNICATION_PREFERENCES,
    ...(raw as Partial<CommunicationPreferences>),
  };
}

export type OutreachChannel = "email" | "sms";

/**
 * Pure: is this channel allowed for a proactive clinical nudge? Mirrors
 * `smartTriggerChannelAllowed` exactly — DND always blocks; null prefs
 * (no shop_customers row) → allowed; else the channel's marketing opt-in
 * must be true. `prefs === null` means "no preferences on file".
 */
export function outreachChannelAllowed(
  prefs: CommunicationPreferences | null,
  channel: OutreachChannel,
  now: Date = new Date(),
  opts: DndOptions = {},
): boolean {
  const effective = prefs ?? DEFAULT_COMMUNICATION_PREFERENCES;
  if (isInDndWindow(effective, now, opts)) return false;
  if (!prefs) return true;
  return channel === "email" ? prefs.emailMarketing : prefs.smsMarketing;
}

export interface ContactAvailability {
  hasEmail: boolean;
  hasPhone: boolean;
}

export interface ChannelPick {
  channel: OutreachChannel | null;
  reason: string;
}

/** Pure: prefer email, fall back to SMS, honour the consent/DND policy. */
export function pickOutreachChannel(
  prefs: CommunicationPreferences | null,
  contact: ContactAvailability,
  now: Date = new Date(),
  opts: DndOptions = {},
): ChannelPick {
  const emailOk =
    contact.hasEmail && outreachChannelAllowed(prefs, "email", now, opts);
  const smsOk =
    contact.hasPhone && outreachChannelAllowed(prefs, "sms", now, opts);
  if (emailOk) return { channel: "email", reason: "ok" };
  if (smsOk) return { channel: "sms", reason: "ok" };
  if (!contact.hasEmail && !contact.hasPhone) {
    return { channel: null, reason: "no_contact_channels" };
  }
  return { channel: null, reason: "opted_out_or_dnd" };
}

export interface OutreachMessage {
  subject: string;
  body: string;
}

// Per-assessment-category message. Supportive, non-clinical-advice,
// PHI-free. The category comes from #21's assessment_category taxonomy.
const CATEGORY_BODY: Record<string, string> = {
  mask_leak:
    "We noticed your therapy could be more comfortable. Mask leaks are common and usually an easy fix — a quick adjustment or a different cushion size often does it. Reply or call and we'll help you get a better seal.",
  mask_discomfort:
    "If your mask hasn't felt quite right, you're not alone — and it's fixable. Reply or give us a call and we'll help you dial in the fit.",
  claustrophobia:
    "Feeling boxed in by the mask is more common than you'd think, and there are gentle ways to ease into it. Reply and we'll share a few tips that help.",
  pressure_intolerance:
    "If the air pressure has felt like too much, there are comfort settings that can help. Reply or call and we'll walk through them with you.",
  congestion:
    "Stuffy nose making therapy harder? A few simple changes often help a lot. Reply and we'll point you in the right direction.",
  mouth_breathing:
    "If you're waking with a dry mouth, a small change to your setup can make a big difference. Reply and we'll help.",
  motivation:
    "Sticking with therapy is the hard part — and it's worth it. We're here to help you keep going. Reply anytime with questions.",
  travel_disruption:
    "Travel can throw off your routine. We can help you stay on track on the road — reply and we'll share a few tips.",
  other:
    "We're checking in on your therapy. If anything's getting in the way, reply or give us a call — we're here to help.",
};

/** Pure: build the outreach message for an assessment category. */
export function buildOutreachMessage(
  category: string | null,
  practiceName: string,
): OutreachMessage {
  const body = CATEGORY_BODY[category ?? "other"] ?? CATEGORY_BODY.other!;
  return {
    subject: `A quick check-in from ${practiceName}`,
    body,
  };
}

export interface OutreachTarget {
  patientId: string;
  interventionEncounterId: string | null;
  assessmentCategory: string | null;
}

export interface SelectOpts {
  cap: number;
  minHoursBetweenOutreach: number;
  asOf?: string;
}

/**
 * Pure: from open interventions, pick patients to contact this run —
 * drop any contacted within the frequency-cap window, de-dupe per
 * patient (one outreach per patient per run), cap the batch.
 */
export function selectOutreachTargets(
  openInterventions: readonly OutreachTarget[],
  lastOutreachByPatient: ReadonlyMap<string, string>,
  opts: SelectOpts,
): OutreachTarget[] {
  const nowMs = opts.asOf ? Date.parse(opts.asOf) : Date.now();
  const baseMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
  const windowMs = Math.max(0, opts.minHoursBetweenOutreach) * 3_600_000;

  const seen = new Set<string>();
  const out: OutreachTarget[] = [];
  for (const t of openInterventions) {
    if (seen.has(t.patientId)) continue; // one per patient per run
    const last = lastOutreachByPatient.get(t.patientId);
    if (last) {
      const lastMs = Date.parse(last);
      if (!Number.isNaN(lastMs) && baseMs - lastMs < windowMs) continue;
    }
    seen.add(t.patientId);
    out.push(t);
    if (out.length >= Math.max(0, opts.cap)) break;
  }
  return out;
}

export type OutreachOutcome =
  | { kind: "sent"; channel: OutreachChannel }
  | { kind: "failed"; channel: OutreachChannel; reason: string }
  | { kind: "skipped"; reason: string };

export interface OutreachDeps {
  cfg?: OutreachMessagingConfig;
  sendEmail?: (to: string, subject: string, body: string) => Promise<void>;
  sendSms?: (to: string, body: string) => Promise<void>;
  now?: Date;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Load one patient's contact + prefs, pick a consented channel, send the
 * category-templated nudge, and log the outcome. Fail-soft — returns the
 * outcome, never throws for a normal gated/failed send.
 */
export async function sendOneOutreach(
  supabase: SupabaseClient,
  target: OutreachTarget,
  deps: OutreachDeps = {},
): Promise<OutreachOutcome> {
  const cfg = deps.cfg ?? readOutreachMessagingConfig();
  const now = deps.now ?? new Date();

  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("email, phone_e164, address")
    .eq("id", target.patientId)
    .limit(1)
    .maybeSingle();
  const email = (patient?.email as string | null) ?? null;
  const phoneE164 = (patient?.phone_e164 as string | null) ?? null;
  const zip = ((patient?.address as { zip?: string } | null)?.zip ?? null) as
    | string
    | null;

  let prefs: CommunicationPreferences | null = null;
  if (email) {
    const { data: cust } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("communication_preferences")
      .eq("email_lower", email.toLowerCase())
      .limit(1)
      .maybeSingle();
    prefs = readOutreachPrefs(
      (cust?.communication_preferences ?? null) as Json | null,
    );
  }

  const pick = pickOutreachChannel(
    prefs,
    { hasEmail: !!email, hasPhone: !!phoneE164 },
    now,
    { shippingZip: zip },
  );

  let outcome: OutreachOutcome;
  if (!pick.channel) {
    outcome = { kind: "skipped", reason: pick.reason };
  } else {
    const msg = buildOutreachMessage(
      target.assessmentCategory,
      cfg.practiceName,
    );
    outcome = await deliver(pick.channel, { email, phoneE164 }, msg, cfg, deps);
  }

  const { error: outreachLogErr } = await supabase
    .schema("resupply")
    .from("clinical_outreach_log")
    .insert({
      patient_id: target.patientId,
      intervention_encounter_id: target.interventionEncounterId,
      channel:
        "channel" in outcome ? outcome.channel : (pick.channel ?? "email"),
      message_category: target.assessmentCategory,
      status: outcome.kind,
      error: outcome.kind === "failed" ? outcome.reason.slice(0, 500) : null,
    } as never);
  if (outreachLogErr) {
    logger.warn(
      { err: outreachLogErr.message, patientId: target.patientId },
      "clinical-outreach: outreach log insert failed (non-fatal)",
    );
  }

  logger.info(
    {
      event: "clinical.outreach.send",
      category: target.assessmentCategory,
      channel: "channel" in outcome ? outcome.channel : null,
      status: outcome.kind,
    },
    "clinical.outreach.send",
  );
  return outcome;
}

async function deliver(
  channel: OutreachChannel,
  contact: { email: string | null; phoneE164: string | null },
  msg: OutreachMessage,
  cfg: OutreachMessagingConfig,
  deps: OutreachDeps,
): Promise<OutreachOutcome> {
  if (channel === "email") {
    if (!contact.email || !cfg.sendgridApiKey || !cfg.sendgridFromName) {
      return { kind: "skipped", reason: "email_channel_unconfigured" };
    }
    try {
      if (deps.sendEmail) {
        await deps.sendEmail(contact.email, msg.subject, msg.body);
      } else {
        const client = createSendgridClient({
          apiKey: cfg.sendgridApiKey,
          fromEmail: cfg.sendgridFromEmail,
          fromName: cfg.sendgridFromName,
        });
        await client.sendEmail({
          to: contact.email,
          subject: msg.subject,
          html: `<p>${escapeHtml(msg.body)}</p>`,
          text: msg.body,
        });
      }
      return { kind: "sent", channel: "email" };
    } catch (err) {
      return {
        kind: "failed",
        channel: "email",
        reason: err instanceof Error ? err.message : "sendgrid_unknown",
      };
    }
  }

  if (
    !contact.phoneE164 ||
    !cfg.twilioAccountSid ||
    !cfg.twilioAuthToken ||
    !(cfg.twilioPhoneNumber || cfg.twilioMessagingServiceSid)
  ) {
    return { kind: "skipped", reason: "sms_channel_unconfigured" };
  }
  const smsBody =
    `${cfg.practiceName}: ${msg.body} Reply STOP to opt out.`.slice(0, 320);
  try {
    if (deps.sendSms) {
      await deps.sendSms(contact.phoneE164, smsBody);
    } else {
      const client = createTwilioSmsClient({
        accountSid: cfg.twilioAccountSid,
        authToken: cfg.twilioAuthToken,
        from: cfg.twilioPhoneNumber ?? undefined,
        messagingServiceSid: cfg.twilioMessagingServiceSid ?? undefined,
      });
      await client.sendSms({ to: contact.phoneE164, body: smsBody });
    }
    return { kind: "sent", channel: "sms" };
  } catch (err) {
    return {
      kind: "failed",
      channel: "sms",
      reason: err instanceof Error ? err.message : "twilio_unknown",
    };
  }
}

export interface OutreachBatchOpts {
  cap?: number;
  minHoursBetweenOutreach?: number;
}

export interface OutreachBatchResult {
  openInterventions: number;
  selected: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Load open interventions → frequency-cap map → select → send each.
 * Fail-soft per patient.
 */
export async function runClinicalOutreachBatch(
  opts: OutreachBatchOpts = {},
  deps: OutreachDeps = {},
): Promise<OutreachBatchResult> {
  const supabase = getSupabaseServiceRoleClient();
  const cap = opts.cap ?? 50;
  const minHours = opts.minHoursBetweenOutreach ?? 24 * 14; // fortnightly
  const result: OutreachBatchResult = {
    openInterventions: 0,
    selected: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  const { data, error } = await supabase
    .schema("resupply")
    .from("clinical_encounters")
    .select("id, patient_id, assessment_category, created_at")
    .eq("encounter_type", "adherence_intervention")
    .eq("outcome_status", "pending")
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    patient_id: string;
    assessment_category: string | null;
  }>;
  result.openInterventions = rows.length;
  if (rows.length === 0) return result;

  // Frequency-cap: most-recent outreach per candidate patient.
  const patientIds = [...new Set(rows.map((r) => r.patient_id))];
  const lastOutreach = new Map<string, string>();
  const { data: logs } = await supabase
    .schema("resupply")
    .from("clinical_outreach_log")
    .select("patient_id, created_at")
    .in("patient_id", patientIds)
    .order("created_at", { ascending: false });
  for (const l of (logs ?? []) as Array<{
    patient_id: string;
    created_at: string;
  }>) {
    if (!lastOutreach.has(l.patient_id)) {
      lastOutreach.set(l.patient_id, l.created_at);
    }
  }

  const targets = selectOutreachTargets(
    rows.map((r) => ({
      patientId: r.patient_id,
      interventionEncounterId: r.id,
      assessmentCategory: r.assessment_category,
    })),
    lastOutreach,
    { cap, minHoursBetweenOutreach: minHours },
  );
  result.selected = targets.length;

  for (const t of targets) {
    try {
      const outcome = await sendOneOutreach(supabase, t, deps);
      if (outcome.kind === "sent") result.sent += 1;
      else if (outcome.kind === "failed") result.failed += 1;
      else result.skipped += 1;
    } catch (err) {
      logger.warn(
        { err, patientId: t.patientId },
        "clinical outreach: sendOne threw",
      );
      result.failed += 1;
    }
  }

  return result;
}
