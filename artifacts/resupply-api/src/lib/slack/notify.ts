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

import { getEffectiveEnv, getEffectiveEnvForOrg } from "../app-config/store";
import { isFeatureEnabled, type FeatureFlagKey } from "../feature-flags";
import { logger } from "../logger";
import { resolveTenantBaseUrl } from "../tenant-branding";

/**
 * Resolve the env (Slack config lives here) for a tenant. Slack config is
 * tenant-scoped, so a known orgId reads THAT tenant's own workspace/token;
 * an undefined orgId (worker/system paths) falls back to the platform/seed
 * overlay.
 */
function resolveSlackEnv(
  orgId: string | undefined,
): Promise<NodeJS.ProcessEnv> {
  return orgId ? getEffectiveEnvForOrg(orgId) : getEffectiveEnv();
}

export type SlackTestResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "send_failed"; error?: string };

/**
 * Post a one-off verification message to a tenant's configured Slack channel.
 * Powers the System Configuration "Send test message" button so an operator can
 * confirm the bot token + channel are wired correctly. Bypasses the feature
 * flags on purpose (it's a config test, not an alert) but still requires the
 * channel/token to be configured. Returns a typed result; never throws.
 */
export async function sendSlackTestMessage(
  orgId: string | undefined,
): Promise<SlackTestResult> {
  try {
    const config = readSlackConfigOrNull(await resolveSlackEnv(orgId));
    if (!config) return { ok: false, reason: "not_configured" };
    const res = await postSlackMessage(config, {
      text: "✅ CareMetric Breathe test message — your Slack integration is connected.",
      blocks: buildAlertBlocks({
        title: "✅ Slack connected",
        lines: [
          "This is a test from your CareMetric Breathe System Configuration.",
          "Real-time CS alerts will post to this channel.",
        ],
      }),
    });
    return res.ok
      ? { ok: true }
      : { ok: false, reason: "send_failed", error: res.error };
  } catch (err) {
    return {
      ok: false,
      reason: "send_failed",
      error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    };
  }
}

/** Action id the inbound interactivity endpoint routes "Claim" clicks to. */
export const CLAIM_ACTION_ID = "claim_conversation";
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

async function adminPathDeepLink(
  orgId: string | undefined,
  path: string,
): Promise<string | undefined> {
  const base = await resolveAdminBaseUrl(orgId);
  return base ? `${base}${path}` : undefined;
}

interface CsAlertInput {
  orgId: string | undefined;
  title: string;
  severity: SlackSeverity;
  lines: string[];
  actions?: SlackAction[];
  /** Flag gating this post. Defaults to the real-time CS-alerts flag. */
  flagKey?: FeatureFlagKey;
  /** Channel override; defaults to the config's default alerts channel. */
  channel?: string;
}

/**
 * Shared send path: flag gate → config → post. Returns nothing; logs and
 * swallows everything. Used by the typed helpers below.
 */
async function sendCsAlert(input: CsAlertInput): Promise<void> {
  try {
    const flagKey = input.flagKey ?? "slack.notifications";
    if (!(await isFeatureEnabled(flagKey, input.orgId))) return;
    const config = readSlackConfigOrNull(await resolveSlackEnv(input.orgId));
    if (!config) return; // not configured — silent no-op

    const blocks = buildAlertBlocks({
      title: input.title,
      lines: input.lines,
      context: `${input.severity} · ${new Date().toISOString()}`,
      actions: input.actions,
    });
    const res = await postSlackMessage(config, {
      channel: input.channel ?? config.defaultChannel,
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

/**
 * Build the "Open in admin" link plus whichever interactive buttons this alert
 * should offer. Buttons only render when inbound interactivity can service them
 * (signing secret present); the endpoint re-checks the flag + signature.
 */
function conversationActions(
  config: SlackConfig | null,
  link: string | undefined,
  conversationId: string,
  buttons: { claim?: boolean; escalate?: boolean; snooze?: boolean } = {},
): SlackAction[] {
  const actions: SlackAction[] = [];
  if (link) actions.push({ kind: "link", text: "Open in admin", url: link });
  if (config?.signingSecret) {
    if (buttons.claim) {
      actions.push({
        kind: "button",
        text: "Claim",
        actionId: CLAIM_ACTION_ID,
        value: conversationId,
        style: "primary",
      });
    }
    if (buttons.escalate) {
      actions.push({
        kind: "button",
        text: "Escalate",
        actionId: ESCALATE_ACTION_ID,
        value: conversationId,
        style: "danger",
      });
    }
    if (buttons.snooze) {
      actions.push({
        kind: "button",
        text: "Snooze 1d",
        actionId: SNOOZE_ACTION_ID,
        value: conversationId,
      });
    }
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
  const config = readSlackConfigOrNull(await resolveSlackEnv(input.orgId));
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
    actions: conversationActions(config, link, input.conversationId, {
      claim: true,
      escalate: true,
      snooze: true,
    }),
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
  const config = readSlackConfigOrNull(await resolveSlackEnv(input.orgId));
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
    actions: conversationActions(config, link, input.conversationId, {
      claim: true,
    }),
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
  const config = readSlackConfigOrNull(await resolveSlackEnv(input.orgId));
  const link = await conversationDeepLink(input.orgId, input.conversationId);
  await sendCsAlert({
    orgId: input.orgId,
    severity: input.severity,
    title: `${severityEmoji(input.severity)} SLA breach`,
    lines: [
      `*Overdue:* ${input.minutesOverdue} min`,
      `*Conversation:* \`${input.conversationId}\``,
    ],
    actions: conversationActions(config, link, input.conversationId, {
      claim: true,
    }),
  });
}

/**
 * Outbound patient messages are failing/bouncing at an unusual rate — a
 * bouncing sender domain, a bad number batch, a carrier block. Ops/CS signal;
 * non-PHI (just a count + window + a link to the triage queue).
 */
export async function notifyDeliveryFailureSpike(input: {
  orgId: string | undefined;
  count: number;
  windowMinutes: number;
}): Promise<void> {
  const link = await adminPathDeepLink(input.orgId, "/admin/delivery-failures");
  await sendCsAlert({
    orgId: input.orgId,
    severity: "critical",
    title: `${severityEmoji("critical")} Delivery failures spiking`,
    lines: [
      `*${input.count}* failed/bounced outbound message(s) in the last ${input.windowMinutes} min`,
    ],
    actions: link
      ? [{ kind: "link", text: "Open delivery failures", url: link }]
      : undefined,
  });
}

/**
 * A patient submitted a low NPS score (a "detractor", 0–6) after delivery.
 * Real-time CS signal. The free-text comment is NOT sent (patient PHI) — only
 * the score, order reference, and whether a comment exists, plus a link to the
 * NPS triage page where a CSR can read it in-app.
 */
export async function notifyNpsDetractor(input: {
  orgId: string | undefined;
  orderId: string;
  score: number;
  hasComment: boolean;
}): Promise<void> {
  const link = await adminPathDeepLink(input.orgId, "/admin/nps/recent");
  const severity: SlackSeverity = input.score <= 3 ? "critical" : "warning";
  await sendCsAlert({
    orgId: input.orgId,
    severity,
    title: `${severityEmoji(severity)} NPS detractor — scored ${input.score}/10`,
    lines: [
      `*Order:* \`${input.orderId}\``,
      `*Comment:* ${input.hasComment ? "left a comment (read in admin)" : "none"}`,
    ],
    actions: link
      ? [{ kind: "link", text: "Open NPS triage", url: link }]
      : undefined,
  });
}

/**
 * Post an operator/ops digest (owner weekly KPIs, metric alerts, stuck-job
 * DLQ depth, low stock) into Slack. Gated by the SEPARATE `slack.digests`
 * flag and routed to `SLACK_DIGESTS_CHANNEL` when set (else the default
 * alerts channel) so ops digests can live in an #ops channel apart from the
 * real-time CS alerts. Non-PHI: counts / KPI headlines / SKU + queue names.
 */
export async function notifyOpsDigest(input: {
  orgId: string | undefined;
  title: string;
  severity: SlackSeverity;
  lines: string[];
}): Promise<void> {
  const channel = (
    await resolveSlackEnv(input.orgId)
  ).SLACK_DIGESTS_CHANNEL?.trim();
  await sendCsAlert({
    orgId: input.orgId,
    severity: input.severity,
    title: input.title,
    lines: input.lines,
    flagKey: "slack.digests",
    channel: channel || undefined,
  });
}
