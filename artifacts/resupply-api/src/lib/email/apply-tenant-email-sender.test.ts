import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveTenantLinkBaseUrlMock = vi.hoisted(() =>
  vi.fn<(orgId: string, platform: string) => Promise<string | null>>(),
);
const resolveTenantSenderMock = vi.hoisted(() =>
  vi.fn<
    (orgId: string | undefined) => Promise<{
      fromEmail: string | null;
      fromName: string | null;
    }>
  >(),
);

vi.mock("../tenant-branding", () => ({
  resolveTenantLinkBaseUrl: resolveTenantLinkBaseUrlMock,
}));

vi.mock("./tenant-sender", () => ({
  resolveTenantSender: resolveTenantSenderMock,
}));

import {
  applyTenantEmailSender,
  isPatientEmailClickBaseReady,
} from "./apply-tenant-email-sender";

const ORG_ID = "00000000-0000-4000-8000-000000000099";

describe("applyTenantEmailSender", () => {
  beforeEach(() => {
    resolveTenantLinkBaseUrlMock.mockReset();
    resolveTenantSenderMock.mockReset();
    resolveTenantSenderMock.mockResolvedValue({
      fromEmail: null,
      fromName: null,
    });
  });

  it("preserves cfg when orgId is unset", async () => {
    const cfg = {
      sendgridFromEmail: "noreply@cmbreathe.com",
      sendgridFromName: "CareMetric",
      publicBaseUrl: "https://cmbreathe.com",
    };
    const next = await applyTenantEmailSender(undefined, cfg);
    expect(next).toEqual(cfg);
    expect(resolveTenantLinkBaseUrlMock).not.toHaveBeenCalled();
  });

  it("uses tenant verified domain for click links", async () => {
    resolveTenantLinkBaseUrlMock.mockResolvedValueOnce("https://acme.example");
    const cfg = {
      sendgridFromEmail: "noreply@cmbreathe.com",
      sendgridFromName: "CareMetric",
      publicBaseUrl: "https://cmbreathe.com",
    };
    const next = await applyTenantEmailSender(ORG_ID, cfg);
    expect(next.publicBaseUrl).toBe("https://acme.example");
    expect(resolveTenantLinkBaseUrlMock).toHaveBeenCalledWith(
      ORG_ID,
      "https://cmbreathe.com",
    );
  });

  it("clears publicBaseUrl when non-seed tenant has no verified domain", async () => {
    resolveTenantLinkBaseUrlMock.mockResolvedValueOnce(null);
    const cfg = {
      sendgridFromEmail: "noreply@cmbreathe.com",
      sendgridFromName: "CareMetric",
      publicBaseUrl: "https://cmbreathe.com",
    };
    const next = await applyTenantEmailSender(ORG_ID, cfg);
    expect(next.publicBaseUrl).toBe("");
    expect(isPatientEmailClickBaseReady(next.publicBaseUrl)).toBe(false);
  });

  it("overrides From when tenant sender is configured", async () => {
    resolveTenantSenderMock.mockResolvedValueOnce({
      fromEmail: "info@acme.example",
      fromName: "Acme Sleep",
    });
    resolveTenantLinkBaseUrlMock.mockResolvedValueOnce("https://acme.example");
    const cfg = {
      sendgridFromEmail: "noreply@cmbreathe.com",
      sendgridFromName: "CareMetric",
      publicBaseUrl: "https://cmbreathe.com",
    };
    const next = await applyTenantEmailSender(ORG_ID, cfg);
    expect(next.sendgridFromEmail).toBe("info@acme.example");
    expect(next.sendgridFromName).toBe("Acme Sleep");
  });
});
