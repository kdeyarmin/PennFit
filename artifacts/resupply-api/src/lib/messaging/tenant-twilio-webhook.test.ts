import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  signTenantTwilioCallback,
  type TenantTwilioAccount,
} from "@workspace/resupply-telecom";
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("./tenant-telecom", () => ({ resolveOrgIdByCalledNumber: lookup }));
import { requireTenantTwilioSignature } from "./tenant-twilio-webhook";
const account: TenantTwilioAccount = {
  orgId: "11111111-1111-4111-8111-111111111111",
  businessName: "Example",
  accountSid: "AC" + "1".repeat(32),
  parentAccountSid: "AC" + "0".repeat(32),
  apiKeySid: "SK" + "2".repeat(32),
  apiKeySecret: "secret".repeat(8),
  authToken: "token".repeat(8),
  numbers: ["+12125550101"],
  messagingServiceSids: [],
  state: "active",
  smsApproved: true,
};
const origin = "https://example.com";
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(
  requireTenantTwilioSignature({
    getAuthToken: () => "parent-token",
    buildPublicUrl: (req) => origin + req.originalUrl,
  }),
);
app.use((req, res) => res.json({ orgId: req.orgId ?? null }));
beforeEach(() => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", account.parentAccountSid);
  vi.stubEnv("TWILIO_TENANT_CALLBACK_KEY", "callback-key".repeat(5));
  vi.stubEnv("TWILIO_TENANT_ACCOUNTS_JSON", JSON.stringify([account]));
  lookup.mockResolvedValue(account.orgId);
});
afterEach(() => vi.unstubAllEnvs());
function post(
  path: string,
  body: Record<string, string>,
  token = account.authToken,
) {
  const canonical =
    origin +
    path +
    Object.keys(body)
      .sort()
      .map((key) => key + body[key])
      .join("");
  return request(app)
    .post(path)
    .type("form")
    .set(
      "X-Twilio-Signature",
      createHmac("sha1", token).update(canonical).digest("base64"),
    )
    .send(body);
}
it("authenticates and binds a tenant's inbound number", async () => {
  const result = await post("/sms/inbound", {
    AccountSid: account.accountSid,
    To: account.numbers[0]!,
    Body: "HELP",
  });
  expect(result.status).toBe(200);
  expect(result.body.orgId).toBe(account.orgId);
});
it("rejects another tenant's number even with a valid account signature", async () => {
  expect(
    (
      await post("/sms/inbound", {
        AccountSid: account.accountSid,
        To: "+12125550102",
      })
    ).status,
  ).toBe(403);
  lookup.mockResolvedValue("foreign-tenant");
  expect(
    (
      await post("/sms/inbound", {
        AccountSid: account.accountSid,
        To: account.numbers[0]!,
      })
    ).status,
  ).toBe(403);
});
it("rejects child requests signed with the parent token and unknown accounts", async () => {
  expect(
    (
      await post(
        "/sms/inbound",
        { AccountSid: account.accountSid, To: account.numbers[0]! },
        "parent-token",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await post("/sms/inbound", {
        AccountSid: "AC" + "9".repeat(32),
        To: account.numbers[0]!,
      })
    ).status,
  ).toBe(403);
});
it("requires the platform proof for outbound callbacks", async () => {
  const path = "/voice/status-callback?conversationId=owned";
  expect(
    (await post(path, { AccountSid: account.accountSid, CallSid: "CAcall" }))
      .status,
  ).toBe(403);
  const signed = signTenantTwilioCallback(origin + path, account).slice(
    origin.length,
  );
  expect(
    (await post(signed, { AccountSid: account.accountSid, CallSid: "CAcall" }))
      .status,
  ).toBe(200);
  // Re-signing a changed Twilio request with the tenant's own token is not enough.
  expect(
    (
      await post(signed.replace("owned", "foreign"), {
        AccountSid: account.accountSid,
        CallSid: "CAcall",
      })
    ).status,
  ).toBe(403);
});
it("fails closed on lookup failure or staged connection", async () => {
  lookup.mockRejectedValue(new Error("database offline"));
  expect(
    (
      await post("/sms/inbound", {
        AccountSid: account.accountSid,
        To: account.numbers[0]!,
      })
    ).status,
  ).toBe(403);
  vi.stubEnv(
    "TWILIO_TENANT_ACCOUNTS_JSON",
    JSON.stringify([{ ...account, state: "staged" }]),
  );
  expect(
    (
      await post("/sms/inbound", {
        AccountSid: account.accountSid,
        To: account.numbers[0]!,
      })
    ).status,
  ).toBe(403);
});
it("keeps unmigrated parent callbacks working and refuses parent use of tenant numbers", async () => {
  expect(
    (
      await post(
        "/sms/inbound",
        { AccountSid: account.parentAccountSid, To: "+12125550102" },
        "parent-token",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post(
        "/sms/inbound",
        { AccountSid: account.parentAccountSid, To: account.numbers[0]! },
        "parent-token",
      )
    ).status,
  ).toBe(403);
});
