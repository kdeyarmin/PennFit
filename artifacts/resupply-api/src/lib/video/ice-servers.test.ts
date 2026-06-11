import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TwilioNtsClient } from "@workspace/resupply-telecom";

import {
  getIceServers,
  resetIceServerCacheForTest,
  resolveIceServers,
} from "./ice-servers";

const ENV_KEYS = [
  "RESUPPLY_TURN_URLS",
  "RESUPPLY_TURN_USERNAME",
  "RESUPPLY_TURN_CREDENTIAL",
] as const;

const TWILIO_TURN = {
  urls: ["turn:global.turn.twilio.com:3478?transport=udp"],
  username: "eph-user",
  credential: "eph-cred",
};

function fakeNts(create = vi.fn()): {
  client: TwilioNtsClient;
  create: ReturnType<typeof vi.fn>;
} {
  create.mockResolvedValue({ iceServers: [TWILIO_TURN], ttlSeconds: 86400 });
  return { client: { createIceToken: create }, create };
}

describe("ice-servers", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetIceServerCacheForTest();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetIceServerCacheForTest();
  });

  it("getIceServers returns STUN-only baseline without TURN env", () => {
    const servers = getIceServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.urls[0]).toMatch(/^stun:/);
  });

  it("static RESUPPLY_TURN_URLS wins and skips NTS entirely", async () => {
    process.env.RESUPPLY_TURN_URLS = "turn:relay.example.com:3478";
    process.env.RESUPPLY_TURN_USERNAME = "u";
    process.env.RESUPPLY_TURN_CREDENTIAL = "c";
    const { client, create } = fakeNts();
    const servers = await resolveIceServers({ ntsClientFactory: () => client });
    expect(create).not.toHaveBeenCalled();
    expect(servers).toContainEqual({
      urls: ["turn:relay.example.com:3478"],
      username: "u",
      credential: "c",
    });
  });

  it("appends Twilio NTS servers to the STUN baseline", async () => {
    const { client } = fakeNts();
    const servers = await resolveIceServers({ ntsClientFactory: () => client });
    expect(servers[0]!.urls[0]).toMatch(/^stun:/);
    expect(servers).toContainEqual(TWILIO_TURN);
  });

  it("caches the NTS token across calls and refreshes after expiry", async () => {
    const { client, create } = fakeNts();
    let nowMs = 1_000_000;
    const now = () => nowMs;
    await resolveIceServers({ ntsClientFactory: () => client, now });
    await resolveIceServers({ ntsClientFactory: () => client, now });
    expect(create).toHaveBeenCalledTimes(1);
    nowMs += 2 * 60 * 60 * 1000; // past the 1h cache window
    await resolveIceServers({ ntsClientFactory: () => client, now });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("falls back to STUN-only when Twilio is unconfigured", async () => {
    const servers = await resolveIceServers({ ntsClientFactory: () => null });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.urls[0]).toMatch(/^stun:/);
  });

  it("falls back to STUN-only when the NTS mint fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("twilio down"));
    const client: TwilioNtsClient = { createIceToken: create };
    const servers = await resolveIceServers({ ntsClientFactory: () => client });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.urls[0]).toMatch(/^stun:/);
  });
});
