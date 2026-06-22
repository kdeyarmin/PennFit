import { describe, expect, it } from "vitest";

import { readSlackConfigOrNull, readSlackSigningSecretOrNull } from "./config";

describe("readSlackConfigOrNull", () => {
  it("returns null when the bot token is missing", () => {
    expect(readSlackConfigOrNull({ SLACK_ALERTS_CHANNEL: "C123" })).toBeNull();
  });

  it("returns null when the default channel is missing", () => {
    expect(readSlackConfigOrNull({ SLACK_BOT_TOKEN: "xoxb-1" })).toBeNull();
  });

  it("returns null on an empty/whitespace token (no boot throw)", () => {
    expect(
      readSlackConfigOrNull({
        SLACK_BOT_TOKEN: "   ",
        SLACK_ALERTS_CHANNEL: "C123",
      }),
    ).toBeNull();
  });

  it("reads token + channel and trims them", () => {
    expect(
      readSlackConfigOrNull({
        SLACK_BOT_TOKEN: " xoxb-abc ",
        SLACK_ALERTS_CHANNEL: " C123 ",
      }),
    ).toEqual({
      botToken: "xoxb-abc",
      defaultChannel: "C123",
      signingSecret: null,
    });
  });

  it("includes the signing secret when present", () => {
    expect(
      readSlackConfigOrNull({
        SLACK_BOT_TOKEN: "xoxb-abc",
        SLACK_ALERTS_CHANNEL: "C123",
        SLACK_SIGNING_SECRET: "shh",
      }),
    ).toEqual({
      botToken: "xoxb-abc",
      defaultChannel: "C123",
      signingSecret: "shh",
    });
  });
});

describe("readSlackSigningSecretOrNull", () => {
  it("returns null when unset or blank", () => {
    expect(readSlackSigningSecretOrNull({})).toBeNull();
    expect(
      readSlackSigningSecretOrNull({ SLACK_SIGNING_SECRET: " " }),
    ).toBeNull();
  });

  it("returns the trimmed secret when set", () => {
    expect(
      readSlackSigningSecretOrNull({ SLACK_SIGNING_SECRET: " shh " }),
    ).toBe("shh");
  });
});
