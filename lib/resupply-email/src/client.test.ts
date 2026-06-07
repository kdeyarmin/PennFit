import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EmailApiError,
  EmailConfigError,
  createSendgridClient,
  type RawSendgridSdk,
} from "./client";

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
] as const;

function fakeSdk(
  send: ReturnType<typeof vi.fn>,
  setApiKey: ReturnType<typeof vi.fn> = vi.fn(),
): RawSendgridSdk {
  return { send, setApiKey } as unknown as RawSendgridSdk;
}

describe("createSendgridClient", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws EmailConfigError when SENDGRID_API_KEY is unset", () => {
    expect(() => createSendgridClient()).toThrow(EmailConfigError);
    expect(() => createSendgridClient()).toThrow(/SENDGRID_API_KEY/);
  });

  it("defaults the From address to info@pennpaps.com when SENDGRID_FROM_EMAIL is unset", async () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    // SENDGRID_FROM_EMAIL intentionally left unset — the From address is a
    // fixed platform constant, so the client must NOT throw and must send
    // from info@pennpaps.com (ADR 016/018).
    const send = vi
      .fn()
      .mockResolvedValue([
        { statusCode: 202, headers: { "x-message-id": "msg-default" } },
        undefined,
      ]);
    const client = createSendgridClient({ sgFactory: () => fakeSdk(send) });
    await client.sendEmail({
      to: "p@e.com",
      subject: "s",
      html: "h",
      text: "t",
    });
    expect(send.mock.calls[0]?.[0].from).toEqual({
      email: "info@pennpaps.com",
    });
  });

  it("constructs successfully with required env", () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    const send = vi.fn();
    const client = createSendgridClient({
      sgFactory: () => fakeSdk(send),
    });
    expect(client).toBeDefined();
  });

  it("sends with from-name when SENDGRID_FROM_NAME is set", async () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    process.env.SENDGRID_FROM_NAME = "Penn Sleep Center";
    const send = vi
      .fn()
      .mockResolvedValue([
        { statusCode: 202, headers: { "x-message-id": "msg-abc" } },
        undefined,
      ]);
    const setApiKey = vi.fn();
    const client = createSendgridClient({
      sgFactory: () => fakeSdk(send, setApiKey),
    });

    const result = await client.sendEmail({
      to: "patient@example.com",
      subject: "Time to refill your CPAP supplies",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(setApiKey).toHaveBeenCalledWith("SG.xxx");
    expect(result).toEqual({ messageId: "msg-abc" });
    expect(send).toHaveBeenCalledWith({
      to: "patient@example.com",
      from: { email: "no-reply@penn.example", name: "Penn Sleep Center" },
      subject: "Time to refill your CPAP supplies",
      html: "<p>hi</p>",
      text: "hi",
      replyTo: undefined,
      customArgs: undefined,
    });
  });

  it("sends without from-name when SENDGRID_FROM_NAME is unset", async () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    const send = vi
      .fn()
      .mockResolvedValue([
        { statusCode: 202, headers: { "x-message-id": "msg-abc" } },
        undefined,
      ]);
    const client = createSendgridClient({
      sgFactory: () => fakeSdk(send),
    });

    await client.sendEmail({
      to: "patient@example.com",
      subject: "s",
      html: "h",
      text: "t",
    });

    expect(send.mock.calls[0]?.[0].from).toEqual({
      email: "no-reply@penn.example",
    });
  });

  it("forwards customArgs and replyTo", async () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    const send = vi
      .fn()
      .mockResolvedValue([
        { statusCode: 202, headers: { "x-message-id": "msg-abc" } },
        undefined,
      ]);
    const client = createSendgridClient({
      sgFactory: () => fakeSdk(send),
    });

    await client.sendEmail({
      to: "patient@example.com",
      subject: "s",
      html: "h",
      text: "t",
      replyTo: "ops@penn.example",
      customArgs: { conversation_id: "abc-123" },
    });

    expect(send.mock.calls[0]?.[0].replyTo).toBe("ops@penn.example");
    expect(send.mock.calls[0]?.[0].customArgs).toEqual({
      conversation_id: "abc-123",
    });
  });

  it("throws EmailApiError when response is missing x-message-id", async () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    const send = vi
      .fn()
      .mockResolvedValue([{ statusCode: 202, headers: {} }, undefined]);
    const client = createSendgridClient({
      sgFactory: () => fakeSdk(send),
    });

    await expect(
      client.sendEmail({
        to: "p@e.com",
        subject: "s",
        html: "h",
        text: "t",
      }),
    ).rejects.toBeInstanceOf(EmailApiError);
  });

  it("propagates SendGrid errors as EmailApiError with status + body", async () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    const send = vi.fn().mockRejectedValue({
      response: {
        statusCode: 400,
        body: { errors: [{ message: "bad addr" }] },
      },
      message: "Bad Request",
    });
    const client = createSendgridClient({
      sgFactory: () => fakeSdk(send),
    });

    await expect(
      client.sendEmail({
        to: "junk",
        subject: "s",
        html: "h",
        text: "t",
      }),
    ).rejects.toMatchObject({
      name: "EmailApiError",
      status: 400,
      message: "Bad Request",
    });
  });

  it("accepts x-message-id as a string array (multi-value header)", async () => {
    process.env.SENDGRID_API_KEY = "SG.xxx";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    const send = vi
      .fn()
      .mockResolvedValue([
        { statusCode: 202, headers: { "x-message-id": ["msg-array"] } },
        undefined,
      ]);
    const client = createSendgridClient({
      sgFactory: () => fakeSdk(send),
    });

    const result = await client.sendEmail({
      to: "p@e.com",
      subject: "s",
      html: "h",
      text: "t",
    });
    expect(result.messageId).toBe("msg-array");
  });

  // ── Transient-failure retry ──────────────────────────────────────
  describe("retry on transient SendGrid failures", () => {
    const noSleep = () => Promise.resolve();

    function envOn() {
      process.env.SENDGRID_API_KEY = "SG.xxx";
      process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    }

    it("retries a 503 then succeeds", async () => {
      envOn();
      const send = vi
        .fn()
        .mockRejectedValueOnce({
          response: { statusCode: 503 },
          message: "Service Unavailable",
        })
        .mockResolvedValue([
          { statusCode: 202, headers: { "x-message-id": "msg-ok" } },
          undefined,
        ]);
      const client = createSendgridClient({
        sgFactory: () => fakeSdk(send),
        retry: { sleep: noSleep },
      });

      const result = await client.sendEmail({
        to: "p@e.com",
        subject: "s",
        html: "h",
        text: "t",
      });
      expect(result.messageId).toBe("msg-ok");
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("retries a 429 then succeeds", async () => {
      envOn();
      const send = vi
        .fn()
        .mockRejectedValueOnce({
          response: { statusCode: 429 },
          message: "Too Many Requests",
        })
        .mockResolvedValue([
          { statusCode: 202, headers: { "x-message-id": "msg-ok" } },
          undefined,
        ]);
      const client = createSendgridClient({
        sgFactory: () => fakeSdk(send),
        retry: { sleep: noSleep },
      });

      await expect(
        client.sendEmail({ to: "p@e.com", subject: "s", html: "h", text: "t" }),
      ).resolves.toEqual({ messageId: "msg-ok" });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("retries a network error (ECONNRESET) then succeeds", async () => {
      envOn();
      const send = vi
        .fn()
        .mockRejectedValueOnce({
          code: "ECONNRESET",
          message: "socket hang up",
        })
        .mockResolvedValue([
          { statusCode: 202, headers: { "x-message-id": "msg-ok" } },
          undefined,
        ]);
      const client = createSendgridClient({
        sgFactory: () => fakeSdk(send),
        retry: { sleep: noSleep },
      });

      await client.sendEmail({
        to: "p@e.com",
        subject: "s",
        html: "h",
        text: "t",
      });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry a 400 (terminal) and throws after one attempt", async () => {
      envOn();
      const send = vi.fn().mockRejectedValue({
        response: { statusCode: 400, body: { errors: [{ message: "bad" }] } },
        message: "Bad Request",
      });
      const client = createSendgridClient({
        sgFactory: () => fakeSdk(send),
        retry: { sleep: noSleep },
      });

      await expect(
        client.sendEmail({ to: "junk", subject: "s", html: "h", text: "t" }),
      ).rejects.toMatchObject({ name: "EmailApiError", status: 400 });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("exhausts attempts on a persistent 500 and throws retryable error", async () => {
      envOn();
      const send = vi.fn().mockRejectedValue({
        response: { statusCode: 500 },
        message: "Internal Server Error",
      });
      const client = createSendgridClient({
        sgFactory: () => fakeSdk(send),
        retry: { maxAttempts: 3, sleep: noSleep },
      });

      await expect(
        client.sendEmail({ to: "p@e.com", subject: "s", html: "h", text: "t" }),
      ).rejects.toMatchObject({
        name: "EmailApiError",
        status: 500,
        retryable: true,
      });
      expect(send).toHaveBeenCalledTimes(3);
    });

    it("keeps status undefined for string transport error codes", async () => {
      envOn();
      const send = vi.fn().mockRejectedValue({
        code: "ECONNRESET",
        message: "socket hang up",
      });
      const client = createSendgridClient({
        sgFactory: () => fakeSdk(send),
        retry: { maxAttempts: 1, sleep: noSleep },
      });

      await expect(
        client.sendEmail({ to: "p@e.com", subject: "s", html: "h", text: "t" }),
      ).rejects.toMatchObject({
        name: "EmailApiError",
        status: undefined,
      });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("maxAttempts:1 disables retry", async () => {
      envOn();
      const send = vi.fn().mockRejectedValue({ response: { statusCode: 503 } });
      const client = createSendgridClient({
        sgFactory: () => fakeSdk(send),
        retry: { maxAttempts: 1, sleep: noSleep },
      });
      await expect(
        client.sendEmail({ to: "p@e.com", subject: "s", html: "h", text: "t" }),
      ).rejects.toBeInstanceOf(EmailApiError);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry a 2xx with a missing message id (already accepted)", async () => {
      envOn();
      const send = vi
        .fn()
        .mockResolvedValue([{ statusCode: 202, headers: {} }, undefined]);
      const client = createSendgridClient({
        sgFactory: () => fakeSdk(send),
        retry: { sleep: noSleep },
      });
      await expect(
        client.sendEmail({ to: "p@e.com", subject: "s", html: "h", text: "t" }),
      ).rejects.toBeInstanceOf(EmailApiError);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  // ── Header-injection guard ───────────────────────────────────────
  describe("CR/LF injection guard", () => {
    function client() {
      process.env.SENDGRID_API_KEY = "SG.xxx";
      process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
      const send = vi
        .fn()
        .mockResolvedValue([
          { statusCode: 202, headers: { "x-message-id": "ok" } },
          undefined,
        ]);
      return {
        send,
        client: createSendgridClient({ sgFactory: () => fakeSdk(send) }),
      };
    }

    it.each([
      ["LF in subject", { field: "subject", value: "Hello\nBcc: evil@x.com" }],
      ["CR in subject", { field: "subject", value: "Hello\rBcc: evil@x.com" }],
      ["CRLF in subject", { field: "subject", value: "Hello\r\nX-foo: bar" }],
    ])("rejects %s", async (_name, { field, value }) => {
      const { client: c, send } = client();
      const payload = {
        to: "p@e.com",
        subject: field === "subject" ? value : "ok",
        html: "h",
        text: "t",
      };
      await expect(c.sendEmail(payload)).rejects.toThrow(EmailConfigError);
      expect(send).not.toHaveBeenCalled();
    });

    it("rejects LF in `to`", async () => {
      const { client: c, send } = client();
      await expect(
        c.sendEmail({
          to: "p@e.com\nBcc: evil@x.com",
          subject: "ok",
          html: "h",
          text: "t",
        }),
      ).rejects.toThrow(EmailConfigError);
      expect(send).not.toHaveBeenCalled();
    });

    it("rejects LF in `replyTo`", async () => {
      const { client: c, send } = client();
      await expect(
        c.sendEmail({
          to: "p@e.com",
          subject: "ok",
          html: "h",
          text: "t",
          replyTo: "ops@e.com\nBcc: evil@x.com",
        }),
      ).rejects.toThrow(EmailConfigError);
      expect(send).not.toHaveBeenCalled();
    });

    it("does not reject a clean subject", async () => {
      const { client: c, send } = client();
      await c.sendEmail({
        to: "p@e.com",
        subject: "Refill reminder · order #1234",
        html: "h",
        text: "t",
      });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
