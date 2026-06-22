// Slack CS-alert notifier — the resupply-api glue between domain events and
// the @workspace/resupply-integrations-slack client.
//
// Each public function is BEST-EFFORT and fire-and-forget: it resolves the
// platform Slack config (via the app_config overlay), checks the
// `slack.notifications` feature flag, builds a NON-PHI Block Kit message with
// a deep link into the admin console, and posts it. Every failure path
// (flag off, unconfigured, flaky Slack call) degrades to a logged warning —
// it NEVER throws, so a caller can `void notifyX(...)` without risking the
// underlying flow (an SMS reply, a call cleanup, an SLA sweep).
//
// PHI posture (hard rule): the text passed to Slack is a reference + status +
// a link. NEVER pass message bodies, patient names, phone numbers, or
// clinical detail — Slack is an external service and these messages are
// world-readable to the workspace.

import {
  buildAlertBlocks,
  buildFallbackText,
  postSlackMessage,
  readSlackConfigOrNull,
  severityEmoji,
  type SlackAction,
  type SlackConfig,
  type SlackSeverity,
} from "@workspace/resupply-integrations-slack";

import { getEffectiveEnv } from "../app-config/store";
import { isFeatureEnabled } from "../feature-flags";
import { logger } from "../logger";
import { resolveTenantBaseUrl } from "../tenant-branding";

/** Action id the inbound interactivity endpoint routes "Escalate" clicks to. */
export const ESCALATE_ACTION_ID = "escalate_conversation";
/** Action id the inbound interactivity endpoint routes "Snooze" clicks to. */
export const SNOOZE_ACTION_ID = "snooze_conversation";

/**
 * Resolve a base URL for an admin deep link: the tenant's verified custom
 * domain when set, else the platform public origin, else null (link omitted).
 */
async function resolveAdminBaseUrl(
  orgId: string | undefined,
): Promise<string | null> {
  const tenant = orgId ? await resolveTenantBaseUrl(orgId) : null;
  if (tenant) return tenant;
  const explicit = process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return `https://${railway.replace(/^https?:\/\//, "")}`;
  return null;
}

async function conversationDeepLink(
  orgId: string | undefined,
  conversationId: string,
): Promise<string | undefined> {
  const base = await resolveAdminBaseUrl(orgId);
  return base ? `${base}/admin/conversations/${conversationId}` : undefined;
}

async function patientDeepLink(
  orgId: string | undefined,
  patientId: string,
): Promise<string | undefined> {
  const base = await resolveAdminBaseUrl(orgId);
  return base ? `${base}/admin/patients/${patientId}` : undefined;
}

interface CsAlertInput {
  orgId: string | undefined;
  title: string;
  severity: SlackSeverity;
  lines: string[];
  actions?: SlackAction[];
}

/**
 * Shared send path: flag gate → config → post. Returns nothing; logs and
 * swallows everything. Used by the typed helpers below.
 */
async function sendCsAlert(input: CsAlertInput): Promise<void> {
  try {
    if (!(await isFeatureEnabled("slack.notifications", input.orgId))) return;
    const config = readSlackConfigOrNull(await getEffectiveEnv());
    if (!config) return; // not configured — silent no-op

    const blocks = buildAlertBlocks({
      title: input.title,
      lines: input.lines,
      context: `${input.severity} · ${new Date().toISOString()}`,
      actions: input.actions,
    });
    const res = await postSlackMessage(config, {
      text: buildFallbackText({ title: input.title, lines: input.lines }),
      blocks,
    });
    if (!res.ok) {
      logger.warn(
        { event: "slack_notify_failed", error: res.error, title: input.title },
        "slack: CS alert post failed (best-effort, ignored)",
      );
    }
  } catch (err) {
    logger.warn(
      {
        event: "slack_notify_crashed",
        err:
          err instanceof Error
            ? { name: err.name, message: err.message.slice(0, 200) }
            : { name: "unknown" },
      },
      "slack: CS alert notifier crashed (best-effort, ignored)",
    );
  }
}

/** Build the standard "Open in admin" link + (when interactivity is wired) an
 *  Escalate button for a conversation alert. */
function conversationActions(
  config: SlackConfig | null,
  link: string | undefined,
  conversationId: string,
  includeEscalate: boolean,
): SlackAction[] {
  const actions: SlackAction[] = [];
  if (link) actions.push({ kind: "link", text: "Open in admin", url: link });
  // Only offer the action buttons when inbound interactivity can actually
  // service them (signing secret present); the endpoint re-checks the flag.
  if (includeEscalate && config?.signingSecret) {
    actions.push({
      kind: "button",
      text: "Escalate",
      actionId: ESCALATE_ACTION_ID,
      value: conversationId,
      style: "danger",
    });
    actions.push({
      kind: "button",
      text: "Snooze 1d",
      actionId: SNOOZE_ACTION_ID,
      value: conversationId,
    });
  }
  return actions;
}

/**
 * A patient reply landed in the CS queue (conversation → awaiting_admin) and
 * needs a human. `channel` is "sms" | "email"; `reference` is a short non-PHI
 * tag (e.g. the conversation id or a PENN-… order ref) for the reps.
 */
export async function notifyConversationNeedsHuman(input: {
  orgId: string | undefined;
  conversationId: string;
  channel: "sms" | "email";
  /** Short non-PHI reason, e.g. "unrecognized reply" or "address change". */
  reason?: string;
}): Promise<void> {
  const config = readSlackConfigOrNull(await getEffectiveEnv());
  const link = await conversationDeepLink(input.orgId, input.conversationId);
  const lines = [
    `*Channel:* ${input.channel.toUpperCase()}`,
    `*Conversation:* \`${input.conversationId}\``,
  ];
  if (input.reason) lines.push(`*Reason:* ${input.reason}`);
  await sendCsAlert({
    orgId: input.orgId,
    severity: "warning",
    title: `${severityEmoji("warning")} Patient reply needs a human`,
    lines,
    actions: conversationActions(config, link, input.conversationId, true),
  });
}

/**
 * The voice post-call summarizer flagged a call for human follow-up. The
 * conversation is already escalated (post-call-handoff), so no Escalate
 * button — just visibility + a link. `sentiment` drives the severity.
 */
export async function notifyVoiceHandoff(input: {
  orgId: string | undefined;
  conversationId: string;
  sentiment: "positive" | "neutral" | "concerned" | "distressed";
  /** Short non-PHI outcome summary from the summarizer. */
  outcome: string;
}): Promise<void> {
  const config = readSlackConfigOrNull(await getEffectiveEnv());
  const link = await conversationDeepLink(input.orgId, input.conversationId);
  const severity: SlackSeverity =
    input.sentiment === "distressed" ? "critical" : "warning";
  await sendCsAlert({
    orgId: input.orgId,
    severity,
    title: `${severityEmoji(severity)} Voice call handoff`,
    lines: [
      `*Sentiment:* ${input.sentiment}`,
      `*Conversation:* \`${input.conversationId}\``,
      `*Outcome:* ${input.outcome}`,
    ],
    actions: conversationActions(config, link, input.conversationId, false),
  });
}

/**
 * A patient is unresponsive after the full reminder ladder (SMS → email →
 * voice) and a CSR no-response alert was raised — "ready for a personal call".
 * Links to the patient page (this alert is patient-scoped, not a conversation).
 */
export async function notifyReminderEscalation(input: {
  orgId: string | undefined;
  patientId: string;
  /** Human phrase of the channels already tried, e.g. "SMS, email, and a call". */
  channelsTried: string;
}): Promise<void> {
  const link = await patientDeepLink(input.orgId, input.patientId);
  await sendCsAlert({
    orgId: input.orgId,
    severity: "warning",
    title: `${severityEmoji("warning")} Reminder ladder exhausted`,
    lines: [
      `*Patient:* \`${input.patientId}\``,
      `*Tried:* ${input.channelsTried}`,
      "Recommend a personal call.",
    ],
    actions: link
      ? [{ kind: "link", text: "Open patient", url: link }]
      : undefined,
  });
}

/**
 * A conversation breached its SLA and was escalated by the sweep. Already
 * escalated, so link-only.
 */
export async function notifySlaBreach(input: {
  orgId: string | undefined;
  conversationId: string;
  minutesOverdue: number;
  severity: "warning" | "critical";
}): Promise<void> {
  const config = readSlackConfigOrNull(await getEffectiveEnv());
  const link = await conversationDeepLink(input.orgId, input.conversationId);
  await sendCsAlert({
    orgId: input.orgId,
    severity: input.severity,
    title: `${severityEmoji(input.severity)} SLA breach`,
    lines: [
      `*Overdue:* ${input.minutesOverdue} min`,
      `*Conversation:* \`${input.conversationId}\``,
    ],
    actions: conversationActions(config, link, input.conversationId, false),
  });
}
