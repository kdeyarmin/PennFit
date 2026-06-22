// Tests for /admin/video-visits — a patient-facing surface (the invite
// email/SMS goes straight to a patient, so unescaped input is a real XSS
// vector). Two prongs:
//   1. Pure units: HTML escaping + invite rendering (XSS guard), the
//      when-formatter, the create body schema, and the row→API mapper.
//   2. HTTP route behaviour with mocked Supabase + auth: list gating and
//      mapping.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Pass through every rate limiter the router wires up.
vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next();
  return {
    adminRateLimit: () => passthrough,
    adminReadRateLimiter: passthrough,
    adminWriteRateLimiter: passthrough,
  };
});

import videoVisitsRouter, {
  createBody,
  escapeHtml,
  formatWhen,
  renderInviteEmailHtml,
  renderInviteEmailText,
  toApiVisit,
  type VisitListRow,
} from "./video-visits";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "admin@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(videoVisitsRouter);
  return app;
}

function visitRow(over: Partial<VisitListRow> = {}): VisitListRow {
  return {
    id: "v1",
    patient_id: "p1",
    purpose: "setup",
    notes: null,
    status: "scheduled",
    scheduled_at: null,
    created_by_email: "admin@penn.example.com",
    link_version: 1,
    invite_channel: "email",
    invite_delivered: true,
    invite_delivery_status: null,
    invite_delivery_error_code: null,
    staff_joined_at: null,
    patient_joined_at: null,
    started_at: null,
    ended_at: null,
    created_at: "2026-06-01T00:00:00Z",
    guest_name: null,
    guest_email: null,
    guest_phone_e164: null,
    patients: { legal_first_name: "Ada", legal_last_name: "Lovelace" },
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

// ---------------------------------------------------------------------------
// escapeHtml — XSS guard
// ---------------------------------------------------------------------------
describe("escapeHtml", () => {
  it("escapes &, <, >, and double-quote", () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot;",
    );
  });

  it("neutralises a script tag", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });
});

// ---------------------------------------------------------------------------
// renderInviteEmailHtml/Text — no raw HTML from caller-controlled input
// ---------------------------------------------------------------------------
describe("renderInviteEmail*", () => {
  it("escapes the greeting, practice name, and link in the HTML body", () => {
    const html = renderInviteEmailHtml(
      "<script>x</script>",
      'Penn "Home" Medical & Co',
      "Monday, June 22",
      'https://x.test/join?t=a"onmouseover="alert(1)',
    );
    // The raw script tag must not survive into the markup.
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("Penn &quot;Home&quot; Medical &amp; Co");
    // The href value is escaped so an injected attribute can't break out.
    expect(html).toContain("onmouseover=&quot;alert(1)");
    expect(html).not.toContain('onmouseover="alert(1)"');
  });

  it("omits the When line when no time is given, includes it otherwise", () => {
    expect(
      renderInviteEmailHtml("Sam", "Penn", null, "https://x"),
    ).not.toContain("<strong>When:</strong>");
    expect(
      renderInviteEmailHtml("Sam", "Penn", "Tuesday", "https://x"),
    ).toContain("<strong>When:</strong> Tuesday");
  });

  it("renders a plain-text alternative with the link", () => {
    const text = renderInviteEmailText("Sam", "Penn", "Tuesday", "https://x/j");
    expect(text).toContain("Hi Sam,");
    expect(text).toContain("When: Tuesday");
    expect(text).toContain("Join your video visit: https://x/j");
  });
});

// ---------------------------------------------------------------------------
// formatWhen — null / invalid-date safety + Eastern-time rendering
// ---------------------------------------------------------------------------
describe("formatWhen", () => {
  it("returns null for null or an unparseable date", () => {
    expect(formatWhen(null)).toBeNull();
    expect(formatWhen("not a date")).toBeNull();
  });

  it("formats a valid ISO timestamp in America/New_York", () => {
    const out = formatWhen("2026-06-22T15:00:00Z");
    expect(out).toContain("June 22");
    // June is daylight time on the US east coast.
    expect(out).toContain("EDT");
  });
});

// ---------------------------------------------------------------------------
// createBody — visit-creation input validation
// ---------------------------------------------------------------------------
describe("createBody schema", () => {
  it("accepts a minimal valid email visit", () => {
    expect(
      createBody.safeParse({ purpose: "setup", channel: "email" }).success,
    ).toBe(true);
  });

  it("rejects an unknown purpose or channel", () => {
    expect(
      createBody.safeParse({ purpose: "party", channel: "email" }).success,
    ).toBe(false);
    expect(
      createBody.safeParse({ purpose: "setup", channel: "carrier-pigeon" })
        .success,
    ).toBe(false);
  });

  it("rejects a non-E.164 phone and a malformed email", () => {
    expect(
      createBody.safeParse({
        purpose: "setup",
        channel: "sms",
        phoneE164: "215-555-1234",
      }).success,
    ).toBe(false);
    expect(
      createBody.safeParse({
        purpose: "setup",
        channel: "email",
        email: "not-an-email",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict) and a non-ISO scheduledAt", () => {
    expect(
      createBody.safeParse({ purpose: "setup", channel: "none", sneaky: 1 })
        .success,
    ).toBe(false);
    expect(
      createBody.safeParse({
        purpose: "setup",
        channel: "none",
        scheduledAt: "tomorrow",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toApiVisit — chart name vs guest name vs none
// ---------------------------------------------------------------------------
describe("toApiVisit", () => {
  it("uses the patient's chart name and marks it not-a-guest", () => {
    const v = toApiVisit(visitRow());
    expect(v.patientName).toBe("Ada Lovelace");
    expect(v.isGuest).toBe(false);
  });

  it("falls back to the guest name when there's no chart patient", () => {
    const v = toApiVisit(
      visitRow({ patient_id: null, patients: null, guest_name: "Walk In" }),
    );
    expect(v.patientName).toBe("Walk In");
    expect(v.isGuest).toBe(true);
  });

  it("is null when neither a chart name nor a guest name exists", () => {
    const v = toApiVisit(
      visitRow({ patient_id: null, patients: null, guest_name: null }),
    );
    expect(v.patientName).toBeNull();
    expect(v.isGuest).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP — GET /admin/video-visits
// ---------------------------------------------------------------------------
describe("GET /admin/video-visits", () => {
  it("401s when no admin is signed in", async () => {
    const res = await request(makeApp()).get("/admin/video-visits");
    expect(res.status).toBe(401);
  });

  it("returns visits mapped through toApiVisit for a signed-in admin", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("video_visits", "select", {
      data: [
        visitRow({ id: "v1" }),
        visitRow({
          id: "v2",
          patient_id: null,
          patients: null,
          guest_name: "Walk In",
        }),
      ],
    });
    const res = await request(makeApp()).get("/admin/video-visits");
    expect(res.status).toBe(200);
    expect(res.body.visits).toHaveLength(2);
    expect(res.body.visits[0]).toMatchObject({
      id: "v1",
      patientName: "Ada Lovelace",
      isGuest: false,
    });
    expect(res.body.visits[1]).toMatchObject({
      id: "v2",
      patientName: "Walk In",
      isGuest: true,
    });
  });
});
