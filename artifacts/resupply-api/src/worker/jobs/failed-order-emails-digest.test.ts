// Tests for the daily failed-email order digest (A7).
//
// Two layers of coverage:
//   * `runFailedEmailDigest()` — the actual scan + send. Exercises
//     all four outcomes (no recipient / no failures / sendgrid not
//     configured / happy path) plus the PHI-safety contract
//     (subject + body never contain patient_*, payload, email_error).
//   * `registerFailedEmailDigestJob()` — feature-flag gating and
//     the recipient-required check.

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
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-email")>(
      "@workspace/resupply-email",
    );
  return {
    ...actual,
    createSendgridClient: (...args: unknown[]) =>
      createSendgridClientMock(...(args as Parameters<typeof createSendgridClientMock>)),
  };
});

const logCalls = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({ logger: logCalls }));

import { EmailConfigError } from "@workspace/resupply-email";

import {
  DIGEST_LOOKBACK_MS,
  DIGEST_MAX_REFERENCES_LISTED,
  FAILED_EMAIL_DIGEST_CRON,
  FAILED_EMAIL_DIGEST_JOB,
  registerFailedEmailDigestJob,
  runFailedEmailDigest,
} from "./failed-order-emails-digest";

const ENV_KEYS = [
  "RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED",
  "RESUPPLY_ADMIN_ALERTS_EMAIL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function snapshotEnv(): void {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
}

function makeFailedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_reference: "PENN-ABC123",
    created_at: "2026-05-21T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  snapshotEnv();
  for (const k of ENV_KEYS) delete process.env[k];
  supabaseMock.reset();
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue(undefined);
  createSendgridClientMock.mockReset();
  createSendgridClientMock.mockImplementation(() => ({
    sendEmail: sendEmailMock,
  }));
  logCalls.info.mockClear();
  logCalls.error.mockClear();
  logCalls.warn.mockClear();
});

afterEach(() => {
  restoreEnv();
});

describe("runFailedEmailDigest — outcomes", () => {
  it("returns no_recipient when RESUPPLY_ADMIN_ALERTS_EMAIL is unset", async () => {
    const out = await runFailedEmailDigest();
    expect(out).toEqual({
      failedCount: 0,
      sent: false,
      skippedReason: "no_recipient",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns no_failures when nothing matches the lookback window", async () => {
    process.env.RESUPPLY_ADMIN_ALERTS_EMAIL = "ops@example.com";
    stageSupabaseResponse("orders", "select", { data: [] });
    const out = await runFailedEmailDigest();
    expect(out).toEqual({
      failedCount: 0,
      sent: false,
      skippedReason: "no_failures",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns sendgrid_not_configured when the client throws EmailConfigError", async () => {
    process.env.RESUPPLY_ADMIN_ALERTS_EMAIL = "ops@example.com";
    stageSupabaseResponse("orders", "select", {
      data: [makeFailedRow()],
    });
    createSendgridClientMock.mockImplementation(() => {
      throw new EmailConfigError("SENDGRID_API_KEY is required");
    });

    const out = await runFailedEmailDigest();
    expect(out).toEqual({
      failedCount: 1,
      sent: false,
      skippedReason: "sendgrid_not_configured",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends a single digest when there are failures", async () => {
    process.env.RESUPPLY_ADMIN_ALERTS_EMAIL = "ops@example.com";
    stageSupabaseResponse("orders", "select", {
      data: [
        makeFailedRow({ order_reference: "PENN-AAA111" }),
        makeFailedRow({ order_reference: "PENN-BBB222" }),
      ],
    });

    const out = await runFailedEmailDigest();
    expect(out).toEqual({ failedCount: 2, sent: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
      customArgs?: Record<string, string>;
    };
    expect(call.to).toBe("ops@example.com");
    expect(call.subject).toContain("2 order confirmations failed");
    expect(call.text).toContain("PENN-AAA111");
    expect(call.text).toContain("PENN-BBB222");
    expect(call.html).toContain("PENN-AAA111");
    expect(call.customArgs).toEqual({
      kind: "ops_failed_order_emails_digest_v1",
    });
  });
});

describe("runFailedEmailDigest — PHI safety", () => {
  // The orders table has patient_first_name, patient_last_name,
  // patient_email, patient_phone, patient_date_of_birth, shipping_*,
  // and the raw `payload` jsonb. CLAUDE.md hard rule: NONE of those
  // may travel in any outbound channel, even to an ops mailbox.
  //
  // Two layers of defense:
  //   (1) The SELECT only requests order_reference + created_at, so
  //       PHI never enters the worker memory in the first place.
  //   (2) The composer renders only those two fields.
  //
  // This test pins (2) — even if a future refactor accidentally
  // widens the SELECT, the composer would refuse to render the new
  // fields and the test would catch the regression.

  it("never includes patient_* fields in the digest body, even if the row carries them", async () => {
    process.env.RESUPPLY_ADMIN_ALERTS_EMAIL = "ops@example.com";
    // Stage a "polluted" row — extra fields a future bad SELECT
    // might pull through. The composer must ignore them.
    stageSupabaseResponse("orders", "select", {
      data: [
        {
          order_reference: "PENN-AAA111",
          created_at: "2026-05-21T10:00:00.000Z",
          // PHI a buggy widened SELECT might fetch:
          patient_first_name: "PHI-FIRST",
          patient_last_name: "PHI-LAST",
          patient_email: "phi@example.com",
          patient_phone: "+15551234567",
          patient_date_of_birth: "1970-01-01",
          shipping_state: "PA",
          shipping_zip: "19104",
          email_error: "delivery to phi@example.com refused",
          payload: { secret: "sensitive_request_body" },
        },
      ],
    });

    await runFailedEmailDigest();
    const call = sendEmailMock.mock.calls[0][0] as {
      subject: string;
      html: string;
      text: string;
    };
    const blob = `${call.subject}\n${call.html}\n${call.text}`;
    expect(blob).not.toContain("PHI-FIRST");
    expect(blob).not.toContain("PHI-LAST");
    expect(blob).not.toContain("phi@example.com");
    expect(blob).not.toContain("+15551234567");
    expect(blob).not.toContain("1970-01-01");
    expect(blob).not.toContain("19104");
    expect(blob).not.toContain("sensitive_request_body");
    // email_error is also excluded — SendGrid responses occasionally
    // echo the patient's address back in the failure body.
    expect(blob).not.toContain("delivery to");
  });

  it("caps the body to DIGEST_MAX_REFERENCES_LISTED entries with an overflow note", async () => {
    process.env.RESUPPLY_ADMIN_ALERTS_EMAIL = "ops@example.com";
    const big = Array.from({ length: DIGEST_MAX_REFERENCES_LISTED + 5 }, (_, i) =>
      makeFailedRow({
        order_reference: `PENN-${String(i).padStart(6, "0")}`,
      }),
    );
    stageSupabaseResponse("orders", "select", { data: big });

    const out = await runFailedEmailDigest();
    expect(out.failedCount).toBe(big.length);
    const call = sendEmailMock.mock.calls[0][0] as {
      text: string;
      html: string;
    };
    // First DIGEST_MAX_REFERENCES_LISTED references appear.
    expect(call.text).toContain("PENN-000000");
    expect(call.text).toContain(
      `PENN-${String(DIGEST_MAX_REFERENCES_LISTED - 1).padStart(6, "0")}`,
    );
    // The (cap+1)th reference does NOT appear in the listing.
    expect(call.text).not.toContain(
      `PENN-${String(DIGEST_MAX_REFERENCES_LISTED).padStart(6, "0")}`,
    );
    // Overflow note explains there are more.
    expect(call.text).toContain(
      `and ${big.length - DIGEST_MAX_REFERENCES_LISTED} more`,
    );
  });
});

describe("registerFailedEmailDigestJob — gating", () => {
  function makeBoss() {
    return {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => undefined),
      schedule: vi.fn(async () => undefined),
    };
  }

  it("does NOT register when the flag is unset", async () => {
    process.env.RESUPPLY_ADMIN_ALERTS_EMAIL = "ops@example.com";
    const boss = makeBoss();
    await registerFailedEmailDigestJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it("does NOT register when the flag is set but the recipient is empty", async () => {
    process.env.RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED = "1";
    delete process.env.RESUPPLY_ADMIN_ALERTS_EMAIL;
    const boss = makeBoss();
    await registerFailedEmailDigestJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    // We surface this misconfiguration as a warn() so ops sees it.
    expect(logCalls.warn).toHaveBeenCalled();
  });

  it("registers + schedules when both the flag and the recipient are set", async () => {
    process.env.RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED = "1";
    process.env.RESUPPLY_ADMIN_ALERTS_EMAIL = "ops@example.com";
    const boss = makeBoss();
    await registerFailedEmailDigestJob(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(FAILED_EMAIL_DIGEST_JOB);
    expect(boss.work).toHaveBeenCalledWith(
      FAILED_EMAIL_DIGEST_JOB,
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      FAILED_EMAIL_DIGEST_JOB,
      FAILED_EMAIL_DIGEST_CRON,
    );
  });
});

describe("FAILED_EMAIL_DIGEST_CRON — schedule sanity", () => {
  it("runs once daily, not every hour", () => {
    // Format: "min hour * * *" — minute and hour both fixed.
    expect(FAILED_EMAIL_DIGEST_CRON).toMatch(/^\d+ \d+ \* \* \*$/);
  });

  it("runs during US business hours (13:00 UTC ≈ 9am US Eastern)", () => {
    const hour = Number(FAILED_EMAIL_DIGEST_CRON.split(" ")[1]);
    expect(hour).toBeGreaterThanOrEqual(12);
    expect(hour).toBeLessThanOrEqual(17);
  });
});

describe("DIGEST_LOOKBACK_MS — bounds", () => {
  it("is exactly 24 hours so the daily cron has zero-gap coverage", () => {
    expect(DIGEST_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
  });
});
