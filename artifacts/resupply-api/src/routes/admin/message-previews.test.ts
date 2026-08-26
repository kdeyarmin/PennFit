// Route tests for /admin/message-previews.
//
// The GET is low-risk (it renders a pure catalog), so most of this file is
// about the POST, which performs a REAL outbound send. Its whole reason to
// exist is "let a tenant send the actual message to their own phone and
// see what a patient sees", so the things worth pinning are:
//
//   * it sends the CATALOG body, never caller-supplied text — this endpoint
//     must not become a way to text arbitrary content to arbitrary people;
//   * it sends under the TENANT's sender, so the test also shows the From
//     identity a patient would see;
//   * Twilio ACCEPTING a message is not delivery. A landline or blocked
//     number is accepted and then fails, so an accepted-but-undelivered
//     message must report failure, not success;
//   * an unconfigured vendor is a 200 with `ok: false`, not an exception —
//     the request succeeded, the send didn't.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import { resolveTenantLinkBaseUrl } from "../../lib/tenant-branding";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Rate limiters are no-ops here; they're exercised by their own tests.
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  adminWriteRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

// Brand resolution — a fixed tenant brand, so assertions can look for it.
vi.mock("../../lib/tenant-branding", () => ({
  resolveBrandingByOrgId: vi.fn(async () => ({
    storefrontName: "Riverside CPAP",
  })),
  resolveTenantLinkBaseUrl: vi.fn(
    async (_orgId: string, _platform: string) =>
      "https://shop.riverside.example",
  ),
}));
vi.mock("../../lib/company-info", () => ({
  getCompanyInfo: vi.fn(async () => ({
    // Deliberately different from the storefront brand — the reminder
    // scenarios must render THIS, like the worker does.
    name: "Riverside Home Medical",
    legalName: "Riverside Home Medical LLC",
    supportPhoneDisplay: "(215) 555-0100",
    supportEmail: "care@riverside.example",
  })),
}));

// Everything the hoisted vi.mock factories touch must be created INSIDE
// vi.hoisted — including the fake error classes, since the factories run
// before ordinary top-level declarations are initialized.
const {
  sendEmail,
  sendSms,
  confirmDelivery,
  emailCtl,
  smsCtl,
  FakeEmailConfigError,
  FakeTwilioConfigError,
} = vi.hoisted(() => ({
  // Typed with their real argument shapes so `mock.calls[0][0]` is
  // inspectable — asserting WHAT was sent is the point of these tests.
  sendEmail: vi.fn(
    async (_input: {
      to: string;
      subject: string;
      html: string;
      text: string;
    }) => ({ messageId: "msg_1" }),
  ),
  sendSms: vi.fn(async (_input: { to: string; body: string }) => ({
    messageSid: "SM123",
  })),
  confirmDelivery: vi.fn(async (_sid: string) => ({
    status: "delivered",
    errorCode: null as number | null,
    errorMessage: null as string | null,
    terminal: true,
    delivered: true,
  })),
  // Flip these to make a vendor look unconfigured.
  emailCtl: { configured: true },
  smsCtl: { configured: true },
  FakeEmailConfigError: class extends Error {},
  FakeTwilioConfigError: class extends Error {},
}));

// Only the SendGrid wire is faked. The layout helpers (renderBrandedEmail
// and friends) are pure string builders that the preview catalog renders
// through, so they pass through from the real module.
vi.mock("@workspace/resupply-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/resupply-email")>()),
  EmailConfigError: FakeEmailConfigError,
  DEFAULT_SENDGRID_FROM_EMAIL: "noreply@cmbreathe.com",
}));
vi.mock("@workspace/resupply-telecom", () => ({
  TwilioConfigError: FakeTwilioConfigError,
  createTwilioSmsClient: () => {
    if (!smsCtl.configured) {
      throw new FakeTwilioConfigError("TWILIO_ACCOUNT_SID is not set");
    }
    return { sendSms, confirmDelivery };
  },
}));
vi.mock("../../lib/email/tenant-sender", () => ({
  createTenantSendgridClient: async () => {
    if (!emailCtl.configured) {
      throw new FakeEmailConfigError("SENDGRID_API_KEY is not set");
    }
    return { sendEmail };
  },
  resolveTenantSender: async () => ({ fromEmail: "care@riverside.example" }),
}));
vi.mock("../../lib/messaging/tenant-telecom", () => ({
  resolveTenantSmsClientOptions: async () => ({ from: "+12155550100" }),
  resolveTenantSmsFrom: async () => ({ from: "+12155550100" }),
}));

import messagePreviewsRouter from "./message-previews";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(messagePreviewsRouter);
  return app;
}

const ADMIN: MockAdminCtx = {
  userId: "u1",
  email: "owner@riverside.example",
  role: "admin",
  orgId: "org-1",
};

beforeEach(() => {
  mockAdmin.current = ADMIN;
  emailCtl.configured = true;
  smsCtl.configured = true;
  sendEmail.mockClear();
  sendSms.mockClear();
  confirmDelivery.mockClear();
  confirmDelivery.mockResolvedValue({
    status: "delivered",
    errorCode: null,
    errorMessage: null,
    terminal: true,
    delivered: true,
  });
});

describe("GET /admin/message-previews", () => {
  it("401s without an admin session", async () => {
    mockAdmin.current = null;
    await request(makeApp()).get("/admin/message-previews").expect(401);
  });

  it("renders the catalog with the tenant's brand", async () => {
    const res = await request(makeApp())
      .get("/admin/message-previews")
      .expect(200);
    expect(res.body.brand.name).toBe("Riverside CPAP");
    expect(res.body.previews.length).toBeGreaterThan(10);
    const blob = JSON.stringify(res.body.previews);
    expect(blob).toContain("Riverside CPAP");
    // Never the seed tenant's brand on another tenant's previews.
    expect(blob).not.toContain("Penn Home Medical Supply");
  });

  it("reports which channels can actually send, and from what identity", async () => {
    const res = await request(makeApp())
      .get("/admin/message-previews")
      .expect(200);
    expect(res.body.sending.email).toEqual({
      configured: true,
      from: "care@riverside.example",
    });
    expect(res.body.sending.sms).toEqual({
      configured: true,
      from: "+12155550100",
    });
  });

  it("reports tenantDomainRequired when click base is unavailable", async () => {
    vi.mocked(resolveTenantLinkBaseUrl).mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .get("/admin/message-previews")
      .expect(200);
    expect(res.body.tenantDomainRequired).toBe(true);
    expect(res.body.brand.baseUrl).toBe("");
  });

  it("reports a channel as unconfigured instead of failing the page", async () => {
    emailCtl.configured = false;
    smsCtl.configured = false;
    const res = await request(makeApp())
      .get("/admin/message-previews")
      .expect(200);
    expect(res.body.sending.email.configured).toBe(false);
    expect(res.body.sending.sms.configured).toBe(false);
    // The gallery still renders — you can read the copy without being able
    // to send it.
    expect(res.body.previews.length).toBeGreaterThan(10);
  });
});

describe("POST /admin/message-previews/:id/send — email", () => {
  it("sends the catalog body to the address the operator typed", async () => {
    const res = await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "email", to: "owner@riverside.example" })
      .expect(200);
    expect(res.body.ok).toBe(true);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0][0];
    expect(sent.to).toBe("owner@riverside.example");
    // The body is the catalog's, carrying the tenant brand.
    expect(sent.subject).toBe("Time to refill your CPAP supplies");
    // Reminders carry the COMPANY identity (getCompanyInfo().name), which
    // a tenant configures separately from the storefront brand — the same
    // name the production reminder worker uses.
    expect(sent.text).toContain("Riverside Home Medical");
    expect(sent.html).toContain("<");
  });

  it("cannot be used to send caller-supplied content", async () => {
    await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({
        channel: "email",
        to: "owner@riverside.example",
        subject: "Pay me now",
        html: "<b>malicious</b>",
        body: "malicious",
      })
      // `.strict()` on the body schema rejects the extra keys outright.
      .expect(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("rejects email send when tenant domain is required", async () => {
    vi.mocked(resolveTenantLinkBaseUrl).mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "email", to: "owner@riverside.example" })
      .expect(422);
    expect(res.body.error).toBe("tenant_domain_required");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("reports an unconfigured provider as ok:false, not an error", async () => {
    emailCtl.configured = false;
    const res = await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "email", to: "owner@riverside.example" })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe("not_configured");
    expect(res.body.message).toMatch(/SendGrid/i);
  });

  it("rejects a malformed address before touching the provider", async () => {
    await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "email", to: "not-an-address" })
      .expect(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("400s for a scenario that has no email variant", async () => {
    // Therapy setup deadline is SMS-only.
    await request(makeApp())
      .post("/admin/message-previews/clinical.setup_deadline/send")
      .send({ channel: "email", to: "owner@riverside.example" })
      .expect(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("404s an unknown scenario id", async () => {
    await request(makeApp())
      .post("/admin/message-previews/nope.not.real/send")
      .send({ channel: "email", to: "owner@riverside.example" })
      .expect(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("401s without an admin session", async () => {
    mockAdmin.current = null;
    await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "email", to: "owner@riverside.example" })
      .expect(401);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST /admin/message-previews/:id/send — SMS", () => {
  it("sends the catalog body and confirms it actually landed", async () => {
    const res = await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "sms", to: "+12155551234" })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.delivered).toBe(true);
    expect(res.body.deliveryStatus).toBe("delivered");
    // One segment: the initial reminder copy was tightened so it still
    // fits GSM-7's 160 septets with a long practice name like "Riverside
    // Home Medical". catalog.test.ts pins the spill-over case with a
    // longer name still.
    expect(res.body.segments).toBe(1);

    const sent = sendSms.mock.calls[0][0];
    expect(sent.to).toBe("+12155551234");
    expect(sent.body).toContain("Riverside Home Medical");
    expect(sent.body).toContain("STOP to opt out");
    // Delivery was confirmed against the sid Twilio returned.
    expect(confirmDelivery).toHaveBeenCalledWith("SM123");
  });

  it("reports failure when the carrier accepted then did not deliver", async () => {
    // The case that makes acceptance-only reporting misleading: Twilio says
    // 200, the handset never gets it.
    confirmDelivery.mockResolvedValue({
      status: "undelivered",
      errorCode: 30003,
      errorMessage: "Unreachable destination handset",
      terminal: true,
      delivered: false,
    });
    const res = await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "sms", to: "+12155551234" })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe("undelivered");
    expect(res.body.message).toContain("Unreachable destination handset");
  });

  it("explains a carrier rejection that carries no message of its own", async () => {
    confirmDelivery.mockResolvedValue({
      status: "failed",
      errorCode: null,
      errorMessage: null,
      terminal: true,
      delivered: false,
    });
    const res = await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "sms", to: "+12155551234" })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/landline|VoIP|failed/i);
  });

  it("still reports success when delivery is merely still in flight", async () => {
    // Non-terminal inside the poll window is not a failure — the message is
    // on its way, we just stopped waiting.
    confirmDelivery.mockResolvedValue({
      status: "sent",
      errorCode: null,
      errorMessage: null,
      terminal: false,
      delivered: false,
    });
    const res = await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "sms", to: "+12155551234" })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.delivered).toBe(false);
    expect(res.body.deliveryStatus).toBe("sent");
  });

  it("reports an unconfigured Twilio as ok:false", async () => {
    smsCtl.configured = false;
    const res = await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "sms", to: "+12155551234" })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe("not_configured");
    expect(res.body.message).toMatch(/Twilio/i);
  });

  it("rejects a non-E.164 number before touching the provider", async () => {
    for (const to of ["2155551234", "+1", "not a phone"]) {
      await request(makeApp())
        .post("/admin/message-previews/resupply.reminder.initial/send")
        .send({ channel: "sms", to })
        .expect(400);
    }
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("400s for a scenario that has no SMS variant", async () => {
    // The billing statement is email-only.
    await request(makeApp())
      .post("/admin/message-previews/billing.statement/send")
      .send({ channel: "sms", to: "+12155551234" })
      .expect(400);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("rejects an unknown channel", async () => {
    await request(makeApp())
      .post("/admin/message-previews/resupply.reminder.initial/send")
      .send({ channel: "carrier-pigeon", to: "+12155551234" })
      .expect(400);
    expect(sendSms).not.toHaveBeenCalled();
  });
});
