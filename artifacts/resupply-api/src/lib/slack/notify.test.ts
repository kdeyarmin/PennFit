// Tests for the Slack CS-alert notifier glue.
//
// Coverage:
//   * No-op when the slack.notifications flag is off.
//   * No-op when Slack is unconfigured (no bot token).
//   * Posts a non-PHI message with a deep link when configured + enabled.
//   * Offers an Escalate button only when a signing secret is present.
//   * Voice handoff maps distressed sentiment → critical severity.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable holder for the org-scoped DB mock (assigned rep + their Slack id).
const dbState = vi.hoisted(() => ({
  assignedAdminId: null as string | null,
  adminSlackId: null as string | null,
}));
vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: (table: string) => {
      const data =
        table === "conversations"
          ? { assigned_admin_user_id: dbState.assignedAdminId }
          : { slack_user_id: dbState.adminSlackId };
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data }),
      };
      return chain;
    },
  }),
}));
vi.mock("../feature-flags", () => ({ isFeatureEnabled: vi.fn() }));
vi.mock("../app-config/store", () => ({
  getEffectiveEnv: vi.fn(),
  getEffectiveEnvForOrg: vi.fn(),
  // resolveAssistantNamesForOrg (real, in company-info) reads this; null →
  // the platform default name ("CareMetric Copilot").
  getTenantConfigValue: vi.fn(async () => null),
}));
vi.mock("../tenant-branding", () => ({ resolveTenantBaseUrl: vi.fn() }));
vi.mock("@workspace/resupply-integrations-slack", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@workspace/resupply-integrations-slack")
    >();
  return { ...actual, postSlackMessage: vi.fn(), slackAuthTest: vi.fn() };
});

import {
  postSlackMessage,
  slackAuthTest,
} from "@workspace/resupply-integrations-slack";

import { getEffectiveEnv, getEffectiveEnvForOrg } from "../app-config/store";
import { isFeatureEnabled } from "../feature-flags";
import { resolveTenantBaseUrl } from "../tenant-branding";
import {
  notifyConversationNeedsHuman,
  notifyDeliveryFailureSpike,
  notifyFeatureSuggestion,
  notifyNpsDetractor,
  notifyOpsDigest,
  notifyReminderEscalation,
  notifySlaBreach,
  notifyVoiceHandoff,
  sendSlackTestMessage,
} from "./notify";

const isFeatureEnabledMock = vi.mocked(isFeatureEnabled);
const getEffectiveEnvMock = vi.mocked(getEffectiveEnv);
const getEffectiveEnvForOrgMock = vi.mocked(getEffectiveEnvForOrg);
const resolveTenantBaseUrlMock = vi.mocked(resolveTenantBaseUrl);
const postSlackMessageMock = vi.mocked(postSlackMessage);
const slackAuthTestMock = vi.mocked(slackAuthTest);

const CONFIGURED = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_ALERTS_CHANNEL: "C1",
  SLACK_SIGNING_SECRET: "shh",
} as NodeJS.ProcessEnv;

/** Slack config is tenant-scoped: a known orgId reads getEffectiveEnvForOrg,
 *  an undefined orgId reads getEffectiveEnv. Set both so a test doesn't care
 *  which path runs. */
function setSlackEnv(env: NodeJS.ProcessEnv): void {
  getEffectiveEnvMock.mockResolvedValue(env);
  getEffectiveEnvForOrgMock.mockResolvedValue(env);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.assignedAdminId = null;
  dbState.adminSlackId = null;
  isFeatureEnabledMock.mockResolvedValue(true);
  setSlackEnv(CONFIGURED);
  resolveTenantBaseUrlMock.mockResolvedValue("https://tenant.example");
  postSlackMessageMock.mockResolvedValue({ ok: true, ts: "1" });
  slackAuthTestMock.mockResolvedValue({
    ok: true,
    team: "Acme HME",
    teamId: "T999",
    botUserId: "U999",
  });
});

describe("notifyConversationNeedsHuman", () => {
  it("posts a non-PHI message with a deep link + Escalate button", async () => {
    await notifyConversationNeedsHuman({
      orgId: "org-1",
      conversationId: "conv-9",
      channel: "sms",
      reason: "address change",
    });

    expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("conv-9");
    expect(serialized).toContain(
      "https://tenant.example/admin/conversations/conv-9",
    );
    expect(serialized).toContain("claim_conversation");
    expect(serialized).toContain("escalate_conversation");
    expect(serialized).toContain("snooze_conversation");
    // Non-PHI: the reason/channel we passed are present, nothing else leaks.
    expect(serialized).toContain("address change");
  });

  it("omits the Escalate button when no signing secret is configured", async () => {
    setSlackEnv({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_ALERTS_CHANNEL: "C1",
    } as NodeJS.ProcessEnv);

    await notifyConversationNeedsHuman({
      orgId: "org-1",
      conversationId: "conv-9",
      channel: "email",
    });

    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(JSON.stringify(input)).not.toContain("escalate_conversation");
  });

  it("@-mentions the assigned rep when they've linked their Slack id", async () => {
    dbState.assignedAdminId = "admin-1";
    dbState.adminSlackId = "U7ABC";
    await notifyConversationNeedsHuman({
      orgId: "org-1",
      conversationId: "conv-9",
      channel: "sms",
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(JSON.stringify(input)).toContain("<@U7ABC>");
  });

  it("does not mention anyone when the thread is unassigned", async () => {
    await notifyConversationNeedsHuman({
      orgId: "org-1",
      conversationId: "conv-9",
      channel: "sms",
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(JSON.stringify(input)).not.toContain("<@");
  });

  it("no-ops when the flag is off", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    await notifyConversationNeedsHuman({
      orgId: "org-1",
      conversationId: "conv-9",
      channel: "sms",
    });
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it("no-ops when Slack is unconfigured", async () => {
    setSlackEnv({} as NodeJS.ProcessEnv);
    await notifyConversationNeedsHuman({
      orgId: "org-1",
      conversationId: "conv-9",
      channel: "sms",
    });
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it("never throws when the Slack post fails", async () => {
    postSlackMessageMock.mockResolvedValue({
      ok: false,
      error: "channel_not_found",
    });
    await expect(
      notifyConversationNeedsHuman({
        orgId: "org-1",
        conversationId: "conv-9",
        channel: "sms",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("notifyVoiceHandoff", () => {
  it("maps distressed sentiment to critical severity", async () => {
    await notifyVoiceHandoff({
      orgId: "org-1",
      conversationId: "conv-1",
      sentiment: "distressed",
      outcome: "wants a callback",
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(JSON.stringify(input)).toContain("🔴");
  });

  it("offers Claim but not Escalate/Snooze (already escalated)", async () => {
    await notifyVoiceHandoff({
      orgId: "org-1",
      conversationId: "conv-1",
      sentiment: "neutral",
      outcome: "ok",
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("claim_conversation");
    expect(serialized).not.toContain("escalate_conversation");
    expect(serialized).not.toContain("snooze_conversation");
  });
});

describe("notifySlaBreach", () => {
  it("posts the overdue minutes", async () => {
    await notifySlaBreach({
      orgId: "org-1",
      conversationId: "conv-2",
      minutesOverdue: 42,
      severity: "warning",
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(JSON.stringify(input)).toContain("42");
  });
});

describe("sendSlackTestMessage", () => {
  it("verifies via auth.test, posts, and returns the workspace + team id", async () => {
    const result = await sendSlackTestMessage("org-1");
    expect(result).toEqual({
      ok: true,
      team: "Acme HME",
      teamId: "T999",
      channel: "C1",
    });
    expect(slackAuthTestMock).toHaveBeenCalledTimes(1);
    expect(postSlackMessageMock).toHaveBeenCalledTimes(1);
  });

  it("returns not_configured (no auth/post) when Slack is unset", async () => {
    setSlackEnv({} as NodeJS.ProcessEnv);
    const result = await sendSlackTestMessage("org-1");
    expect(result).toEqual({ ok: false, reason: "not_configured" });
    expect(slackAuthTestMock).not.toHaveBeenCalled();
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it("returns auth_failed (no post) when the bot token is rejected", async () => {
    slackAuthTestMock.mockResolvedValue({ ok: false, error: "invalid_auth" });
    const result = await sendSlackTestMessage("org-1");
    expect(result).toEqual({
      ok: false,
      reason: "auth_failed",
      error: "invalid_auth",
    });
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });

  it("surfaces a send failure with the Slack error code", async () => {
    postSlackMessageMock.mockResolvedValue({
      ok: false,
      error: "channel_not_found",
    });
    const result = await sendSlackTestMessage("org-1");
    expect(result).toEqual({
      ok: false,
      reason: "send_failed",
      error: "channel_not_found",
    });
  });
});

describe("notifyDeliveryFailureSpike", () => {
  it("posts the count + window with a triage link, critical severity", async () => {
    await notifyDeliveryFailureSpike({
      orgId: "org-1",
      count: 9,
      windowMinutes: 15,
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("9");
    expect(serialized).toContain("15 min");
    expect(serialized).toContain("🔴");
    expect(serialized).toContain(
      "https://tenant.example/admin/delivery-failures",
    );
  });
});

describe("notifyFeatureSuggestion", () => {
  it("posts title/area/priority under the slack.digests flag", async () => {
    await notifyFeatureSuggestion({
      orgId: "org-1",
      title: "Bulk export",
      area: "Billing",
      priority: "high",
    });
    expect(isFeatureEnabledMock).toHaveBeenCalledWith("slack.digests", "org-1");
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("Bulk export");
    expect(serialized).toContain("Billing");
    expect(serialized).toContain("high");
    // Platform-default assistant name, NOT the Penn-only "PennPilot".
    expect(serialized).toContain("CareMetric Copilot");
    expect(serialized).not.toContain("PennPilot");
  });
});

describe("notifyNpsDetractor", () => {
  it("posts score + order ref + comment flag, never the comment text", async () => {
    await notifyNpsDetractor({
      orgId: "org-1",
      orderId: "ord-5",
      score: 2,
      hasComment: true,
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("ord-5");
    expect(serialized).toContain("2/10");
    expect(serialized).toContain("read in admin");
    expect(serialized).toContain("https://tenant.example/admin/nps/recent");
  });

  it("uses critical severity for very low scores", async () => {
    await notifyNpsDetractor({
      orgId: "org-1",
      orderId: "ord-5",
      score: 1,
      hasComment: false,
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(JSON.stringify(input)).toContain("🔴");
  });
});

describe("notifyOpsDigest", () => {
  it("posts under the slack.digests flag to the digests channel when set", async () => {
    setSlackEnv({
      ...CONFIGURED,
      SLACK_DIGESTS_CHANNEL: "C-OPS",
    } as NodeJS.ProcessEnv);

    await notifyOpsDigest({
      orgId: undefined,
      severity: "critical",
      title: "🔴 Stuck jobs",
      lines: ["*Total:* 3"],
    });

    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "slack.digests",
      undefined,
    );
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(input.channel).toBe("C-OPS");
    expect(JSON.stringify(input)).toContain("Stuck jobs");
  });

  it("falls back to the default channel when no digests channel is set", async () => {
    await notifyOpsDigest({
      orgId: undefined,
      severity: "info",
      title: "📊 Weekly",
      lines: ["• Revenue: 100"],
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(input.channel).toBe("C1");
  });

  it("no-ops when the slack.digests flag is off", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    await notifyOpsDigest({
      orgId: undefined,
      severity: "info",
      title: "x",
      lines: ["y"],
    });
    expect(postSlackMessageMock).not.toHaveBeenCalled();
  });
});

describe("notifyReminderEscalation", () => {
  it("posts the patient id + channels with a patient deep link", async () => {
    await notifyReminderEscalation({
      orgId: "org-1",
      patientId: "pat-7",
      channelsTried: "SMS, email, and a call",
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("pat-7");
    expect(serialized).toContain("https://tenant.example/admin/patients/pat-7");
    expect(serialized).toContain("SMS, email, and a call");
  });
});
