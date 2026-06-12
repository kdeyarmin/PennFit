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
import {
  createSendgridClient,
  DEFAULT_SENDGRID_FROM_EMAIL,
} from "@workspace/resupply-email";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { shouldSendEmail, shouldSendSms, type DndOptions } from "../comm-prefs";
import { getDocumentSupplierNameSync } from "../company-info";
import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface StatementMessagingConfig {
  sendgridApiKey: string | null;
  sendgridFromEmail: string;
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
    sendgridFromEmail:
      env.SENDGRID_FROM_EMAIL?.trim() || DEFAULT_SENDGRID_FROM_EMAIL,
    sendgridFromName: env.SENDGRID_FROM_NAME ?? null,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? null,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? null,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER ?? null,
    twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID ?? null,
    // Billing statements come from the DME entity, so they carry the
    // registered legal name ("Penn Home Medical Supply"), not the
    // storefront display brand.
    practiceName: getDocumentSupplierNameSync(),
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
  | { kind: "skipped"; reason: string }
  // Routed to the print/mail worklist (the patient chose mailed
  // statements, or has no email for an emailed one). Left pending with
  // delivery_method 'mail' until an operator marks the mail batch sent.
  | { kind: "mail"; reason: string };

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
    if (!ctx.email || !cfg.sendgridApiKey || !cfg.sendgridFromName) {
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
  // 'mail' is not a delivery_status — those rows stay 'pending' on the
  // mail worklist and are flipped to sent/mail by the mark-mailed route.
  if (outcome.kind === "mail") return;
  const status =
    outcome.kind === "sent"
      ? "sent"
      : outcome.kind === "failed"
        ? "failed"
        : "skipped";
  // Conditional on the states this function legitimately transitions
  // FROM: 'sending' (a claimed electronic send recording its outcome)
  // and 'pending' (an unclaimed gate-skip — zero balance / no channel).
  // Anything else means another writer got here first; never stomp it.
  const { data: updated, error: persistErr } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .update({
      delivery_status: status,
      delivery_channel: "channel" in outcome ? outcome.channel : null,
      delivered_at: outcome.kind === "sent" ? new Date().toISOString() : null,
      delivery_error:
        outcome.kind === "failed" ? outcome.reason.slice(0, 500) : null,
    })
    .eq("id", statementId)
    .in("delivery_status", ["pending", "sending"])
    .select("id");
  if (persistErr) {
    logger.error(
      { err: persistErr.message, statementId, deliveryStatus: status },
      "statement-send: delivery status not recorded — statement may be re-sent",
    );
  } else if ((updated ?? []).length === 0) {
    logger.warn(
      { statementId, deliveryStatus: status },
      "statement-send: outcome not recorded — row was no longer pending/sending",
    );
  }
}

/**
 * Atomically claim a statement for electronic delivery: flip
 * pending/failed → 'sending' with a conditional UPDATE. This is the
 * concurrency gate that closes the double-send race — of two
 * concurrent senders (an operator's single-send click racing the
 * batch sweep), exactly one gets the row back and dispatches; the
 * loser sees zero rows and skips. 'failed' is claimable so an
 * operator can retry a failed send; 'sent' is NOT — re-sending a
 * delivered bill is the double-billing bug this guards against.
 * The 'sending' state is admitted by migration 0297.
 */
async function claimStatementForSend(
  supabase: SupabaseClient,
  statementId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .update({ delivery_status: "sending" })
    .eq("id", statementId)
    .in("delivery_status", ["pending", "failed"])
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Flag a statement for the print/mail worklist: delivery_method 'mail',
 * left pending. Used when a patient who prefers an emailed statement has
 * no email on file (so the bill isn't silently lost).
 */
async function routeToMail(
  supabase: SupabaseClient,
  statementId: string,
): Promise<void> {
  const { error: routeErr } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .update({ delivery_method: "mail" })
    .eq("id", statementId);
  if (routeErr) {
    logger.error(
      { err: routeErr.message, statementId },
      "statement-send: mail routing not recorded — statement will miss the mail worklist",
    );
  }
}

/**
 * Mark mailed statements delivered: status 'sent', channel 'mail',
 * delivered_at now. Called when an operator confirms a print/mail batch
 * went out (routes/admin/billing-statement-send.ts). Guarded — only
 * flips rows that are actually mail-preference + pending, so a stray id
 * can't mark an electronic/already-sent statement mailed. Returns the
 * count actually marked.
 */
export async function markStatementsMailed(
  supabase: SupabaseClient,
  statementIds: string[],
): Promise<number> {
  if (statementIds.length === 0) return 0;
  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .update({
      delivery_status: "sent",
      delivery_channel: "mail",
      delivery_method: "mail",
      delivered_at: new Date().toISOString(),
      delivery_error: null,
    })
    .in("id", statementIds)
    .eq("delivery_method", "mail")
    .eq("delivery_status", "pending")
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

interface LoadedStatement {
  id: string;
  total_patient_responsibility_cents: number;
  statement_pdf_object_key: string | null;
}

/**
 * Sign the PDF link, deliver on the chosen channel, persist + log the
 * outcome. Shared by the emailed-preference and legacy comm-prefs paths.
 */
async function deliverOnChannel(
  supabase: SupabaseClient,
  stmt: LoadedStatement,
  contact: { email: string | null; phoneE164: string | null },
  channel: StatementChannel,
  cfg: StatementMessagingConfig,
  send: NonNullable<StatementSendDeps["send"]>,
  deps: StatementSendDeps,
): Promise<SendOutcome> {
  // Claim BEFORE building/sending anything. A statement that is
  // already 'sending' (another sender in flight) or 'sent' must never
  // be dispatched again.
  const claimed = await claimStatementForSend(supabase, stmt.id);
  if (!claimed) {
    return { kind: "skipped", reason: "already_claimed_or_sent" };
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
      email: contact.email,
      phoneE164: contact.phoneE164,
      pdfUrl,
    },
    channel,
    cfg,
  );
  await persistOutcome(supabase, stmt.id, outcome);

  logger.info(
    {
      event: "billing.statement.send",
      statement_id: stmt.id,
      channel: "channel" in outcome ? outcome.channel : null,
      status: outcome.kind,
    },
    "billing.statement.send",
  );
  return outcome;
}

/**
 * Load one statement + its patient's contact, SEGREGATE by the patient's
 * statement delivery preference (stamped on the row's `delivery_method`
 * at generation), and deliver:
 *
 *   * 'mail'  — routed to the print/mail worklist (left pending). Never
 *               emailed/texted.
 *   * 'email' — emailed to the patient. An emailed-statement preference
 *               is an explicit opt-in to a bill by email, so it sends
 *               regardless of the generic billing-statement toggle / quiet
 *               hours. No email on file → falls back to the mail worklist.
 *   * null / legacy — honors comm preferences + DND, email-or-SMS, via
 *               pickStatementChannel (unchanged pre-0257 behavior).
 *
 * Fail-soft — returns the outcome; never throws for a normal gated send.
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
      "id, patient_id, total_patient_responsibility_cents, statement_pdf_object_key, delivery_status, delivery_method",
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

  const deliveryMethod = (stmt.delivery_method as string | null) ?? null;
  const loaded: LoadedStatement = {
    id: stmt.id,
    total_patient_responsibility_cents: stmt.total_patient_responsibility_cents,
    statement_pdf_object_key:
      (stmt.statement_pdf_object_key as string | null) ?? null,
  };

  // Mailed-preference statements are not delivered electronically — they
  // sit on the print/mail worklist until an operator marks the batch sent.
  if (deliveryMethod === "mail") {
    return { kind: "mail", reason: "mail_preference" };
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

  // Emailed-statement preference: explicit opt-in to a bill by email.
  if (deliveryMethod === "email") {
    if (!email) {
      // Can't email — route to the mail worklist so it isn't lost.
      await routeToMail(supabase, statementId);
      return { kind: "mail", reason: "no_email_fallback_mail" };
    }
    return deliverOnChannel(
      supabase,
      loaded,
      { email, phoneE164 },
      "email",
      cfg,
      send,
      deps,
    );
  }

  // Legacy / unset preference. Communication preferences live on the
  // linked shop_customers row (keyed by lowercased email), not on
  // patients. No row / no email → defaults (billing-statement email ON,
  // transactional SMS OFF).
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

  return deliverOnChannel(
    supabase,
    loaded,
    { email, phoneE164 },
    pick.channel,
    cfg,
    send,
    deps,
  );
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
  /** Statements left on the print/mail worklist (mail preference). */
  mailQueued: number;
}

/**
 * Send all pending ELECTRONIC statements (emailed-preference + legacy)
 * with a positive balance, capped per run. Mailed-preference statements
 * are excluded — they live on the separate mail worklist — so the batch
 * never repeatedly re-scans them. Fail-soft per statement.
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
    mailQueued: 0,
  };

  const { data, error } = await supabase
    .schema("resupply")
    .from("patient_billing_statements")
    .select("id, total_patient_responsibility_cents")
    .eq("delivery_status", "pending")
    .gt("total_patient_responsibility_cents", 0)
    // Electronic = everything EXCEPT mail-preference. Excluding only
    // 'mail' keeps null (pre-0257) AND any legacy sms/in_person rows on
    // the electronic path (handled by pickStatementChannel) rather than
    // orphaning them off both queues.
    .or("delivery_method.is.null,delivery_method.neq.mail")
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
      else if (outcome.kind === "mail") result.mailQueued += 1;
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
