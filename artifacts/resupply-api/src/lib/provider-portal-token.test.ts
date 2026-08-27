import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";

vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab"),
}));

import {
  signProviderPortalToken,
  verifyProviderPortalToken,
} from "./provider-portal-token";

describe("provider-portal-token", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips provider id, version, and org id", () => {
    const token = signProviderPortalToken(PROVIDER_ID, 3600, {
      portalLinkVersion: 2,
      orgId: ORG_A,
    });
    const v = verifyProviderPortalToken(token);
    expect(v).toEqual({
      valid: true,
      providerId: PROVIDER_ID,
      version: 2,
      orgId: ORG_A,
    });
  });

  it("legacy tokens without org id verify with orgId null", () => {
    const token = signProviderPortalToken(PROVIDER_ID, 3600, {
      portalLinkVersion: 0,
    });
    const v = verifyProviderPortalToken(token);
    expect(v).toEqual({
      valid: true,
      providerId: PROVIDER_ID,
      version: 0,
      orgId: null,
    });
  });

  it("rejects tampered org id", () => {
    const token = signProviderPortalToken(PROVIDER_ID, 3600, {
      orgId: ORG_A,
    });
    const [payload, sig] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { id: string; e: number; o: string };
    decoded.o = ORG_B;
    const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString(
      "base64url",
    );
    const v = verifyProviderPortalToken(`${tamperedPayload}.${sig}`);
    expect(v).toEqual({ valid: false });
  });
});
