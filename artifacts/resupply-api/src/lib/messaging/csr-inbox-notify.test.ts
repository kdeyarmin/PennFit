import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmailMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<{ messageId: string }>>(async () => ({
    messageId: "sg_csr_1",
  })),
);
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => ({ sendEmail: sendEmailMock }),
  };
});

import { DEFAULT_STOREFRONT_ASSISTANT_NAME } from "../company-info.js";
import { notifyCsrInboxOfCustomerMessage } from "./csr-inbox-notify.js";

beforeEach(() => {
  sendEmailMock.mockClear();
  process.env["SHOP_CSR_INBOX_EMAIL"] = "csr@example.com";
  delete process.env["SHOP_PUBLIC_BASE_URL"];
});

afterEach(() => {
  delete process.env["SHOP_CSR_INBOX_EMAIL"];
  delete process.env["SHOP_PUBLIC_BASE_URL"];
});

describe("notifyCsrInboxOfCustomerMessage", () => {
  it("falls back to the platform storefront assistant name in chatbot subjects", async () => {
    await notifyCsrInboxOfCustomerMessage({
      threadId: "conv_1",
      threadCreated: true,
      customerEmail: "pat@example.com",
      customerDisplayName: "Pat",
      source: "chatbot",
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const payload = sendEmailMock.mock.calls[0]![0] as { subject: string };
    expect(payload.subject).toContain(
      `(via ${DEFAULT_STOREFRONT_ASSISTANT_NAME})`,
    );
    expect(payload.subject).not.toMatch(/via assistant\)/);
  });

  it("uses the tenant-resolved assistant name when provided", async () => {
    await notifyCsrInboxOfCustomerMessage({
      threadId: "conv_1",
      threadCreated: false,
      customerEmail: "pat@example.com",
      customerDisplayName: "Pat",
      source: "chatbot",
      assistantName: "Acme Assistant",
    });
    const payload = sendEmailMock.mock.calls[0]![0] as { subject: string };
    expect(payload.subject).toContain("(via Acme Assistant)");
    expect(payload.subject).not.toContain(DEFAULT_STOREFRONT_ASSISTANT_NAME);
  });
});
