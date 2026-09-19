// Tests for the patient → shop_customers consent bridge.
//
// The bug this module exists to prevent is a SILENT FAIL-OPEN: filtering
// on a column that does not exist makes PostgREST answer 42703, and a
// caller that drops the error reads that as "no stored preference",
// which for email is the opted-IN default. So the assertions here are
// mostly about the columns actually being asked for, and about a failed
// read never resolving to a permissive answer.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
  getSupabaseCallCount,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { resolvePatientCommPrefs } from "./patient-comm-prefs";
import { getOrgScopedClient } from "@workspace/resupply-db";

const ORG = "00000000-0000-4000-8000-000000000001";

function client() {
  return getOrgScopedClient(ORG);
}

/**
 * The join columns this module chose, in order. The org-scoped client
 * stamps its own `org_id` filter and a `limit` on every read, so those
 * are dropped here to leave only the lookup key under test.
 */
function joinColumns(): string[] {
  return getSupabaseFilterCalls("shop_customers", "select")
    .filter((f) => f.verb === "eq" && f.args[0] !== "org_id")
    .map((f) => String(f.args[0]));
}

beforeEach(() => {
  supabaseMock.reset();
});

describe("resolvePatientCommPrefs", () => {
  it("reads shop_customers by email_lower, never by patient_id", async () => {
    // Regression. Three jobs filtered `shop_customers.patient_id`, a
    // column this table does not have; PostgREST answered 42703 and the
    // callers swallowed it. Because the mock does not validate column
    // names, only asserting the filter shape catches this.
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { emailResupplyReminders: false } },
    });

    const res = await resolvePatientCommPrefs(client(), {
      email: "Patient@Example.COM",
    });

    expect(res.unknown).toBe(false);
    expect(res.explicit).toBe(true);
    expect(res.prefs.emailResupplyReminders).toBe(false);

    const filters = getSupabaseFilterCalls("shop_customers", "select");
    const byEmail = filters.find(
      (f) => f.verb === "eq" && f.args[0] === "email_lower",
    );
    expect(byEmail, "must match on email_lower").toBeDefined();
    // Lowercased here so callers can pass patients.email raw.
    expect(byEmail?.args[1]).toBe("patient@example.com");
    expect(filters.every((f) => f.args[0] !== "patient_id")).toBe(true);
  });

  it("prefers the portal link over the email match", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { smsTransactional: true } },
    });

    const res = await resolvePatientCommPrefs(client(), {
      email: "p@example.com",
      portalAuthUserId: "auth-1",
    });

    expect(res.explicit).toBe(true);
    // The strong link answered, so the weaker email match is not run.
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(1);
    expect(joinColumns()).toEqual(["auth_user_id"]);
    const byAuth = getSupabaseFilterCalls("shop_customers", "select").find(
      (f) => f.args[0] === "auth_user_id",
    );
    expect(byAuth?.args[1]).toBe("auth-1");
  });

  it("falls back to email when the portal lookup finds no row", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { smsTransactional: true } },
    });

    const res = await resolvePatientCommPrefs(client(), {
      email: "p@example.com",
      portalAuthUserId: "auth-1",
    });

    expect(res.explicit).toBe(true);
    expect(res.prefs.smsTransactional).toBe(true);
    expect(joinColumns()).toEqual(["auth_user_id", "email_lower"]);
  });

  it("does not fall back to email when the portal row exists with null preferences", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: null },
    });

    const res = await resolvePatientCommPrefs(client(), {
      email: "p@example.com",
      portalAuthUserId: "auth-1",
    });

    expect(res.unknown).toBe(false);
    expect(res.explicit).toBe(false);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(1);
    expect(joinColumns()).toEqual(["auth_user_id"]);
  });

  it("reports unknown — not defaults — when the read fails", async () => {
    // The whole point. A 42703 (or any error) must be distinguishable
    // from "found nothing", because the caller's behaviour differs:
    // nothing-found may send, could-not-read may not.
    stageSupabaseResponse("shop_customers", "select", {
      error: { message: "column shop_customers.patient_id does not exist" },
    });

    const res = await resolvePatientCommPrefs(client(), {
      email: "p@example.com",
    });

    expect(res.unknown).toBe(true);
    expect(res.explicit).toBe(false);
  });

  it("reports unknown when the portal-link read fails, without trying email", async () => {
    // A failed strong-link read must not fall through to the weaker
    // match: that would turn a transient error into a different
    // patient's answers.
    stageSupabaseResponse("shop_customers", "select", {
      error: { message: "boom" },
    });

    const res = await resolvePatientCommPrefs(client(), {
      email: "p@example.com",
      portalAuthUserId: "auth-1",
    });

    expect(res.unknown).toBe(true);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(1);
  });

  it("treats a missing row as not-stored, which is not a refusal", async () => {
    // Most patients arrive through the insurance pipeline and never
    // create a storefront account, so "no row" is the common case and
    // must not silence transactional contact.
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const res = await resolvePatientCommPrefs(client(), {
      email: "p@example.com",
    });

    expect(res.unknown).toBe(false);
    expect(res.explicit).toBe(false);
    expect(res.prefs.emailResupplyReminders).toBe(true);
  });

  it("does not query at all when there is nothing to join on", async () => {
    const res = await resolvePatientCommPrefs(client(), {
      email: null,
      portalAuthUserId: null,
    });

    expect(res).toEqual({
      prefs: expect.any(Object),
      explicit: false,
      unknown: false,
    });
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });

  it("layers stored values over the defaults rather than replacing them", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { smsMarketing: true } },
    });

    const res = await resolvePatientCommPrefs(client(), {
      email: "p@example.com",
    });

    expect(res.prefs.smsMarketing).toBe(true);
    // An unmentioned key keeps its default instead of becoming undefined,
    // which shouldSendEmail/shouldSendSms would read as falsy.
    expect(res.prefs.emailResupplyReminders).toBe(true);
    expect(res.prefs.dndStartHour).toBeNull();
  });

  it("ignores a non-object preferences blob", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: "yes please" },
    });

    const res = await resolvePatientCommPrefs(client(), {
      email: "p@example.com",
    });

    expect(res.explicit).toBe(false);
    expect(res.unknown).toBe(false);
  });
});
