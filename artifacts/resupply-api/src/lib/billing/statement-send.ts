// Patient-responsibility statement send (Biller #30).
//
// The statement is already rendered + persisted (patient_billing_statements
// + a PDF in object storage). This delivers it — email (preferred) or SMS
// — strictly gated by the patient's communication preferences and DND
// window (a statement is a transactional/account notice: email via the
// `billingStatement` category, SMS via `transactional`), and records the
// outcome on the row's delivery-state columns (migration 0200).
//
// Guardrails this module upholds:
//   * One From address — email funnels through createSendgridClient.
//   * Consent + DND + opt-out — pickStatementChannel is the only place a
//     channel is chosen; a gated-out statement is recorded 'skipped'
//     (with a reason) rather than sent.
//   * No PHI in logs — statement id + channel + status only. Never the
//     amount, the patient's name, the contact, or the PDF link.

import {
  DEFAULT_COMMUNICATION_PREFERENCES,
  getSupabaseServiceRoleClient,
  type CommunicationPreferences,
  type Json,
} from "@workspace/resupply-db";
import { createSendgridClient } from "@workspace/resupply-email";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { shouldSendEmail, shouldSendSms, type DndOptions } from "../comm-prefs";
import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface StatementMessagingConfig {
  sendgridApiKey: string | null;
  sendgridFromEmail: string | null;
  sendgridFromName: string | null;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioPhoneNumber: string | null;
  twilioMessagingServiceSid: string | null;
  practiceName: string;
}

export function readStatementMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): StatementMessagingConfig {
  return {
    sendgridApiKey: env.SENDGRID_API_KEY ?? null,
    sendgridFromEmail: env.SENDGRID_FROM_EMAIL ?? null,
    sendgridFromName: env.SENDGRID_FROM_NAME ?? null,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? null,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? null,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER ?? null,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID ?? null,
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? "PennPaps",
  };
}

export function readStatementPrefs(raw: Json | null): CommunicationPreferences {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_COMMUNICATION_PREFERENCES;
  }
  return {
    ...DEFAULT_COMMUNICATION_PREFERENCES,
    ...(raw as Partial<CommunicationPreferences>),
  };
}

export type StatementChannel = "email" | "sms";

export interface ChannelPick {
  channel: StatementChannel | null;
  reason: string;
}

export interface ContactAvailability {
  hasEmail: boolean;
  hasPhone: boolean;
}

/**
 * Pure: choose the delivery channel for a statement, honoring the
 * patient's preferred channel, the per-category opt-in, the DND window,
 * and which contacts actually exist. Returns null + a reason when the
 * statement must be skipped (so the caller records WHY). No I/O.
 *
 * Tries the preferred channel first, then the other — a statement is
 * worth reaching the patient on whichever consented channel is open.
 */
export function pickStatementChannel(
  prefs: CommunicationPreferences,
  contact: ContactAvailability,
  now: Date = new Date(),
  opts: DndOptions = {},
): ChannelPick {
  const emailOk =
    contact.hasEmail && shouldSendEmail(prefs, "billingStatement", now, opts);
  const smsOk =
    contact.hasPhone && shouldSendSms(prefs, "transactional", now, opts);

  const order: StatementChannel[] =
    prefs.preferredChannel === "sms" ? ["sms", "email"] : ["email", "sms"];
  for (const ch of order) {
    if (ch === "email" && emailOk) return { channel: "email", reason: "ok" };
    if (ch === "sms" && smsOk) return { channel: "sms", reason: "ok" };
  }

  // Nothing open — explain why (most-actionable reason first).
  if (!contact.hasEmail && !contact.hasPhone) {
    return { channel: null, reason: "no_contact_channels" };
  }
  return { channel: null, reason: "opted_out_or_dnd" };
}

export interface StatementContext {
  statementId: string;
  amountCents: number;
  email: string | null;
  phoneE164: string | null;
  /** Signed, time-limited link to the statement PDF, when available. */
  pdfUrl: string | null;
}

export type SendOutcome =
  | { kind: "sent"; channel: StatementChannel }
  | { kind: "failed"; channel: StatementChannel; reason: string }
  | { kind: "skipped"; reason: string };

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Send the statement over the chosen channel. Pure w.r.t. I/O except the
 * injected SendGrid/Twilio clients (built from cfg) — so a test stages
 * responses without env. Channel selection happens in the caller via
 * pickStatementChannel; this just delivers on the channel it's given.
 */
export async function sendStatementMessage(
  ctx: StatementContext,
  channel: StatementChannel,
  cfg: StatementMessagingConfig,
): Promise<SendOutcome> {
  const amount = formatUsd(ctx.amountCents);
  const linkLine = ctx.pdfUrl ? `\nView your statement: ${ctx.pdfUrl}` : "";

  if (channel === "email") {
    if (
      !ctx.email ||
      !cfg.sendgridApiKey ||
      !cfg.sendgridFromEmail ||
      !cfg.sendgridFromName
    ) {
      return { kind: "skipped", reason: "email_channel_unconfigured" };
    }
    const text = [
      `You have an outstanding balance of ${amount} with ${cfg.practiceName}.`,
      linkLine,
      "",
      "If you've already paid or have questions about your balance, please reply to this email or contact our billing team.",
    ]
      .filter((s) => s !== "")
      .join("\n");
    try {
      const client = createSendgridClient({
        apiKey: cfg.sendgridApiKey,
        fromEmail: cfg.sendgridFromEmail,
        fromName: cfg.sendgridFromName,
      });
      await client.sendEmail({
        to: ctx.email,
        subject: `Your ${cfg.practiceName} billing statement`,
        html: text
          .split("\n")
          .map((line) => `<p>${escapeHtml(line)}</p>`)
          .join(""),
        text,
      });
      return { kind: "sent", channel: "email" };
    } catch (err) {
      return {
        kind: "failed",
        channel: "email",
        reason: err instanceof Error ? err.message : "sendgrid_unknown",
      };
    }
  }

  // SMS
  if (
    !ctx.phoneE164 ||
    !cfg.twilioAccountSid ||
    !cfg.twilioAuthToken ||
    !(cfg.twilioPhoneNumber || cfg.twilioMessagingServiceSid)
  ) {
    return { kind: "skipped", reason: "sms_channel_unconfigured" };
  }
  const smsBody =
    `${cfg.practiceName}: you have a balance of ${amount}.` +
    (ctx.pdfUrl ? ` View your statement: ${ctx.pdfUrl}` : "") +
    ` Reply STOP to opt out.`;
  try {
    const client = createTwilioSmsClient({
      accountSid: cfg.twilioAccountSid,
      authToken: cfg.twilioAuthToken,
      from: cfg.twilioPhoneNumber ?? undefined,
      messagingServiceSid: cfg.twilioMessagingServiceSid ?? undefined,
    });
    await client.sendSms({ to: ctx.phoneE164, body: smsBody.slice(0, 320) });
    return { kind: "sent", channel: "sms" };
  } catch (err) {
    return {
      kind: "failed",
      channel: "sms",
      reason: err instanceof Error ? err.message : "twilio_unknown",
    };
  }
}

export interface StatementSendDeps {
  cfg?: StatementMessagingConfig;
  /** Sign the PDF object key into a time-limited URL; null on failure. */
  signPdfUrl?: (objectKey: string) => Promise<string | null>;
  /** Injected sender (tests). Defaults to sendStatementMessage. */
  send?: (
    ctx: StatementContext,
    channel: StatementChannel,
    cfg: StatementMessagingConfig,
  ) => Promise<SendOutcome>;
  now?: Date;
}

async function persistOutcome(
  supabase: SupabaseClient,
  statementId: string,
  outcome: SendOutcome,
): Promise<void> {
  const status =
    outcome.kind === "sent"
      ? "sent"
      : outcome.kind === "failed"
        ? "failed"
        : "skipped";
  await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .update({
      delivery_status: status,
      delivery_channel: "channel" in outcome ? outcome.channel : null,
      delivered_at: outcome.kind === "sent" ? new Date().toISOString() : null,
      delivery_error:
        outcome.kind === "failed" ? outcome.reason.slice(0, 500) : null,
    })
    .eq("id", statementId);
}

/**
 * Load one statement + its patient's contact + comm prefs, pick a
 * consented channel, send, and record the outcome. Fail-soft — returns
 * the outcome; never throws for a normal gated/failed send.
 */
export async function sendOneStatement(
  supabase: SupabaseClient,
  statementId: string,
  deps: StatementSendDeps = {},
): Promise<SendOutcome> {
  const cfg = deps.cfg ?? readStatementMessagingConfig();
  const send = deps.send ?? sendStatementMessage;
  const now = deps.now ?? new Date();

  const { data: stmt, error } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .select(
      "id, patient_id, total_patient_responsibility_cents, statement_pdf_object_key, delivery_status",
    )
    .eq("id", statementId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!stmt) return { kind: "skipped", reason: "statement_not_found" };
  if ((stmt.total_patient_responsibility_cents ?? 0) <= 0) {
    const outcome: SendOutcome = { kind: "skipped", reason: "zero_balance" };
    await persistOutcome(supabase, statementId, outcome);
    return outcome;
  }

  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("email, phone_e164, address")
    .eq("id", stmt.patient_id)
    .limit(1)
    .maybeSingle();

  const email = (patient?.email as string | null) ?? null;
  const phoneE164 = (patient?.phone_e164 as string | null) ?? null;
  const zip = ((patient?.address as { zip?: string } | null)?.zip ?? null) as
    | string
    | null;

  // Communication preferences live on the linked shop_customers row
  // (keyed by lowercased email), not on patients. No row / no email →
  // defaults (billing-statement email ON, transactional SMS OFF).
  let prefs = DEFAULT_COMMUNICATION_PREFERENCES;
  if (email) {
    const { data: cust } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("communication_preferences")
      .eq("email_lower", email.toLowerCase())
      .limit(1)
      .maybeSingle();
    prefs = readStatementPrefs(
      (cust?.communication_preferences ?? null) as Json | null,
    );
  }

  const pick = pickStatementChannel(
    prefs,
    { hasEmail: !!email, hasPhone: !!phoneE164 },
    now,
    { shippingZip: zip },
  );
  if (!pick.channel) {
    const outcome: SendOutcome = { kind: "skipped", reason: pick.reason };
    await persistOutcome(supabase, statementId, outcome);
    return outcome;
  }

  let pdfUrl: string | null = null;
  if (stmt.statement_pdf_object_key && deps.signPdfUrl) {
    try {
      pdfUrl = await deps.signPdfUrl(stmt.statement_pdf_object_key);
    } catch {
      pdfUrl = null; // fail-soft — send the balance notice without a link
    }
  }

  const outcome = await send(
    {
      statementId: stmt.id,
      amountCents: stmt.total_patient_responsibility_cents,
      email,
      phoneE164,
      pdfUrl,
    },
    pick.channel,
    cfg,
  );
  await persistOutcome(supabase, statementId, outcome);

  logger.info(
    {
      event: "billing.statement.send",
      statement_id: statementId,
      channel: "channel" in outcome ? outcome.channel : null,
      status: outcome.kind,
    },
    "billing.statement.send",
  );
  return outcome;
}

export interface StatementBatchOpts {
  /** Max statements to send this run. Default 50. */
  cap?: number;
}

export interface StatementBatchResult {
  scanned: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Send all pending statements with a positive balance, capped per run.
 * Fail-soft per statement.
 */
export async function runStatementBatchSend(
  opts: StatementBatchOpts = {},
  deps: StatementSendDeps = {},
): Promise<StatementBatchResult> {
  const supabase = getSupabaseServiceRoleClient();
  const cap = opts.cap ?? 50;
  const result: StatementBatchResult = {
    scanned: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .select("id, total_patient_responsibility_cents")
    .eq("delivery_status", "pending")
    .gt("total_patient_responsibility_cents", 0)
    .order("created_at", { ascending: true })
    .limit(Math.max(1, cap));
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string }>;
  result.scanned = rows.length;

  for (const row of rows) {
    try {
      const outcome = await sendOneStatement(supabase, row.id, deps);
      if (outcome.kind === "sent") result.sent += 1;
      else if (outcome.kind === "failed") result.failed += 1;
      else result.skipped += 1;
    } catch (err) {
      logger.warn(
        { err, statement_id: row.id },
        "statement batch-send: sendOne threw",
      );
      result.failed += 1;
    }
  }

  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
