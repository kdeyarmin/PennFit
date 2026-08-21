// Unit tests for sendFitterOrderConfirmationEmail.
//
// Mocks the tenant SendGrid factory so we exercise escaping / size
// copy without opening a network socket.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmailMock = vi.fn();
const createTenantSendgridClientMock = vi.fn(async (_orgId?: string) => ({
  sendEmail: sendEmailMock,
}));
vi.mock("../email/tenant-sender.js", () => ({
  createTenantSendgridClient: (orgId?: string) =>
    createTenantSendgridClientMock(orgId),
}));

const brandNameRef = vi.hoisted(() => ({ value: "PennPaps" }));
vi.mock("../tenant-branding.js", () => ({
  resolveBrandingByOrgId: vi.fn(async () => ({
    storefrontName: brandNameRef.value,
    legalName: brandNameRef.value,
    tagline: "tagline",
    logoUrl: null,
  })),
  resolveTenantBaseUrl: vi.fn(async () => null),
}));

import { EmailConfigError } from "@workspace/resupply-email";

import { sendFitterOrderConfirmationEmail } from "./send-fitter-order-confirmation-email";

const ENV_KEYS = ["SHOP_PUBLIC_BASE_URL"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("sendFitterOrderConfirmationEmail", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    process.env.SHOP_PUBLIC_BASE_URL = "https://test.example.com";
    brandNameRef.value = "PennPaps";
    sendEmailMock.mockReset();
    createTenantSendgridClientMock.mockReset();
    createTenantSendgridClientMock.mockImplementation(
      async (_orgId?: string) => ({
        sendEmail: sendEmailMock,
      }),
    );
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("includes recommended size in text and HTML when provided", async () => {
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_fitter_1" });
    const result = await sendFitterOrderConfirmationEmail({
      toEmail: "pat@example.com",
      firstName: "Pat",
      orderReference: "PENN-AB1234",
      maskName: "AirFit F20",
      maskManufacturer: "ResMed",
      maskSize: "Medium",
    });
    expect(result).toEqual({
      configured: true,
      delivered: true,
      messageId: "msg_fitter_1",
    });
    const sent = sendEmailMock.mock.calls[0]?.[0] as {
      text: string;
      html: string;
    };
    expect(sent.text).toContain("Selected mask: ResMed AirFit F20");
    expect(sent.text).toContain("Recommended size: Medium");
    expect(sent.html).toContain("ResMed AirFit F20");
    expect(sent.html).toContain("Recommended size: Medium");
  });

  it("omits the size line when the fitter did not resolve one", async () => {
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_fitter_2" });
    await sendFitterOrderConfirmationEmail({
      toEmail: "pat@example.com",
      orderReference: "PENN-CD5678",
      maskName: "AirFit P10",
      maskManufacturer: "ResMed",
    });
    const sent = sendEmailMock.mock.calls[0]?.[0] as {
      text: string;
      html: string;
    };
    expect(sent.text).toContain("Selected mask: ResMed AirFit P10");
    expect(sent.text).not.toContain("Recommended size:");
    expect(sent.html).not.toContain("Recommended size:");
  });

  it("returns configured=false when SendGrid is not wired", async () => {
    createTenantSendgridClientMock.mockImplementation(async () => {
      throw new EmailConfigError("SENDGRID_API_KEY is not set");
    });
    const result = await sendFitterOrderConfirmationEmail({
      toEmail: "pat@example.com",
      orderReference: "PENN-EF9012",
      maskName: "AirFit N20",
    });
    expect(result.configured).toBe(false);
    expect(result.delivered).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
