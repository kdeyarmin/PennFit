import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import router from "./caremetric";

const db = installSupabaseMock();
const accountSid = `AC${"a".repeat(32)}`;
const id = "00000000-0000-4000-8000-000000000001";
const path = `/resupply-api/sms/caremetric-status?id=${id}`;
const payload = {
  MessageSid: `SM${"b".repeat(32)}`,
  AccountSid: accountSid,
  From: "+18775212890",
  MessageStatus: "delivered",
};
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use("/resupply-api", router);
beforeEach(() => {
  db.reset();
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  vi.stubEnv("TWILIO_ACCOUNT_SID", accountSid);
  vi.stubEnv("CAREMETRIC_PHONE_SMS_ENABLED", "true");
  vi.stubEnv(
    "CAREMETRIC_PHONE_SMS_MESSAGING_SERVICE_SID",
    `MG${"c".repeat(32)}`,
  );
});
afterEach(() => vi.unstubAllEnvs());
const post = (url: string, body: Record<string, string>) =>
  request(app)
    .post(url)
    .type("form")
    .set(
      "X-Twilio-Signature",
      twilio.getExpectedTwilioSignature(
        "test-token",
        `https://cmbreathe.com${url}`,
        body,
      ),
    )
    .send(body);

describe("shared business SMS webhooks", () => {
  it("rejects unsigned requests before any database write", async () => {
    expect(
      (await request(app).post(path).type("form").send(payload)).status,
    ).toBe(403);
    expect(db.callCount("shared_phone_sms", "update")).toBe(0);
  });
  it("persists a signed terminal status", async () => {
    expect((await post(path, payload)).status).toBe(200);
    expect(db.writePayloads("shared_phone_sms", "update")).toContainEqual(
      expect.objectContaining({
        delivery_status: "delivered",
        twilio_message_sid: payload.MessageSid,
      }),
    );
  });
  it.each([
    { From: "+18559542809" },
    { AccountSid: "another-account" },
    { MessageStatus: "sent" },
    { MessageSid: "SM,injection" },
  ])(
    "ignores callbacks outside the pinned sender/account/status",
    async (patch) => {
      expect((await post(path, { ...payload, ...patch })).status).toBe(200);
      expect(db.callCount("shared_phone_sms", "update")).toBe(0);
    },
  );
  it("allows safe webhook retries after a database failure", async () => {
    stageSupabaseResponse("shared_phone_sms", "update", {
      error: { code: "DB_DOWN" },
    });
    expect((await post(path, payload)).status).toBe(503);
  });
  it.each(["STOP", "stopall", "UNSUBSCRIBE", "REVOKE", "START", "UNSTOP"])(
    "does not duplicate provider handling for %s",
    async (Body) => {
      const res = await post("/resupply-api/sms/caremetric-inbound", {
        AccountSid: accountSid,
        To: "+18775212890",
        Body,
      });
      expect(res.text).toBe("<Response/>");
    },
  );
  it("does not send an extra response to Advanced Opt-Out callbacks", async () => {
    const res = await post("/resupply-api/sms/caremetric-inbound", {
      AccountSid: accountSid,
      To: "+18775212890",
      Body: "HELP",
      OptOutType: "HELP",
    });
    expect(res.text).toBe("<Response/>");
  });
  it("points help and ordinary replies to the shared support line", async () => {
    const res = await post("/resupply-api/sms/caremetric-inbound", {
      AccountSid: accountSid,
      To: "+18775212890",
      Body: "HELP",
    });
    expect(res.text).toContain("(877) 521-2890");
    expect(res.text).toContain("CareMetric");
    expect(res.text).not.toContain("patient name");
  });
  it("does not answer while the new SMS flow is disabled", async () => {
    vi.stubEnv("CAREMETRIC_PHONE_SMS_ENABLED", "false");
    expect(
      (
        await post("/resupply-api/sms/caremetric-inbound", {
          AccountSid: accountSid,
          To: "+18775212890",
          Body: "HELP",
        })
      ).text,
    ).toBe("<Response/>");
  });
  it("publishes the actual consent script with no caller details", async () => {
    const res = await request(app).get("/resupply-api/caremetric/texting");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Reply STOP to opt out or HELP for help");
    expect(res.text).toContain("waits for your confirmation");
  });
});
