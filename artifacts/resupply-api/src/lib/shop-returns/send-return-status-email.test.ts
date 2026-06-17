// Unit tests for sendReturnStatusEmail.
//
// We mock the SendGrid client factory at the @workspace/resupply-email
// boundary so the helper is exercised with its real escaping / body-
// building / branching logic but never opens a network socket.
// `createTenantSendgridClient()` (the per-tenant wrapper) calls that same
// factory under the hood; with no Supabase env the tenant-sender lookup
// degrades to the platform default and reaches the mock, so no DB.
//
// Branding is mocked at ../tenant-branding.js (matching the proven
// send-order-confirmation-email.test.ts pattern) so the brand the copy
// renders is deterministic; it defaults to the seed tenant's "PennPaps".

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmailMock = vi.fn();
const createSendgridClientMock = vi.fn<
  () => { sendEmail: typeof sendEmailMock }
>(() => ({ sendEmail: sendEmailMock }));
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => createSendgridClientMock(),
  };
});

// The return-status email brands itself with the tenant's storefront name
// (G6). Control it here so the copy assertions are deterministic; defaults
// to the seed tenant's "PennPaps".
const brandNameRef = vi.hoisted(() => ({
  storefrontName: "PennPaps",
  legalName: "Penn Home Medical Supply",
}));
vi.mock("../tenant-branding.js", () => ({
  resolveBrandingByOrgId: vi.fn(async () => ({
    storefrontName: brandNameRef.storefrontName,
    legalName: brandNameRef.legalName,
    tagline: "tagline",
    logoUrl: null,
  })),
}));

import { sendReturnStatusEmail } from "./send-return-status-email";

describe("sendReturnStatusEmail", () => {
  beforeEach(() => {
    brandNameRef.storefrontName = "PennPaps";
    brandNameRef.legalName = "Penn Home Medical Supply";
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({ messageId: "msg_test" });
    createSendgridClientMock.mockReset();
    createSendgridClientMock.mockImplementation(() => ({
      sendEmail: sendEmailMock,
    }));
  });

  it("brands the approved email with the seed tenant's storefront name by default", async () => {
    const result = await sendReturnStatusEmail({
      kind: "approved",
      toEmail: "buyer@example.com",
      returnId: "ret-1",
      stripeSessionId: "cs_test_12345678",
      returnCarrier: "UPS",
      returnTrackingNumber: "1Z999",
      returnLabelUrl: "https://labels.example/label.pdf",
    });

    expect(result).toMatchObject({ configured: true, delivered: true });
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe("Your PennPaps return is approved");
    expect(arg.html).toContain(">PennPaps<");
    expect(arg.customArgs).toEqual({
      kind: "return_approved_v1",
      return_id: "ret-1",
    });
  });

  it("brands the refunded email with the seed tenant's storefront name by default", async () => {
    await sendReturnStatusEmail({
      kind: "refunded",
      toEmail: "buyer@example.com",
      returnId: "ret-2",
      stripeSessionId: "cs_test_87654321",
      refundCents: 4500,
      currency: "usd",
    });

    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe("Your PennPaps refund is on the way");
    expect(arg.text).toContain("appear on your statement under PennPaps.");
    expect(arg.html).toContain("<strong>PennPaps</strong>");
  });

  it("flows a different tenant's brand into subject + body (G6)", async () => {
    brandNameRef.storefrontName = "Acme CPAP";
    brandNameRef.legalName = "Acme Medical LLC";

    await sendReturnStatusEmail({
      kind: "refunded",
      toEmail: "buyer@example.com",
      returnId: "ret-3",
      stripeSessionId: "cs_test_99999999",
      refundCents: 9000,
      currency: "usd",
      orgId: "11111111-1111-4111-8111-111111111111",
    });

    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe("Your Acme CPAP refund is on the way");
    expect(arg.text).toContain("appear on your statement under Acme CPAP.");
    expect(arg.html).toContain("<strong>Acme CPAP</strong>");
    expect(arg.subject).not.toContain("PennPaps");
  });

  it("HTML-escapes a hostile storefront name", async () => {
    brandNameRef.storefrontName = "<script>alert('x')</script>";
    brandNameRef.legalName = "Legal";

    await sendReturnStatusEmail({
      kind: "approved",
      toEmail: "buyer@example.com",
      returnId: "ret-4",
      stripeSessionId: "cs_test_11112222",
    });

    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.html).not.toContain("<script>alert");
    expect(arg.html).toContain("&lt;script&gt;");
  });
});
