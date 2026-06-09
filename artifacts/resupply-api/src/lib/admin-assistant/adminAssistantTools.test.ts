// Unit tests for the admin-assistant (PennPilot) tools — chiefly the
// `suggest_feature` tool: argument validation, super-admin recipient
// resolution (admin_users → env fallback), email send, and the
// graceful soft-failure paths.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendEmailMock, createSendgridImpl } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(async () => ({ messageId: "sg_test" })),
  // A box the tests flip to make createSendgridClient throw (unconfigured).
  createSendgridImpl: { current: null as null | (() => unknown) },
}));

vi.mock("@workspace/resupply-email", async (importActual) => {
  const actual =
    await importActual<typeof import("@workspace/resupply-email")>();
  return {
    ...actual,
    createSendgridClient: vi.fn(() => {
      if (createSendgridImpl.current) return createSendgridImpl.current();
      return { sendEmail: sendEmailMock };
    }),
  };
});

import { EmailConfigError } from "@workspace/resupply-email";
import {
  executeAdminAssistantTool,
  resolveSuperAdminRecipients,
  serializeAdminToolResult,
  type AdminAssistantToolContext,
} from "./adminAssistantTools";

// Minimal awaitable PostgREST-style builder: every chainable method
// returns the same object, and `await`-ing it resolves to `{ data, error }`.
function fakeSupabase(result: {
  data: unknown;
  error: unknown;
}): AdminAssistantToolContext["supabase"] {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.schema = chain;
  builder.from = chain;
  builder.select = chain;
  builder.eq = chain;
  builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return builder as unknown as AdminAssistantToolContext["supabase"];
}

function ctxWith(
  result: { data: unknown; error: unknown },
  overrides: Partial<AdminAssistantToolContext> = {},
): AdminAssistantToolContext {
  return {
    supabase: fakeSupabase(result),
    suggestingAdminEmail: "alice@pennpaps.com",
    suggestingAdminRole: "admin",
    ...overrides,
  };
}

const originalEnv = process.env.RESUPPLY_ADMIN_EMAILS;

beforeEach(() => {
  sendEmailMock.mockClear();
  createSendgridImpl.current = null;
  delete process.env.RESUPPLY_ADMIN_EMAILS;
});

afterEach(() => {
  if (originalEnv !== undefined)
    process.env.RESUPPLY_ADMIN_EMAILS = originalEnv;
  else delete process.env.RESUPPLY_ADMIN_EMAILS;
});

describe("resolveSuperAdminRecipients", () => {
  it("prefers active super-admins from admin_users", async () => {
    const supabase = fakeSupabase({
      data: [
        { email_lower: "owner@pennpaps.com" },
        { email_lower: "OWNER@pennpaps.com" },
      ],
      error: null,
    });
    const out = await resolveSuperAdminRecipients(supabase);
    expect(out).toEqual(["owner@pennpaps.com"]); // de-duped + lower-cased
  });

  it("falls back to RESUPPLY_ADMIN_EMAILS when admin_users is empty", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS =
      "a@pennpaps.com, b@pennpaps.com , notanemail";
    const supabase = fakeSupabase({ data: [], error: null });
    const out = await resolveSuperAdminRecipients(supabase);
    expect(out).toEqual(["a@pennpaps.com", "b@pennpaps.com"]);
  });

  it("falls back to env when the admin_users query errors", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "c@pennpaps.com";
    const supabase = fakeSupabase({ data: null, error: { message: "boom" } });
    const out = await resolveSuperAdminRecipients(supabase);
    expect(out).toEqual(["c@pennpaps.com"]);
  });
});

describe("executeAdminAssistantTool: suggest_feature", () => {
  const validArgs = {
    title: "Bulk re-verify eligibility",
    problem: "I have to re-check eligibility one patient at a time.",
    proposal: "Add a button to re-verify a whole worklist at once.",
    area: "Billing",
    priority: "high",
  };

  it("rejects an unknown tool name", async () => {
    const result = await executeAdminAssistantTool(
      "delete_everything",
      {},
      ctxWith({ data: [{ email_lower: "owner@pennpaps.com" }], error: null }),
    );
    expect(result.ok).toBe(false);
    expect(result.data.error).toMatch(/Unknown tool/);
  });

  it("rejects invalid arguments without sending email", async () => {
    const result = await executeAdminAssistantTool(
      "suggest_feature",
      { title: "x" }, // too short + missing required fields
      ctxWith({ data: [{ email_lower: "owner@pennpaps.com" }], error: null }),
    );
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe("invalid_arguments");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("emails the resolved super-admins and reports success", async () => {
    const result = await executeAdminAssistantTool(
      "suggest_feature",
      validArgs,
      ctxWith({ data: [{ email_lower: "owner@pennpaps.com" }], error: null }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.sent).toBe(true);
    expect(result.data.recipientCount).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sent = sendEmailMock.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
      html: string;
      replyTo?: string;
    };
    expect(sent.to).toBe("owner@pennpaps.com");
    expect(sent.subject).toContain("Bulk re-verify eligibility");
    expect(sent.subject).not.toMatch(/[\r\n]/); // no header injection
    expect(sent.text).toContain("Add a button to re-verify");
    expect(sent.replyTo).toBe("alice@pennpaps.com"); // submitter as reply-to
  });

  it("soft-fails when no recipient can be resolved", async () => {
    const result = await executeAdminAssistantTool(
      "suggest_feature",
      validArgs,
      ctxWith({ data: [], error: null }), // empty admin_users + no env
    );
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe("no_recipient");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("soft-fails when SendGrid is unconfigured", async () => {
    createSendgridImpl.current = () => {
      throw new EmailConfigError("no key");
    };
    const result = await executeAdminAssistantTool(
      "suggest_feature",
      validArgs,
      ctxWith({ data: [{ email_lower: "owner@pennpaps.com" }], error: null }),
    );
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe("email_unconfigured");
  });

  it("soft-fails when every send throws", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("smtp down"));
    const result = await executeAdminAssistantTool(
      "suggest_feature",
      validArgs,
      ctxWith({ data: [{ email_lower: "owner@pennpaps.com" }], error: null }),
    );
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe("send_failed");
  });

  it("serializes a tool result to JSON", () => {
    const json = serializeAdminToolResult({ ok: true, data: { sent: true } });
    expect(JSON.parse(json)).toEqual({ ok: true, data: { sent: true } });
  });
});
