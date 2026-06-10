// Tests for the daily "ready to sync to PacWare" digest.
//
// Coverage for `runPacwareReadyToSyncDigest()` — all outcomes:
//   * no recipient configured        → skipped (no_recipient)
//   * operator hasn't opted in       → skipped (auto_sync_off)
//   * auto-sync read errors          → skipped (auto_sync_off, fail-soft)
//   * nothing confirmed              → skipped (nothing_ready)
//   * SendGrid not configured        → skipped (sendgrid_not_configured)
//   * happy path                     → one counts-only email
// plus the PHI contract: the email carries the COUNT only — no
// references, names, or SKUs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const sendEmailMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<unknown>>(async () => undefined),
);
const createSendgridClientMock = vi.hoisted(() =>
  vi.fn(() => ({ sendEmail: sendEmailMock })),
);
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: (...args: unknown[]) =>
      createSendgridClientMock(
        ...(args as Parameters<typeof createSendgridClientMock>),
      ),
  };
});

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EmailConfigError } from "@workspace/resupply-email";

import { runPacwareReadyToSyncDigest } from "./pacware-ready-to-sync-digest";

const ENV_KEY = "RESUPPLY_ADMIN_ALERTS_EMAIL";
let originalRecipient: string | undefined;

function stageAutoSync(value: string | null, error?: unknown): void {
  stageSupabaseResponse("app_config", "select", {
    data: value === null ? null : { value },
    error: error ?? null,
  });
}

function stageConfirmedCount(count: number): void {
  stageSupabaseResponse("episodes", "select", { data: null, count });
}

beforeEach(() => {
  originalRecipient = process.env[ENV_KEY];
  process.env[ENV_KEY] = "ops@penn.example.com";
  supabaseMock.reset();
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue(undefined);
  createSendgridClientMock.mockReset();
  createSendgridClientMock.mockImplementation(() => ({
    sendEmail: sendEmailMock,
  }));
});

afterEach(() => {
  if (originalRecipient === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalRecipient;
});

describe("runPacwareReadyToSyncDigest", () => {
  it("skips when no recipient is configured", async () => {
    delete process.env[ENV_KEY];
    const result = await runPacwareReadyToSyncDigest();
    expect(result).toEqual({
      readyCount: 0,
      sent: false,
      skippedReason: "no_recipient",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips when the operator has not opted into auto-sync notices", async () => {
    stageAutoSync("false");
    const result = await runPacwareReadyToSyncDigest();
    expect(result.skippedReason).toBe("auto_sync_off");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("treats a missing auto-sync row as off", async () => {
    stageAutoSync(null);
    const result = await runPacwareReadyToSyncDigest();
    expect(result.skippedReason).toBe("auto_sync_off");
  });

  it("fails soft to off when the auto-sync read errors", async () => {
    stageAutoSync(null, { message: "boom" });
    const result = await runPacwareReadyToSyncDigest();
    expect(result.skippedReason).toBe("auto_sync_off");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips when nothing is confirmed", async () => {
    stageAutoSync("true");
    stageConfirmedCount(0);
    const result = await runPacwareReadyToSyncDigest();
    expect(result).toEqual({
      readyCount: 0,
      sent: false,
      skippedReason: "nothing_ready",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips (not throws) when SendGrid is not configured", async () => {
    stageAutoSync("true");
    stageConfirmedCount(4);
    createSendgridClientMock.mockImplementation(() => {
      throw new EmailConfigError("SENDGRID_API_KEY missing");
    });
    const result = await runPacwareReadyToSyncDigest();
    expect(result).toEqual({
      readyCount: 4,
      sent: false,
      skippedReason: "sendgrid_not_configured",
    });
  });

  it("sends one counts-only email on the happy path", async () => {
    stageAutoSync("true");
    stageConfirmedCount(7);
    const result = await runPacwareReadyToSyncDigest();
    expect(result).toEqual({ readyCount: 7, sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sent = sendEmailMock.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(sent.to).toBe("ops@penn.example.com");
    expect(sent.subject).toContain("7");
    expect(sent.subject).toContain("PacWare");
    // Counts only — the body must carry no order references, SKUs, or
    // anything patient-shaped. PENN- is the order-reference prefix.
    expect(sent.text).not.toMatch(/PENN-/);
    expect(sent.html).not.toMatch(/PENN-/);
    expect(sent.text).toContain("/admin/pacware");
  });
});
