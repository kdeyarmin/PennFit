// CareMetric Breathe B2B platform sales tool tests.
//
// Exercises the sales dispatch path (callerKind "breathe_prospect"): lead
// capture (+ super-admin notification), templated info email (+ per-call cap
// + soft-fail), the no-spoken-password sign-up, call-reason recording, the
// lightweight handoff, and that patient/shop tools are refused on the sales
// line. The email sender and tenant provisioner are injected via dispatcher
// seams; the DB rides the shared supabase mock.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

import { createVoiceToolDispatcher } from "./tools-impl";
import type { PlatformEmailMessage, SendPlatformEmail } from "./tools-impl";

const supabaseMock = installSupabaseMock();

/** Flush fire-and-forget work (lead notification / signup lead row). */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

function makeEmailSpy() {
  const sent: PlatformEmailMessage[] = [];
  const sendPlatformEmail: SendPlatformEmail = vi.fn(async (msg) => {
    sent.push(msg);
    return { ok: true };
  });
  return { sent, sendPlatformEmail };
}

const SALES_DEPS = {
  callerKind: "breathe_prospect" as const,
  conversationId: "sales-conv-1",
  twilioCallSid: "CA-sales-1",
};

beforeEach(() => {
  supabaseMock.reset();
  delete process.env.RESUPPLY_ADMIN_EMAILS;
});

describe("breathe sales — identify_call_reason", () => {
  it("records and echoes the reason without side effects", async () => {
    const dispatcher = createVoiceToolDispatcher({ ...SALES_DEPS });
    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "identify_call_reason",
      args: { reason: "sales" },
    });
    expect(r.result).toEqual({ ok: true, reason: "sales" });
  });
});

describe("breathe sales — capture_sales_lead", () => {
  it("persists the lead and notifies the super-admin(s)", async () => {
    stageSupabaseResponse("sales_leads", "insert", {
      data: { id: "lead-1" },
    });
    stageSupabaseResponse("admin_users", "select", {
      data: [{ email_lower: "boss@cmbreathe.com" }],
    });
    const { sent, sendPlatformEmail } = makeEmailSpy();
    const dispatcher = createVoiceToolDispatcher({
      ...SALES_DEPS,
      sendPlatformEmail,
    });

    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "capture_sales_lead",
      args: {
        contact_name: "Pat Owner",
        company_name: "Acme DME",
        phone: "+18145551212",
        email: "owner@acme-dme.example",
        interest_tier: "growth",
        message: "Call me about pricing for ~3000 patients.",
      },
    });

    expect(r.result).toEqual({ ok: true, lead_id: "lead-1" });

    // The row carries the captured fields + the call SID.
    const inserts = supabaseMock.writePayloads("sales_leads", "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      company_name: "Acme DME",
      email: "owner@acme-dme.example",
      interest_tier: "growth",
      twilio_call_sid: "CA-sales-1",
      source: "voice_sales_agent",
      status: "new",
    });

    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("boss@cmbreathe.com");
    expect(sent[0]?.subject).toContain("Acme DME");
  });

  it("returns ok:false when the lead insert fails", async () => {
    stageSupabaseResponse("sales_leads", "insert", {
      throws: new Error("db down"),
    });
    const { sendPlatformEmail } = makeEmailSpy();
    const dispatcher = createVoiceToolDispatcher({
      ...SALES_DEPS,
      sendPlatformEmail,
    });
    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "capture_sales_lead",
      args: { message: "anything" },
    });
    expect(r.result).toEqual({ ok: false, reason: "persist_failed" });
  });

  it("still records the lead when no super-admin recipient resolves (email down)", async () => {
    stageSupabaseResponse("sales_leads", "insert", { data: { id: "lead-9" } });
    stageSupabaseResponse("admin_users", "select", { data: [] });
    const { sent, sendPlatformEmail } = makeEmailSpy();
    const dispatcher = createVoiceToolDispatcher({
      ...SALES_DEPS,
      sendPlatformEmail,
    });
    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "capture_sales_lead",
      args: { message: "no recipients case" },
    });
    expect(r.result).toEqual({ ok: true, lead_id: "lead-9" });
    await flush();
    expect(sent).toHaveLength(0); // no recipient → nothing sent, lead kept
  });
});

describe("breathe sales — send_info_email", () => {
  it("sends a templated email to the caller's address", async () => {
    const { sent, sendPlatformEmail } = makeEmailSpy();
    const dispatcher = createVoiceToolDispatcher({
      ...SALES_DEPS,
      sendPlatformEmail,
    });
    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "send_info_email",
      args: { email: "owner@acme-dme.example", topic: "pricing" },
    });
    expect(r.result).toEqual({ ok: true, sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("owner@acme-dme.example");
    expect(sent[0]?.subject.toLowerCase()).toContain("pricing");
    // Body is templated (not model-authored) — pricing copy is present.
    expect(sent[0]?.text).toContain("$499");
  });

  it("caps the number of emails per call", async () => {
    const { sendPlatformEmail } = makeEmailSpy();
    const dispatcher = createVoiceToolDispatcher({
      ...SALES_DEPS,
      sendPlatformEmail,
    });
    const send = (n: number) =>
      dispatcher.dispatch({
        callId: `c${n}`,
        name: "send_info_email",
        args: { email: "a@b.example", topic: "overview" },
      });
    expect((await send(1)).result).toMatchObject({ ok: true, sent: true });
    expect((await send(2)).result).toMatchObject({ ok: true, sent: true });
    expect((await send(3)).result).toMatchObject({ ok: true, sent: true });
    expect((await send(4)).result).toEqual({
      ok: false,
      sent: false,
      reason: "send_limit",
    });
  });

  it("soft-fails when email is unconfigured (does not count against the cap)", async () => {
    const sendPlatformEmail: SendPlatformEmail = vi.fn(async () => ({
      ok: false,
      reason: "email_unconfigured",
    }));
    const dispatcher = createVoiceToolDispatcher({
      ...SALES_DEPS,
      sendPlatformEmail,
    });
    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "send_info_email",
      args: { email: "a@b.example", topic: "overview" },
    });
    expect(r.result).toEqual({
      ok: false,
      sent: false,
      reason: "email_unconfigured",
    });
  });
});

describe("breathe sales — start_breathe_signup", () => {
  it("provisions a tenant with a generated (never spoken) password and reports success", async () => {
    stageSupabaseResponse("sales_leads", "insert", { data: { id: "lead-su" } });
    const createTenant = vi.fn(async (input: { slug: string }) => ({
      ok: true as const,
      slug: input.slug,
      signInUrl: "https://cmbreathe.com/admin/sign-in",
    }));
    const dispatcher = createVoiceToolDispatcher({
      ...SALES_DEPS,
      createTenant: createTenant as never,
    });

    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "start_breathe_signup",
      args: {
        org_name: "Acme DME",
        admin_email: "owner@acme-dme.example",
        plan: "growth",
        estimated_active_patients: 3000,
      },
    });

    expect(r.result).toEqual({
      ok: true,
      status: "verification_email_sent",
    });

    // The tool collected NO password from the caller — a strong one was
    // generated server-side and never derived from the spoken args.
    expect(createTenant).toHaveBeenCalledTimes(1);
    const arg = createTenant.mock.calls[0]![0] as {
      password: string;
      adminEmail: string;
      orgName: string;
      slug: string;
      sendSetPasswordLink?: boolean;
    };
    expect(arg.password.length).toBeGreaterThanOrEqual(12);
    expect(arg.password).not.toBe("Acme DME");
    expect(arg.password).not.toContain("owner@acme-dme.example");
    expect(arg.adminEmail).toBe("owner@acme-dme.example");
    expect(arg.slug).toBe("acme-dme");
    // The caller never speaks a password — the tool asks the signup service
    // to email a set-password link (which also verifies the email).
    expect(arg.sendSetPasswordLink).toBe(true);

    await flush();
    const inserts = supabaseMock.writePayloads("sales_leads", "insert");
    // The converted lead records the chosen plan: the full-platform tier
    // lands in interest_tier and the plan + qualifying patient count ride in
    // the message so the team can see what they signed up for.
    expect(inserts[0]).toMatchObject({
      status: "signed_up",
      interest_tier: "growth",
    });
    expect(String((inserts[0] as { message?: string }).message)).toContain(
      "growth",
    );
  });

  it("maps email_taken / slug_taken / invalid_email to the status enum", async () => {
    const cases: Array<[string, string]> = [
      ["email_taken", "email_taken"],
      ["slug_taken", "name_taken"],
      ["invalid_email", "invalid_email"],
      ["unavailable", "unavailable"],
    ];
    for (const [reason, expected] of cases) {
      const createTenant = vi.fn(async () => ({
        ok: false as const,
        reason,
        message: "nope",
      }));
      const dispatcher = createVoiceToolDispatcher({
        ...SALES_DEPS,
        createTenant: createTenant as never,
      });
      const r = await dispatcher.dispatch({
        callId: "c1",
        name: "start_breathe_signup",
        args: { org_name: "X Co", admin_email: "x@y.example", plan: "launch" },
      });
      expect(r.result).toEqual({ ok: false, status: expected });
    }
  });

  it("soft-fails to 'unavailable' when provisioning throws", async () => {
    const createTenant = vi.fn(async () => {
      throw new Error("seed org missing");
    });
    const dispatcher = createVoiceToolDispatcher({
      ...SALES_DEPS,
      createTenant: createTenant as never,
    });
    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "start_breathe_signup",
      args: { org_name: "X Co", admin_email: "x@y.example", plan: "scale" },
    });
    expect(r.result).toEqual({ ok: false, status: "unavailable" });
  });
});

describe("breathe sales — handoff + tool isolation", () => {
  it("acknowledges a human handoff without touching a conversation row", async () => {
    const dispatcher = createVoiceToolDispatcher({ ...SALES_DEPS });
    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "request_human_handoff",
      args: { reason: "other" },
    });
    expect(r.result).toMatchObject({ ok: true });
    expect((r.result as { handoff_id?: string }).handoff_id).toBeTruthy();
    // No conversations update was issued on the sales line.
    expect(supabaseMock.callCount("conversations", "update")).toBe(0);
  });

  it("refuses a patient tool on the sales line (no PHI lookup runs)", async () => {
    const dispatcher = createVoiceToolDispatcher({ ...SALES_DEPS });
    const r = await dispatcher.dispatch({
      callId: "c1",
      name: "verify_patient_identity",
      args: { date_of_birth: "1980-01-01" },
    });
    // Benign refusal shape — never a thrown error, never a patient read.
    expect(r.result).toMatchObject({ matched: false });
    expect(supabaseMock.callCount("patients", "select")).toBe(0);
  });
});
