import { describe, it, expect } from "vitest";

import {
  createAndSendPatientPacket,
  createAndSendPatientPacketToContact,
  deliverPacketLink,
  resolvePatientByContact,
} from "./send";

describe("createAndSendPatientPacket", () => {
  it("rejects invalid document keys before touching the database", async () => {
    // Invalid keys are validated up front, so no Supabase client is
    // needed — passing an object that would throw if used proves it.
    const res = await createAndSendPatientPacket({
      supabase: {} as never,
      patientId: "11111111-1111-1111-1111-111111111111",
      documentKeys: ["assignment_of_benefits", "not_a_real_doc"],
    });
    expect(res).toEqual({
      ok: false,
      code: "invalid_document_keys",
      invalidKeys: ["not_a_real_doc"],
    });
  });
});

// ── Contact send (no patient selected) ───────────────────────────
type QueryResult = { data: unknown; error: unknown };
type Handler = (q: {
  table: string;
  filters: Record<string, unknown>;
}) => QueryResult;

interface MockBuilder {
  select: () => MockBuilder;
  eq: (column: string, value: unknown) => MockBuilder;
  not: (column: string, operator: string, value: unknown) => MockBuilder;
  limit: (n: number) => Promise<QueryResult>;
}

// Minimal Supabase query-builder stand-in that records the table +
// equality filters and hands them to a per-test handler. Only the
// chain shape resolvePatientByContact actually uses is implemented.
function makeSupabase(
  handler: Handler,
): Parameters<typeof resolvePatientByContact>[0] {
  const fromTable = (table: string): MockBuilder => {
    const filters: Record<string, unknown> = {};
    const builder: MockBuilder = {
      select: () => builder,
      eq: (column, value) => {
        filters[column] = value;
        return builder;
      },
      not: (column) => {
        filters[`${column}__not`] = true;
        return builder;
      },
      limit: () => Promise.resolve(handler({ table, filters })),
    };
    return builder;
  };
  return {
    schema: () => ({ from: fromTable }),
  } as unknown as Parameters<typeof resolvePatientByContact>[0];
}

const patientRow = (id: string, first: string, last: string) => ({
  id,
  legal_first_name: first,
  legal_last_name: last,
});

describe("resolvePatientByContact", () => {
  it("matches a single patient by email", async () => {
    const supabase = makeSupabase(({ table, filters }) =>
      table === "patients" && filters.email === "ann@example.com"
        ? { data: [patientRow("p1", "Ann", "Lee")], error: null }
        : { data: [], error: null },
    );
    const res = await resolvePatientByContact(supabase, {
      emailLower: "ann@example.com",
    });
    expect(res).toEqual({
      status: "matched",
      patientId: "p1",
      name: "Ann Lee",
    });
  });

  it("matches a single patient by phone", async () => {
    const supabase = makeSupabase(({ table, filters }) =>
      table === "patients" && filters.phone_e164 === "+12155551212"
        ? { data: [patientRow("p2", "Bo", "Ng")], error: null }
        : { data: [], error: null },
    );
    const res = await resolvePatientByContact(supabase, {
      phoneE164: "+12155551212",
    });
    expect(res).toEqual({ status: "matched", patientId: "p2", name: "Bo Ng" });
  });

  it("is ambiguous when two patients share the email (never links)", async () => {
    const supabase = makeSupabase(({ table }) =>
      table === "patients"
        ? {
            data: [patientRow("p1", "A", "A"), patientRow("p2", "B", "B")],
            error: null,
          }
        : { data: [], error: null },
    );
    const res = await resolvePatientByContact(supabase, {
      emailLower: "shared@example.com",
    });
    expect(res).toEqual({ status: "ambiguous" });
  });

  it("is ambiguous when email and phone resolve to different patients", async () => {
    const supabase = makeSupabase(({ filters }) => {
      if (filters.email)
        return { data: [patientRow("p1", "A", "A")], error: null };
      if (filters.phone_e164)
        return { data: [patientRow("p2", "B", "B")], error: null };
      return { data: [], error: null };
    });
    const res = await resolvePatientByContact(supabase, {
      emailLower: "a@example.com",
      phoneE164: "+12155551212",
    });
    expect(res).toEqual({ status: "ambiguous" });
  });

  it("bridges through a portal customer when no direct patient matches", async () => {
    const supabase = makeSupabase(({ table, filters }) => {
      if (table === "patients" && filters.email)
        return { data: [], error: null };
      if (table === "shop_customers" && filters.email_lower === "c@example.com")
        return { data: [{ auth_user_id: "auth-1" }], error: null };
      if (table === "patients" && filters.portal_auth_user_id === "auth-1")
        return { data: [patientRow("p9", "Cara", "Diaz")], error: null };
      return { data: [], error: null };
    });
    const res = await resolvePatientByContact(supabase, {
      emailLower: "c@example.com",
    });
    expect(res).toEqual({
      status: "matched",
      patientId: "p9",
      name: "Cara Diaz",
    });
  });

  it("returns none when nothing matches", async () => {
    const supabase = makeSupabase(() => ({ data: [], error: null }));
    const res = await resolvePatientByContact(supabase, {
      emailLower: "nobody@example.com",
      phoneE164: "+12155551212",
    });
    expect(res).toEqual({ status: "none" });
  });
});

describe("createAndSendPatientPacketToContact", () => {
  it("returns no_recipient when neither email nor phone is given", async () => {
    const res = await createAndSendPatientPacketToContact({
      supabase: {} as never,
    });
    expect(res).toEqual({ ok: false, code: "no_recipient" });
  });

  it("returns invalid_phone when the number cannot be normalized", async () => {
    const res = await createAndSendPatientPacketToContact({
      supabase: {} as never,
      phone: "12",
    });
    expect(res).toEqual({ ok: false, code: "invalid_phone" });
  });
});

describe("deliverPacketLink", () => {
  it("is a no-op when no channel has a recipient (no vendor calls)", async () => {
    const res = await deliverPacketLink({
      supabase: {} as never,
      recipientName: "Pat",
      link: "https://example.com/patient-packet-sign?token=abc.def",
      email: null,
      phone: null,
      channels: ["email", "sms"],
    });
    expect(res).toEqual({ emailSent: false, smsSent: false });
  });

  it("skips a channel that isn't requested even if a recipient exists", async () => {
    // SMS requested but only an email on file → nothing to send, returns
    // before resolving the company profile (so the dummy client is safe).
    const res = await deliverPacketLink({
      supabase: {} as never,
      recipientName: "Pat",
      link: "https://example.com/patient-packet-sign?token=abc.def",
      email: "pat@example.com",
      phone: null,
      channels: ["sms"],
    });
    expect(res).toEqual({ emailSent: false, smsSent: false });
  });
});
