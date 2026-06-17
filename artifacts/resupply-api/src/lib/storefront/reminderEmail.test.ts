// Unit tests for the reminder email senders (reminderEmail.ts).
//
// We mock the SendGrid client factory at the @workspace/resupply-email
// boundary so the three senders are exercised with their real
// body/subject-building logic but never open a network socket.
// `createTenantSendgridClient()` (the per-tenant wrapper the senders now
// use) calls that same factory under the hood; with no Supabase env the
// tenant-sender lookup degrades to the platform default and reaches the
// mock, so we don't need a DB.
//
// Branding is mocked at ../tenant-branding.js (matching the proven
// send-order-confirmation-email.test.ts pattern) so the brand the copy
// renders is deterministic; it defaults to the seed tenant's
// "PennPaps" / "Penn Home Medical Supply".

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

// The reminder emails brand themselves with the tenant's storefront/legal
// name (G6). Control both here so the copy assertions are deterministic;
// defaults to the seed tenant's "PennPaps" / "Penn Home Medical Supply".
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

import {
  sendReminderConfirmation,
  sendReminderDue,
  sendReminderManageLink,
  type ReminderItemForEmail,
} from "./reminderEmail";

const ITEMS: ReminderItemForEmail[] = [
  {
    sku: "maskCushion",
    lastReplacedAt: "2026-04-01",
    intervalDays: 30,
    nextDueAt: "2026-05-01",
  },
];

describe("reminderEmail senders", () => {
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

  describe("sendReminderConfirmation", () => {
    it("renders the seed tenant's brand by default", async () => {
      const result = await sendReminderConfirmation({
        toEmail: "pat@example.com",
        manageToken: "tok-1",
        items: ITEMS,
      });

      expect(result).toEqual({ configured: true, delivered: true });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const arg = sendEmailMock.mock.calls[0]![0];
      expect(arg.subject).toBe(
        "You're signed up for PennPaps supply reminders",
      );
      expect(arg.text).toContain(
        "You're signed up for PennPaps supply reminders.",
      );
      expect(arg.text).toContain("— PennPaps by Penn Home Medical Supply");
    });

    it("flows a different tenant's brand into subject + body (G6)", async () => {
      brandNameRef.storefrontName = "Acme CPAP";
      brandNameRef.legalName = "Acme Medical LLC";

      await sendReminderConfirmation({
        toEmail: "pat@example.com",
        manageToken: "tok-1",
        items: ITEMS,
        orgId: "11111111-1111-4111-8111-111111111111",
      });

      const arg = sendEmailMock.mock.calls[0]![0];
      expect(arg.subject).toBe(
        "You're signed up for Acme CPAP supply reminders",
      );
      expect(arg.text).toContain("— Acme CPAP by Acme Medical LLC");
      expect(arg.subject).not.toContain("PennPaps");
      expect(arg.text).not.toContain("Penn Home Medical Supply");
    });
  });

  describe("sendReminderManageLink", () => {
    it("renders the seed tenant's brand by default", async () => {
      await sendReminderManageLink({
        toEmail: "pat@example.com",
        manageToken: "tok-2",
      });

      const arg = sendEmailMock.mock.calls[0]![0];
      expect(arg.subject).toBe("Your PennPaps reminders manage link");
      expect(arg.text).toContain("re-submitted the PennPaps reminder");
      expect(arg.text).toContain("— PennPaps by Penn Home Medical Supply");
    });

    it("flows a different tenant's brand into subject + body (G6)", async () => {
      brandNameRef.storefrontName = "Acme CPAP";
      brandNameRef.legalName = "Acme Medical LLC";

      await sendReminderManageLink({
        toEmail: "pat@example.com",
        manageToken: "tok-2",
        orgId: "11111111-1111-4111-8111-111111111111",
      });

      const arg = sendEmailMock.mock.calls[0]![0];
      expect(arg.subject).toBe("Your Acme CPAP reminders manage link");
      expect(arg.text).toContain("re-submitted the Acme CPAP reminder");
      expect(arg.subject).not.toContain("PennPaps");
    });
  });

  describe("sendReminderDue", () => {
    it("renders the seed tenant's brand by default", async () => {
      await sendReminderDue({
        toEmail: "pat@example.com",
        manageToken: "tok-3",
        dueItems: ITEMS,
      });

      const arg = sendEmailMock.mock.calls[0]![0];
      expect(arg.text).toContain(
        "Visit the PennPaps shop to order — or call Penn Home Medical Supply.",
      );
      expect(arg.text).toContain("— PennPaps by Penn Home Medical Supply");
    });

    it("flows a different tenant's brand into the body (G6)", async () => {
      brandNameRef.storefrontName = "Acme CPAP";
      brandNameRef.legalName = "Acme Medical LLC";

      await sendReminderDue({
        toEmail: "pat@example.com",
        manageToken: "tok-3",
        dueItems: ITEMS,
        orgId: "11111111-1111-4111-8111-111111111111",
      });

      const arg = sendEmailMock.mock.calls[0]![0];
      expect(arg.text).toContain(
        "Visit the Acme CPAP shop to order — or call Acme Medical LLC.",
      );
      expect(arg.text).toContain("— Acme CPAP by Acme Medical LLC");
      expect(arg.text).not.toContain("PennPaps");
    });
  });
});
