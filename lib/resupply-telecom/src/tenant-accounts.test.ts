import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTwilioClient, TwilioConfigError } from "./client";
import { createTwilioSmsClient, type RawTwilioMessagingSdk } from "./sms";
import {
  readTenantTwilioAccounts,
  assertTenantTwilioReady,
  tenantTwilioAccountSummary,
  signTenantTwilioCallback,
  verifyTenantTwilioCallback,
  type TenantTwilioAccount,
} from "./tenant-accounts";

const account: TenantTwilioAccount = {
  orgId: "11111111-1111-4111-8111-111111111111",
  businessName: "Example DME",
  accountSid: "AC" + "1".repeat(32),
  parentAccountSid: "AC" + "0".repeat(32),
  apiKeySid: "SK" + "2".repeat(32),
  apiKeySecret: "secret".repeat(8),
  authToken: "token".repeat(8),
  numbers: ["+12125550101"],
  messagingServiceSids: ["MG" + "3".repeat(32)],
  state: "active",
  smsApproved: true,
};
function configure(overrides: Partial<TenantTwilioAccount> = {}) {
  vi.stubEnv(
    "TWILIO_TENANT_ACCOUNTS_JSON",
    JSON.stringify([{ ...account, ...overrides }]),
  );
}
beforeEach(() => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", account.parentAccountSid);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "parent-token");
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+12125550102");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "");
  vi.stubEnv("TWILIO_TENANT_CALLBACK_KEY", "key".repeat(16));
  configure();
});
afterEach(() => vi.unstubAllEnvs());

describe("tenant Twilio account boundaries", () => {
  it("reports staged and unapproved connections as configuration errors", () => {
    expect(() =>
      assertTenantTwilioReady({ ...account, state: "staged" }, "voice"),
    ).toThrow(TwilioConfigError);
    expect(() =>
      assertTenantTwilioReady({ ...account, smsApproved: false }, "sms"),
    ).toThrow(TwilioConfigError);
  });
  it("uses the tenant API key/account and signs voice callbacks", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "CAcall" });
    const factory = vi.fn(() => ({ calls: { create } }));
    const client = createTwilioClient({ sdkFactory: factory });
    await client.placeCall({
      to: "+12125550999",
      from: account.numbers[0]!,
      url: "https://example.com/voice?conversationId=owned",
      statusCallbackUrl: "https://example.com/status?conversationId=owned",
    });
    expect(factory).toHaveBeenLastCalledWith(
      account.apiKeySid,
      account.apiKeySecret,
      { accountSid: account.accountSid },
    );
    expect(
      verifyTenantTwilioCallback(create.mock.calls[0]![0].url, account),
    ).toBe(true);
    expect(
      verifyTenantTwilioCallback(
        create.mock.calls[0]![0].statusCallback,
        account,
      ),
    ).toBe(true);
  });
  it("uses the tenant SMS service and the same account for delivery polling", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SMsent" });
    const fetch = vi
      .fn()
      .mockResolvedValue({ sid: "SMsent", status: "delivered" });
    const messages = Object.assign(
      vi.fn(() => ({ fetch })),
      { create },
    );
    const factory = vi.fn(
      () => ({ messages }) as unknown as RawTwilioMessagingSdk,
    );
    const client = createTwilioSmsClient({
      messagingServiceSid: account.messagingServiceSids[0],
      sdkFactory: factory,
    });
    await client.sendSms({
      to: "+12125550999",
      body: "Requested information",
      statusCallbackUrl: "https://example.com/status",
    });
    expect(factory).toHaveBeenCalledWith(
      account.apiKeySid,
      account.apiKeySecret,
      { accountSid: account.accountSid },
    );
    expect(create.mock.calls[0]![0].from).toBeUndefined();
    expect(
      verifyTenantTwilioCallback(
        create.mock.calls[0]![0].statusCallback,
        account,
      ),
    ).toBe(true);
    expect((await client.confirmDelivery("SMsent")).delivered).toBe(true);
  });
  it("refuses pending SMS and staged voice without calling Twilio", async () => {
    configure({ smsApproved: false });
    const factory = vi.fn();
    expect(() =>
      createTwilioSmsClient({ from: account.numbers[0], sdkFactory: factory }),
    ).toThrow(/approval/);
    expect(factory).not.toHaveBeenCalled();
    configure({ state: "staged" });
    const create = vi.fn();
    const client = createTwilioClient({
      sdkFactory: () => ({ calls: { create } }),
    });
    await expect(
      client.placeCall({
        to: "+12125550999",
        from: account.numbers[0]!,
        url: "https://example.com/call",
      }),
    ).rejects.toThrow(/activation/);
    expect(create).not.toHaveBeenCalled();
  });
  it("rejects an override that would switch accounts", async () => {
    const create = vi.fn();
    const client = createTwilioSmsClient({
      from: account.numbers[0],
      sdkFactory: () =>
        ({ messages: { create } }) as unknown as RawTwilioMessagingSdk,
    });
    await expect(
      client.sendSms({ to: "+12125550999", body: "x", from: "+12125550102" }),
    ).rejects.toThrow(/accounts/);
    expect(create).not.toHaveBeenCalled();
  });
  it("retains the legacy parent connection for unmigrated numbers", async () => {
    const create = vi.fn().mockResolvedValue({ sid: "SMlegacy" });
    const factory = vi.fn(
      () => ({ messages: { create } }) as unknown as RawTwilioMessagingSdk,
    );
    const client = createTwilioSmsClient({ sdkFactory: factory });
    await client.sendSms({
      to: "+12125550999",
      body: "x",
      statusCallbackUrl: "https://example.com/status",
    });
    expect(factory).toHaveBeenCalledWith(
      account.parentAccountSid,
      "parent-token",
    );
    expect(create.mock.calls[0]![0].statusCallback).toBe(
      "https://example.com/status",
    );
  });
  it("rejects duplicate account/resource/tenant mappings and the shared support line", () => {
    vi.stubEnv(
      "TWILIO_TENANT_ACCOUNTS_JSON",
      JSON.stringify([account, account]),
    );
    expect(() => readTenantTwilioAccounts()).toThrow(/invalid/);
    configure({ numbers: ["+18775212890"] });
    expect(() => readTenantTwilioAccounts()).toThrow(/invalid/);
    configure({ parentAccountSid: "AC" + "9".repeat(32) });
    expect(() => readTenantTwilioAccounts()).toThrow(/invalid/);
  });
  it("never exposes credentials in summaries or invalid-configuration errors", () => {
    const summary = JSON.stringify(tenantTwilioAccountSummary(account.orgId));
    for (const secret of [
      account.apiKeySid,
      account.apiKeySecret,
      account.authToken,
    ])
      expect(summary).not.toContain(secret);
    vi.stubEnv("TWILIO_TENANT_ACCOUNTS_JSON", '{"secret":"do-not-echo"');
    expect(() => readTenantTwilioAccounts()).toThrow(
      /^Tenant Twilio configuration is invalid/,
    );
  });
  it("binds callback proofs to the account, route and all record identifiers", () => {
    const url = signTenantTwilioCallback(
      "https://example.com/status?conversationId=owned",
      account,
    );
    expect(verifyTenantTwilioCallback(url, account)).toBe(true);
    expect(
      verifyTenantTwilioCallback(url.replace("owned", "foreign"), account),
    ).toBe(false);
    expect(
      verifyTenantTwilioCallback(url.replace("/status?", "/other?"), account),
    ).toBe(false);
    expect(
      verifyTenantTwilioCallback(url, {
        ...account,
        accountSid: "AC" + "9".repeat(32),
      }),
    ).toBe(false);
    expect(
      verifyTenantTwilioCallback(
        url + "&cmAccount=" + account.accountSid,
        account,
      ),
    ).toBe(false);
  });
});
