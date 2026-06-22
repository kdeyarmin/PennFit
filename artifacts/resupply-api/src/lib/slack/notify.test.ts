// Tests for the Slack CS-alert notifier glue.
//
// Coverage:
//   * No-op when the slack.notifications flag is off.
//   * No-op when Slack is unconfigured (no bot token).
//   * Posts a non-PHI message with a deep link when configured + enabled.
//   * Offers an Escalate button only when a signing secret is present.
//   * Voice handoff maps distressed sentiment → critical severity.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../feature-flags", () => ({ isFeatureEnabled: vi.fn() }));
vi.mock("../app-config/store", () => ({ getEffectiveEnv: vi.fn() }));
vi.mock("../tenant-branding", () => ({ resolveTenantBaseUrl: vi.fn() }));
vi.mock("@workspace/resupply-integrations-slack", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@workspace/resupply-integrations-slack")
    >();
  return { ...actual, postSlackMessage: vi.fn() };
});

import { postSlackMessage } from "@workspace/resupply-integrations-slack";

import { getEffectiveEnv } from "../app-config/store";
import { isFeatureEnabled } from "../feature-flags";
import { resolveTenantBaseUrl } from "../tenant-branding";
import {
  notifyConversationNeedsHuman,
  notifyDeliveryFailureSpike,
  notifyNpsDetractor,
  notifyOpsDigest,
  notifyReminderEscalation,
  notifySlaBreach,
  notifyVoiceHandoff,
} from "./notify";

const isFeatureEnabledMock = vi.mocked(isFeatureEnabled);
const getEffectiveEnvMock = vi.mocked(getEffectiveEnv);
const resolveTenantBaseUrlMock = vi.mocked(resolveTenantBaseUrl);
const postSlackMessageMock = vi.mocked(postSlackMessage);

const CONFIGURED = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_ALERTS_CHANNEL: "C1",
  SLACK_SIGNING_SECRET: "shh",
} as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabledMock.mockResolvedValue(true);
  getEffectiveEnvMock.mockResolvedValue(CONFIGURED);
  resolveTenantBaseUrlMock.mockResolvedValue("https://tenant.example");
  postSlackMessageMock.mockResolvedValue({ ok: true, ts: "1" });
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
    expect(serialized).toContain("escalate_conversation");
    expect(serialized).toContain("snooze_conversation");
    // Non-PHI: the reason/channel we passed are present, nothing else leaks.
    expect(serialized).toContain("address change");
  });

  it("omits the Escalate button when no signing secret is configured", async () => {
    getEffectiveEnvMock.mockResolvedValue({
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
    getEffectiveEnvMock.mockResolvedValue({} as NodeJS.ProcessEnv);
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

  it("does not offer an Escalate button (already escalated)", async () => {
    await notifyVoiceHandoff({
      orgId: "org-1",
      conversationId: "conv-1",
      sentiment: "neutral",
      outcome: "ok",
    });
    const [, input] = postSlackMessageMock.mock.calls[0]!;
    expect(JSON.stringify(input)).not.toContain("escalate_conversation");
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
    getEffectiveEnvMock.mockResolvedValue({
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
