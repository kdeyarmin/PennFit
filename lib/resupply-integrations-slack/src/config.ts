// Read-at-call-time Slack credentials. Missing env returns null; every
// caller then degrades to a no-op (outbound) or 503 (inbound) — it never
// fabricates a post and never crashes the boot sequence.
//
// Slack is wired as an INTERNAL operator/CS channel, not a patient-facing
// per-tenant surface, so these are PLATFORM credentials (one Slack app /
// workspace for the operator), mirroring the platform Twilio/SendGrid keys.
//
// Required env for outbound notifications:
//   SLACK_BOT_TOKEN       — xoxb-… bot token with chat:write
//   SLACK_ALERTS_CHANNEL  — default channel id (e.g. C0123ABCD) posts land in
//
// Required additionally for inbound interactivity / slash commands:
//   SLACK_SIGNING_SECRET  — app signing secret; verifies inbound requests

export interface SlackConfig {
  botToken: string;
  /** Default channel id alerts post to when a caller doesn't override it. */
  defaultChannel: string;
  /** Present only when the app is configured to receive inbound requests. */
  signingSecret: string | null;
}

/**
 * Resolve the Slack config from an env bag. Returns null when the minimum
 * outbound credentials (bot token + a default channel) are not both set —
 * the notifier then no-ops. `signingSecret` is independent: it may be null
 * even when outbound is configured (a workspace that only receives alerts).
 */
export function readSlackConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): SlackConfig | null {
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  const defaultChannel = env.SLACK_ALERTS_CHANNEL?.trim();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim() || null;
  if (!botToken || !defaultChannel) return null;
  return { botToken, defaultChannel, signingSecret };
}

/**
 * Resolve only the signing secret — the inbound endpoint needs it before
 * (and independently of) a bot token. Returns null when unset.
 */
export function readSlackSigningSecretOrNull(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.SLACK_SIGNING_SECRET?.trim() || null;
}
