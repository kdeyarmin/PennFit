// Demo coverage for the super-admin PLATFORM console and the six tenant
// admin FITTING/REFERRAL pages.
//
// Why this file exists: the demo sandbox answers an unmatched GET with the
// "empty everything" fallback, so a page with no seeded routes still
// renders — it just renders EMPTY, silently. That failure mode is
// invisible to `router.test.ts`'s existing checks (which assert shapes for
// surfaces that ARE seeded). These tests pin the opposite property: that
// each of these surfaces is genuinely seeded, and — for the write paths —
// that an action is reflected by the next read, which is what makes the
// demo a demo rather than a set of static screenshots.
//
// The store is module-level and session-scoped (reset on reload), so tests
// that mutate are written to be order-independent within their own subject.

import { describe, expect, it } from "vitest";

import { routeDemoRequest } from "./router";

async function req<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await routeDemoRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(
    res,
    `${method} ${url} was not handled by the demo router`,
  ).not.toBeNull();
  return { status: res!.status, body: (await res!.json()) as T };
}

const get = <T>(url: string) => req<T>("GET", url);
const post = <T>(url: string, body?: unknown) => req<T>("POST", url, body);
const put = <T>(url: string, body?: unknown) => req<T>("PUT", url, body);
const patch = <T>(url: string, body?: unknown) => req<T>("PATCH", url, body);
const del = <T>(url: string) => req<T>("DELETE", url);

const P = "/resupply-api/platform";
const A = "/resupply-api/admin";

describe("platform console — fleet dashboard", () => {
  it("seeds a tenant directory rather than an empty list", async () => {
    const { body } = await get<{
      tenants: Array<{ id: string; status: string }>;
    }>(`${P}/tenants`);
    expect(body.tenants.length).toBeGreaterThan(1);
    // The fleet deliberately includes a suspended tenant so the
    // directory's lifecycle actions have something to act on.
    expect(body.tenants.some((t) => t.status === "suspended")).toBe(true);
  });

  it("returns analytics whose series line up with the day labels", async () => {
    const { body } = await get<{
      windowDays: number;
      dayKeys: string[];
      series: { newPatients: number[]; gmvCents: number[] };
      totals: { tenants: { total: number } };
      tenants: unknown[];
    }>(`${P}/analytics?days=30`);
    expect(body.windowDays).toBe(30);
    expect(body.dayKeys).toHaveLength(30);
    expect(body.series.newPatients).toHaveLength(30);
    expect(body.series.gmvCents).toHaveLength(30);
    expect(body.totals.tenants.total).toBe(body.tenants.length);
  });

  it("honours the analytics window parameter", async () => {
    const { body } = await get<{ windowDays: number; dayKeys: string[] }>(
      `${P}/analytics?days=7`,
    );
    expect(body.windowDays).toBe(7);
    expect(body.dayKeys).toHaveLength(7);
  });

  it("reports fleet margin with a ratio derived from costed revenue", async () => {
    const { body } = await get<{
      fleet: {
        revenueCents: number;
        costedRevenueCents: number;
        marginCents: number;
        marginRatio: number | null;
      };
      tenants: unknown[];
    }>(`${P}/margin?days=30`);
    expect(body.tenants.length).toBeGreaterThan(0);
    expect(body.fleet.revenueCents).toBeGreaterThan(0);
    expect(body.fleet.marginRatio).toBeCloseTo(
      body.fleet.marginCents / body.fleet.costedRevenueCents,
      6,
    );
  });

  it("serves the fleet overview with per-tenant usage counts", async () => {
    const { body } = await get<{
      tenants: Array<{ usage: Record<string, number | null> }>;
    }>(`${P}/overview`);
    expect(body.tenants.length).toBeGreaterThan(0);
    expect(body.tenants[0].usage).toHaveProperty("patients");
  });

  it("reports platform health with readiness and vendor flags", async () => {
    const { body } = await get<{
      readiness: { status: string; checks: { db: string } };
      vendors: { ai: { anthropic: boolean }; comms: { sendgrid: boolean } };
    }>(`${P}/health`);
    expect(body.readiness.status).toBe("ready");
    expect(body.readiness.checks.db).toBe("ok");
    expect(body.vendors.ai.anthropic).toBe(true);
  });
});

describe("platform console — tenant lifecycle", () => {
  it("suspends and reactivates a tenant, and the directory reflects it", async () => {
    const suspended = await post<{ tenant: { status: string } }>(
      `${P}/tenants/demo-tenant-1/suspend`,
    );
    expect(suspended.body.tenant.status).toBe("suspended");

    const afterSuspend = await get<{
      tenants: Array<{ id: string; status: string }>;
    }>(`${P}/tenants`);
    expect(
      afterSuspend.body.tenants.find((t) => t.id === "demo-tenant-1")?.status,
    ).toBe("suspended");

    // Put it back so the rest of the suite sees the seeded fleet.
    const reactivated = await post<{ tenant: { status: string } }>(
      `${P}/tenants/demo-tenant-1/reactivate`,
    );
    expect(reactivated.body.tenant.status).toBe("active");
  });

  it("creates a tenant that then appears in the directory", async () => {
    const created = await post<{
      tenant: { id: string; slug: string; name: string | null };
      flagsProvisioned: number;
    }>(`${P}/tenants`, { slug: "test-dme", name: "Test DME" });
    expect(created.status).toBe(201);
    expect(created.body.tenant.slug).toBe("test-dme");
    expect(created.body.flagsProvisioned).toBeGreaterThan(0);

    const { body } = await get<{ tenants: Array<{ id: string }> }>(
      `${P}/tenants`,
    );
    expect(body.tenants.some((t) => t.id === created.body.tenant.id)).toBe(
      true,
    );
  });

  it("404s a tenant detail for an unknown id instead of inventing one", async () => {
    const { status } = await get(`${P}/tenants/not-a-real-tenant`);
    expect(status).toBe(404);
  });

  it("serves per-tenant usage, admins and an activity series", async () => {
    const usage = await get<{ usage: { patients: number } }>(
      `${P}/tenants/demo-tenant-1/usage`,
    );
    expect(usage.body.usage.patients).toBeGreaterThan(0);

    const admins = await get<{ admins: unknown[] }>(
      `${P}/tenants/demo-tenant-1/admins`,
    );
    expect(admins.body.admins.length).toBeGreaterThan(0);

    const activity = await get<{
      dayKeys: string[];
      series: { newOrders: number[] };
    }>(`${P}/tenants/demo-tenant-1/activity-series?days=14`);
    expect(activity.body.dayKeys).toHaveLength(14);
    expect(activity.body.series.newOrders).toHaveLength(14);
  });

  it("creates a tenant admin and hands back an invite link when no mail goes out", async () => {
    const { body } = await post<{
      admin: { email: string | null; status: string };
      emailSent: boolean;
      inviteLink: string | null;
      signInReady: boolean;
    }>(`${P}/tenants/demo-tenant-2/admins`, { email: "New.Admin@Example.com" });
    expect(body.admin.email).toBe("new.admin@example.com");
    expect(body.emailSent).toBe(false);
    expect(body.inviteLink).toContain("/admin/reset-password?token=");
    expect(body.signInReady).toBe(false);
  });

  it("marks an admin sign-in-ready when an initial password is supplied", async () => {
    const { body } = await post<{
      admin: { status: string };
      inviteLink: string | null;
      signInReady: boolean;
    }>(`${P}/tenants/demo-tenant-2/admins`, {
      email: "direct@example.com",
      initialPassword: "a-long-enough-password",
    });
    expect(body.signInReady).toBe(true);
    expect(body.admin.status).toBe("active");
    // A live link belongs in an inbox, not on screen — and there is none here.
    expect(body.inviteLink).toBeNull();
  });

  it("impersonates a tenant and stops again", async () => {
    const start = await post<{ ok: boolean; impersonatingOrgId: string }>(
      `${P}/tenants/demo-tenant-1/impersonate`,
    );
    expect(start.body.impersonatingOrgId).toBe("demo-tenant-1");
    const stop = await post<{ stopped: boolean }>(`${P}/impersonation/stop`);
    expect(stop.body.stopped).toBe(true);
  });
});

describe("platform console — feature flags", () => {
  it("seeds a flag catalog including one this build cannot toggle", async () => {
    const { body } = await get<{
      flags: Array<{ key: string; manageable: boolean; category: string }>;
    }>(`${P}/tenants/demo-tenant-1/feature-flags`);
    expect(body.flags.length).toBeGreaterThan(10);
    expect(body.flags.some((f) => !f.manageable)).toBe(true);
  });

  it("toggling a flag persists and lands in the activity feed", async () => {
    const before = await get<{
      flags: Array<{ key: string; enabled: boolean }>;
    }>(`${P}/tenants/demo-tenant-2/feature-flags`);
    const target = before.body.flags.find(
      (f) => f.key === "storefront.pickup",
    )!;
    const next = !target.enabled;

    const toggled = await patch<{ flag: { enabled: boolean } }>(
      `${P}/tenants/demo-tenant-2/feature-flags/storefront.pickup`,
      { enabled: next },
    );
    expect(toggled.body.flag.enabled).toBe(next);

    const after = await get<{
      flags: Array<{ key: string; enabled: boolean }>;
    }>(`${P}/tenants/demo-tenant-2/feature-flags`);
    expect(
      after.body.flags.find((f) => f.key === "storefront.pickup")?.enabled,
    ).toBe(next);

    const activity = await get<{
      activity: Array<{ key: string; to: boolean }>;
    }>(`${P}/tenants/demo-tenant-2/feature-flag-activity?limit=5`);
    expect(activity.body.activity[0].key).toBe("storefront.pickup");
    expect(activity.body.activity[0].to).toBe(next);
  });

  it("404s an unknown flag key", async () => {
    const { status } = await patch(
      `${P}/tenants/demo-tenant-1/feature-flags/not.a.real.flag`,
      { enabled: true },
    );
    expect(status).toBe(404);
  });
});

describe("platform console — global integrations", () => {
  it("seeds a categorised config catalog", async () => {
    const { body } = await get<{
      categories: Array<{
        category: string;
        settings: Array<{ key: string; configured: boolean; secret: boolean }>;
      }>;
      webhookReference: { endpoints: unknown[] } | null;
    }>(`${P}/config`);
    expect(body.categories.length).toBeGreaterThan(3);
    expect(body.webhookReference?.endpoints.length).toBeGreaterThan(0);
    const all = body.categories.flatMap((c) => c.settings);
    expect(all.some((s) => s.configured)).toBe(true);
    expect(all.some((s) => !s.configured)).toBe(true);
  });

  it("clearing a credential flips the matching vendor flag and the connection test", async () => {
    // Health and the connection tests both derive from config, so this is
    // the demo's cross-page cause-and-effect: clear the key on the
    // Integrations page, watch the Dashboard dot and the test change.
    const cleared = await del<{ removed: boolean }>(
      `${P}/config/SENDGRID_API_KEY`,
    );
    expect(cleared.body.removed).toBe(true);

    const health = await get<{ vendors: { comms: { sendgrid: boolean } } }>(
      `${P}/health`,
    );
    expect(health.body.vendors.comms.sendgrid).toBe(false);

    const test = await post<{ ok: boolean; code?: string }>(
      `${P}/connection-tests/email`,
      { to: "someone@example.com" },
    );
    expect(test.body.ok).toBe(false);
    expect(test.body.code).toBe("not_configured");

    // Restore it and confirm the effect reverses.
    const set = await put<{ setting: { configured: boolean } }>(
      `${P}/config/SENDGRID_API_KEY`,
      { value: "SG.restored" },
    );
    expect(set.body.setting.configured).toBe(true);
    const after = await post<{ ok: boolean }>(`${P}/connection-tests/email`, {
      to: "someone@example.com",
    });
    expect(after.body.ok).toBe(true);
  });

  it("records config writes in the activity feed", async () => {
    await put(`${P}/config/TWILIO_PHONE_NUMBER`, { value: "+12155550199" });
    const { body } = await get<{
      activity: Array<{ key: string; action: string }>;
    }>(`${P}/config/activity?limit=5`);
    expect(body.activity[0].key).toBe("TWILIO_PHONE_NUMBER");
    expect(body.activity[0].action).toBe("set");
  });

  it("404s a key that is not in the catalog", async () => {
    const { status } = await put(`${P}/config/NOT_A_REAL_KEY`, { value: "x" });
    expect(status).toBe(404);
  });
});

describe("platform console — operators", () => {
  it("grants and revokes a platform operator", async () => {
    const seeded = await get<{ operators: Array<{ authUserId: string }> }>(
      `${P}/admins`,
    );
    expect(seeded.body.operators.length).toBeGreaterThan(0);

    const granted = await post<{
      operator: { authUserId: string; email: string | null };
      created: boolean;
    }>(`${P}/admins`, { email: "New.Operator@cmbreathe.example" });
    expect(granted.body.created).toBe(true);
    expect(granted.body.operator.email).toBe("new.operator@cmbreathe.example");

    const afterGrant = await get<{ operators: Array<{ authUserId: string }> }>(
      `${P}/admins`,
    );
    expect(afterGrant.body.operators).toHaveLength(
      seeded.body.operators.length + 1,
    );

    await del(`${P}/admins/${granted.body.operator.authUserId}`);
    const afterRevoke = await get<{ operators: Array<{ authUserId: string }> }>(
      `${P}/admins`,
    );
    expect(afterRevoke.body.operators).toHaveLength(
      seeded.body.operators.length,
    );
  });

  it("does not duplicate an operator who is already granted", async () => {
    const { body } = await post<{ created: boolean }>(`${P}/admins`, {
      email: "ops@cmbreathe.example",
    });
    expect(body.created).toBe(false);
  });
});

describe("platform console — support queue", () => {
  it("seeds tickets with per-status counts", async () => {
    const { body } = await get<{
      tickets: Array<{ id: string; status: string }>;
      counts: Record<string, number>;
    }>(`${P}/support/tickets`);
    expect(body.tickets.length).toBeGreaterThan(1);
    expect(body.counts.all).toBe(body.tickets.length);
  });

  it("filters the queue by status", async () => {
    const { body } = await get<{ tickets: Array<{ status: string }> }>(
      `${P}/support/tickets?status=resolved`,
    );
    expect(body.tickets.length).toBeGreaterThan(0);
    expect(body.tickets.every((t) => t.status === "resolved")).toBe(true);
  });

  it("a platform reply appends to the thread and hands it back to the tenant", async () => {
    const before = await get<{ messages: unknown[] }>(
      `${P}/support/tickets/demo-ticket-1`,
    );
    const replied = await post<{
      ticket: { status: string };
      messages: Array<{ authorRole: string; body: string }>;
    }>(`${P}/support/tickets/demo-ticket-1/reply`, {
      body: "Looking into the SFTP pull now.",
    });

    expect(replied.body.messages).toHaveLength(before.body.messages.length + 1);
    const last = replied.body.messages[replied.body.messages.length - 1];
    expect(last.authorRole).toBe("platform");
    expect(last.body).toBe("Looking into the SFTP pull now.");
    expect(replied.body.ticket.status).toBe("awaiting_tenant");
  });

  it("sets a ticket status", async () => {
    const { body } = await post<{ ticket: { status: string } }>(
      `${P}/support/tickets/demo-ticket-4/status`,
      { status: "resolved" },
    );
    expect(body.ticket.status).toBe("resolved");
  });
});

describe("platform console — outreach", () => {
  it("lists contacts and filters them by search and tag", async () => {
    const all = await get<{
      contacts: Array<{ email: string; tags: string[] }>;
    }>(`${P}/contacts`);
    expect(all.body.contacts.length).toBeGreaterThan(2);

    const tagged = await get<{ contacts: Array<{ tags: string[] }> }>(
      `${P}/contacts?tag=prospect`,
    );
    expect(tagged.body.contacts.length).toBeGreaterThan(0);
    expect(tagged.body.contacts.every((c) => c.tags.includes("prospect"))).toBe(
      true,
    );

    const searched = await get<{ contacts: Array<{ email: string }> }>(
      `${P}/contacts?search=lakeside`,
    );
    expect(searched.body.contacts.length).toBe(1);
  });

  it("creates, updates, unsubscribes and deletes a contact", async () => {
    const created = await post<{ contact: { id: string; email: string } }>(
      `${P}/contacts`,
      {
        email: "Fresh.Lead@example.com",
        name: "Fresh Lead",
        tags: ["prospect"],
      },
    );
    const id = created.body.contact.id;
    expect(created.body.contact.email).toBe("fresh.lead@example.com");

    const updated = await patch<{ contact: { company: string | null } }>(
      `${P}/contacts/${id}`,
      { company: "Fresh DME" },
    );
    expect(updated.body.contact.company).toBe("Fresh DME");

    const unsub = await post<{ contact: { unsubscribed: boolean } }>(
      `${P}/contacts/${id}/unsubscribe`,
    );
    expect(unsub.body.contact.unsubscribed).toBe(true);

    await del(`${P}/contacts/${id}`);
    const after = await get<{ contacts: Array<{ id: string }> }>(
      `${P}/contacts`,
    );
    expect(after.body.contacts.some((c) => c.id === id)).toBe(false);
  });

  it("imports pasted contacts and skips duplicates", async () => {
    const raw = [
      "Dana Imported <dana.imported@example.com>",
      "second.import@example.com",
      "kelly.moore@lakesidedme.example", // already seeded — must be skipped
    ].join("\n");
    const { body } = await post<{ imported: number; skipped: number }>(
      `${P}/contacts/import`,
      { raw, tags: ["conference-2026"] },
    );
    expect(body.imported).toBe(2);
    expect(body.skipped).toBe(1);
  });

  it("drafts a campaign, suppressing unsubscribed contacts", async () => {
    const { body } = await post<{
      id: string;
      totals: { total: number; pending: number; suppressed: number };
    }>(`${P}/email-campaigns/draft`, {
      name: "Test blast",
      subject: "Hello",
      bodyText: "Body",
      audienceKind: "all_contacts",
    });
    expect(body.totals.total).toBe(
      body.totals.pending + body.totals.suppressed,
    );
    expect(body.totals.suppressed).toBeGreaterThan(0);

    const detail = await get<{
      id: string;
      status: string;
      recipients: unknown[];
    }>(`${P}/email-campaigns/${body.id}`);
    expect(detail.body.status).toBe("draft");
    expect(detail.body.recipients).toHaveLength(body.totals.total);
  });

  it("drives a campaign through its lifecycle actions", async () => {
    const draft = await post<{ id: string }>(`${P}/email-campaigns/draft`, {
      name: "Lifecycle",
      subject: "Hi",
      bodyText: "Body",
      audienceKind: "all_tenants",
    });
    const id = draft.body.id;

    const started = await post<{ status: string }>(
      `${P}/email-campaigns/${id}/start`,
    );
    expect(["sending", "sent"]).toContain(started.body.status);

    const paused = await post<{ status: string }>(
      `${P}/email-campaigns/${id}/pause`,
    );
    expect(paused.body.status).toBe("paused");

    const resumed = await post<{ status: string }>(
      `${P}/email-campaigns/${id}/resume`,
    );
    expect(["sending", "sent"]).toContain(resumed.body.status);

    const cancelled = await post<{ status: string }>(
      `${P}/email-campaigns/${id}/cancel`,
    );
    expect(cancelled.body.status).toBe("cancelled");
  });

  it("lists seeded campaigns", async () => {
    const { body } = await get<{
      campaigns: Array<{ id: string; status: string }>;
    }>(`${P}/email-campaigns`);
    expect(body.campaigns.length).toBeGreaterThan(1);
  });
});

describe("platform console — vendor costs and launch checklist", () => {
  it("round-trips the cost rates", async () => {
    const before = await get<{ rates: { faxEventCents: number } }>(
      `${P}/cost-rates`,
    );
    expect(before.body.rates.faxEventCents).toBeGreaterThan(0);

    const updated = await put<{ rates: { faxEventCents: number } }>(
      `${P}/cost-rates`,
      {
        ...before.body.rates,
        faxEventCents: 7,
      },
    );
    expect(updated.body.rates.faxEventCents).toBe(7);

    const after = await get<{ rates: { faxEventCents: number } }>(
      `${P}/cost-rates`,
    );
    expect(after.body.rates.faxEventCents).toBe(7);
  });

  it("serves a launch checklist with required and optional rows", async () => {
    const { body } = await get<{
      items: Array<{ tab: string; status: string; group: string }>;
    }>(`${P}/account-setup`);
    expect(body.items.some((i) => i.tab === "required")).toBe(true);
    expect(body.items.some((i) => i.tab === "optional")).toBe(true);
  });

  it("reports connection-test status for every channel", async () => {
    const { body } = await get<{
      email: { configured: boolean };
      chat: { configured: boolean; provider: string };
    }>(`${P}/connection-tests/status`);
    expect(body.chat.provider).toBe("anthropic");
  });

  it("runs the chat, sms and voice connection tests", async () => {
    for (const channel of ["chat", "sms", "voice"] as const) {
      const { body } = await post<{ ok: boolean; channel: string }>(
        `${P}/connection-tests/${channel}`,
        channel === "chat" ? {} : { to: "+12155550123" },
      );
      expect(body.channel).toBe(channel);
      expect(body.ok).toBe(true);
    }
  });
});

describe("tenant admin — mask catalog", () => {
  it("seeds a catalog and filters it", async () => {
    const all = await get<{
      models: Array<{ id: string; manufacturer: string }>;
    }>(`${A}/fitter/catalog`);
    expect(all.body.models.length).toBeGreaterThan(5);

    const resmed = await get<{ models: Array<{ manufacturer: string }> }>(
      `${A}/fitter/catalog?manufacturer=ResMed`,
    );
    expect(resmed.body.models.length).toBeGreaterThan(0);
    expect(resmed.body.models.every((m) => m.manufacturer === "ResMed")).toBe(
      true,
    );

    const search = await get<{ models: Array<{ modelName: string }> }>(
      `${A}/fitter/catalog?search=dreamwear`,
    );
    expect(search.body.models.length).toBe(1);
  });

  it("serves a model detail with variants and contraindications", async () => {
    const { body } = await get<{
      model: { modelName: string; hasMagneticComponents: boolean };
      variants: unknown[];
      contraindications: Array<{ severity: string }>;
      editable: boolean;
    }>(`${A}/fitter/catalog/demo-mask-3`);
    expect(body.variants.length).toBeGreaterThan(0);
    // The magnetic full-face model carries exclusion contraindications.
    expect(body.model.hasMagneticComponents).toBe(true);
    expect(body.contraindications.some((c) => c.severity === "exclude")).toBe(
      true,
    );
    // Platform rows are shared data — sign-off only, no editing.
    expect(body.editable).toBe(false);
  });

  it("signing off a size band clears its review flag and records provenance", async () => {
    const before = await get<{
      variants: Array<{ id: string; needsClinicalReview: boolean }>;
    }>(`${A}/fitter/catalog/demo-mask-4`);
    const unsigned = before.body.variants.find((v) => v.needsClinicalReview);
    expect(
      unsigned,
      "demo-mask-4 should seed at least one unsigned band",
    ).toBeDefined();

    const reviewed = await post<{
      variant: {
        needsClinicalReview: boolean;
        reviewSourceKind: string | null;
        reviewedByEmail: string | null;
      };
    }>(`${A}/fitter/catalog/variants/${unsigned!.id}/review`, {
      sourceKind: "manufacturer_fit_guide",
      sourceRef: "ResMed guide rev. 2026-01",
    });
    expect(reviewed.body.variant.needsClinicalReview).toBe(false);
    expect(reviewed.body.variant.reviewSourceKind).toBe(
      "manufacturer_fit_guide",
    );
    expect(reviewed.body.variant.reviewedByEmail).not.toBeNull();

    const after = await get<{
      variants: Array<{ id: string; needsClinicalReview: boolean }>;
    }>(`${A}/fitter/catalog/demo-mask-4`);
    expect(
      after.body.variants.find((v) => v.id === unsigned!.id)
        ?.needsClinicalReview,
    ).toBe(false);
  });

  it("signs off a batch of bands at once", async () => {
    const { body: detail } = await get<{
      variants: Array<{ id: string; needsClinicalReview: boolean }>;
    }>(`${A}/fitter/catalog/demo-mask-9`);
    const ids = detail.variants
      .filter((v) => v.needsClinicalReview)
      .map((v) => v.id);
    expect(ids.length).toBeGreaterThan(0);

    const { body } = await post<{ reviewed: number; skipped: number }>(
      `${A}/fitter/catalog/variants/review-batch`,
      { ids, sourceKind: "clinical_judgment" },
    );
    expect(body.reviewed).toBe(ids.length);
    expect(body.skipped).toBe(0);
  });

  it("refuses to edit a shared platform row", async () => {
    const { status } = await patch(`${A}/fitter/catalog/demo-mask-1`, {
      modelName: "Renamed",
    });
    expect(status).toBe(409);
  });
});

describe("tenant admin — formulary", () => {
  it("seeds a formulary with rules", async () => {
    const { body } = await get<{
      formulary: {
        name: string;
        defaultPosture: string;
        version: number;
      } | null;
      rules: Array<{ effect: string }>;
    }>(`${A}/fitter/formulary`);
    expect(body.formulary).not.toBeNull();
    expect(body.rules.length).toBeGreaterThan(1);
    expect(body.rules.some((r) => r.effect === "deny")).toBe(true);
  });

  it("simulates the current rules across a synthetic panel", async () => {
    const { body } = await post<{
      formulary: { defaultPosture: string };
      panel: Array<{
        label: string;
        allowedCount: number;
        deniedCount: number;
      }>;
    }>(`${A}/fitter/formulary/simulate`, {});
    expect(body.panel.length).toBeGreaterThan(2);
    expect(body.panel.some((p) => p.allowedCount > 0)).toBe(true);
  });

  it("a new deny rule changes what the simulator allows", async () => {
    const baseline = await post<{
      panel: Array<{ label: string; allowedCount: number }>;
    }>(`${A}/fitter/formulary/simulate`, {});
    const before = baseline.body.panel.reduce((a, p) => a + p.allowedCount, 0);

    const created = await post<{ id: string }>(`${A}/fitter/formulary/rules`, {
      targetKind: "manufacturer",
      targetManufacturer: "Fisher & Paykel",
      effect: "deny",
      reasonCode: "contract_lapsed",
    });

    const after = await post<{ panel: Array<{ allowedCount: number }> }>(
      `${A}/fitter/formulary/simulate`,
      {},
    );
    const afterTotal = after.body.panel.reduce((a, p) => a + p.allowedCount, 0);
    expect(afterTotal).toBeLessThan(before);

    // Deleting it restores the baseline — proving the simulator reads live rules.
    await del(`${A}/fitter/formulary/rules/${created.body.id}`);
    const restored = await post<{ panel: Array<{ allowedCount: number }> }>(
      `${A}/fitter/formulary/simulate`,
      {},
    );
    expect(restored.body.panel.reduce((a, p) => a + p.allowedCount, 0)).toBe(
      before,
    );
  });

  it("publishing bumps the formulary version", async () => {
    const before = await get<{ formulary: { version: number } | null }>(
      `${A}/fitter/formulary`,
    );
    const published = await post<{ ok: boolean; version: number }>(
      `${A}/fitter/formulary/publish`,
    );
    expect(published.body.version).toBe(before.body.formulary!.version + 1);
  });
});

describe("tenant admin — fit sessions", () => {
  it("seeds a review queue and filters by review status", async () => {
    const all = await get<{
      sessions: Array<{ id: string; reviewStatus: string }>;
    }>(`${A}/fit-sessions`);
    expect(all.body.sessions.length).toBeGreaterThan(3);

    const pending = await get<{ sessions: Array<{ reviewStatus: string }> }>(
      `${A}/fit-sessions?reviewStatus=pending_review`,
    );
    expect(pending.body.sessions.length).toBeGreaterThan(0);
    expect(
      pending.body.sessions.every((s) => s.reviewStatus === "pending_review"),
    ).toBe(true);
  });

  it("serves a session detail with ranked recommendations", async () => {
    const { body } = await get<{
      session: { outcome: string | null };
      measurements: Record<string, number>;
      recommendations: Array<{ rank: number; maskName: string }>;
    }>(`${A}/fit-sessions/demo-fit-1`);
    expect(body.recommendations.length).toBe(3);
    expect(body.recommendations[0].rank).toBe(1);
    expect(body.measurements.noseWidthMm).toBeGreaterThan(0);
  });

  it("approving a session removes it from the pending queue", async () => {
    await post(`${A}/fit-sessions/demo-fit-3/approve`, {
      note: "Bands check out.",
    });
    const { body } = await get<{ sessions: Array<{ id: string }> }>(
      `${A}/fit-sessions?reviewStatus=pending_review`,
    );
    expect(body.sessions.some((s) => s.id === "demo-fit-3")).toBe(false);
  });

  it("overriding a session records the chosen mask", async () => {
    await post(`${A}/fit-sessions/demo-fit-5/override`, {
      maskModelId: "demo-mask-2",
      reason: "Patient cannot tolerate a full face mask.",
    });
    const { body } = await get<{
      sessions: Array<{
        id: string;
        recommendedMask: string | null;
        reviewStatus: string;
      }>;
    }>(`${A}/fit-sessions`);
    const session = body.sessions.find((s) => s.id === "demo-fit-5");
    expect(session?.reviewStatus).toBe("overridden");
    expect(session?.recommendedMask).toContain("AirFit P10");
  });

  it("requesting a rescan returns a link the console can pass to the patient", async () => {
    const { body } = await post<{ ok: boolean; link: string; sent: boolean }>(
      `${A}/fit-sessions/demo-fit-6/request-rescan`,
    );
    expect(body.link).toContain("/fit/rescan/");
    // Nothing actually leaves the sandbox.
    expect(body.sent).toBe(false);
  });
});

describe("tenant admin — safety screens", () => {
  it("seeds the platform screen as the active default", async () => {
    const { body } = await get<{
      activeVersionId: string | null;
      usingPlatformDefault: boolean;
      versions: Array<{
        id: string;
        isPlatform: boolean;
        questions: unknown[];
      }>;
    }>(`${A}/fitter/safety-screens`);
    expect(body.usingPlatformDefault).toBe(true);
    expect(body.versions.length).toBeGreaterThan(1);
    expect(body.versions[0].questions.length).toBeGreaterThan(3);
  });

  it("refuses to edit the platform screen", async () => {
    const { status } = await patch(
      `${A}/fitter/safety-screens/demo-screen-platform`,
      {
        title: "Renamed",
      },
    );
    expect(status).toBe(409);
  });

  it("publishing a tenant draft takes over from the platform default", async () => {
    const published = await post<{ version: { id: string; status: string } }>(
      `${A}/fitter/safety-screens/demo-screen-draft/publish`,
    );
    expect(published.body.version.status).toBe("active");

    const after = await get<{
      activeVersionId: string | null;
      usingPlatformDefault: boolean;
    }>(`${A}/fitter/safety-screens`);
    expect(after.body.activeVersionId).toBe("demo-screen-draft");
    expect(after.body.usingPlatformDefault).toBe(false);

    // Retiring it falls back to the platform screen.
    await post(`${A}/fitter/safety-screens/demo-screen-draft/retire`);
    const restored = await get<{ usingPlatformDefault: boolean }>(
      `${A}/fitter/safety-screens`,
    );
    expect(restored.body.usingPlatformDefault).toBe(true);
  });

  it("clones the active screen into a new draft", async () => {
    const { body } = await post<{
      version: {
        id: string;
        status: string;
        isPlatform: boolean;
        questions: unknown[];
      };
    }>(`${A}/fitter/safety-screens`, { title: "My screen" });
    expect(body.version.status).toBe("draft");
    expect(body.version.isPlatform).toBe(false);
    expect(body.version.questions.length).toBeGreaterThan(0);
  });
});

describe("tenant admin — provider referrals", () => {
  it("seeds an inbox and filters to open referrals", async () => {
    const all = await get<{ referrals: Array<{ id: string; status: string }> }>(
      `${A}/provider-referrals`,
    );
    expect(all.body.referrals.length).toBeGreaterThan(3);

    const open = await get<{ referrals: Array<{ status: string }> }>(
      `${A}/provider-referrals?open=true`,
    );
    expect(open.body.referrals.length).toBeGreaterThan(0);
    expect(open.body.referrals.every((r) => r.status !== "declined")).toBe(
      true,
    );
  });

  it("serves a referral detail with documents, events and messages", async () => {
    const { body } = await get<{
      patient: { firstName: string };
      documents: unknown[];
      events: unknown[];
      messages: unknown[];
    }>(`${A}/provider-referrals/demo-referral-1`);
    expect(body.patient.firstName).toBe("Amara");
    expect(body.documents.length).toBeGreaterThan(0);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("accepting a referral moves it out of the submitted queue", async () => {
    const accepted = await post<{ status: string }>(
      `${A}/provider-referrals/demo-referral-2/accept`,
    );
    expect(accepted.body.status).toBe("accepted");

    const submitted = await get<{ referrals: Array<{ id: string }> }>(
      `${A}/provider-referrals?status=submitted`,
    );
    expect(
      submitted.body.referrals.some((r) => r.id === "demo-referral-2"),
    ).toBe(false);
  });

  it("declining records the reason", async () => {
    const declined = await post<{ status: string }>(
      `${A}/provider-referrals/demo-referral-3/decline`,
      { reason: "Patient is out of area." },
    );
    expect(declined.body.status).toBe("declined");
    const detail = await get<{ declinedReason: string | null }>(
      `${A}/provider-referrals/demo-referral-3`,
    );
    expect(detail.body.declinedReason).toBe("Patient is out of area.");
  });

  it("replying appends a staff message to the thread", async () => {
    const before = await get<{ messages: unknown[] }>(
      `${A}/provider-referrals/demo-referral-1`,
    );
    await post(`${A}/provider-referrals/demo-referral-1/messages`, {
      body: "We can fit her on the 11th.",
    });
    const after = await get<{
      messages: Array<{ authorKind: string; body: string }>;
    }>(`${A}/provider-referrals/demo-referral-1`);
    expect(after.body.messages).toHaveLength(before.body.messages.length + 1);
    expect(after.body.messages[after.body.messages.length - 1].authorKind).toBe(
      "staff",
    );
  });

  it("lists and invites referring providers", async () => {
    const seeded = await get<{ providers: Array<{ status: string }> }>(
      `${A}/provider-referrals/providers`,
    );
    expect(seeded.body.providers.length).toBeGreaterThan(1);
    expect(seeded.body.providers.some((p) => p.status === "suspended")).toBe(
      true,
    );

    const invited = await post<{
      provider: { id: string; displayName: string | null };
    }>(`${A}/provider-referrals/providers`, {
      email: "dr.new@clinic.example",
      displayName: "Dr. New",
    });
    expect(invited.body.provider.displayName).toBe("Dr. New");

    const revoked = await patch<{
      provider: { status: string; revokedAt: string | null };
    }>(`${A}/provider-referrals/providers/${invited.body.provider.id}`, {
      status: "revoked",
    });
    expect(revoked.body.provider.status).toBe("revoked");
    expect(revoked.body.provider.revokedAt).not.toBeNull();
  });
});

describe("tenant admin — referral reviews (AI triage)", () => {
  it("seeds a triage queue spanning the status range", async () => {
    const { body } = await get<{
      reviews: Array<{ id: string; status: string }>;
    }>(`${A}/referral-reviews?status=all`);
    expect(body.reviews.length).toBeGreaterThan(3);
    const statuses = new Set(body.reviews.map((r) => r.status));
    // The interesting states for the triage UI: something to work, something
    // that failed, something already done.
    expect(statuses.has("extracted")).toBe(true);
    expect(statuses.has("failed")).toBe(true);
    expect(statuses.has("accepted")).toBe(true);
  });

  it("an extracted review carries a full extraction and a qualification verdict", async () => {
    const { body } = await get<{
      status: string;
      faxFromE164: string | null;
      extraction: {
        patient: { firstName: string | null };
        sleepStudy: { ahi: number | null } | null;
        order: unknown[];
        confidence: Record<string, string>;
      } | null;
      report: {
        qualification: { verdict: string };
        completeness: { outstandingCount: number };
      } | null;
    }>(`${A}/referral-reviews/demo-review-1`);
    expect(body.status).toBe("extracted");
    expect(body.extraction?.patient.firstName).toBe("Gloria");
    expect(body.extraction?.sleepStudy?.ahi).toBeGreaterThan(15);
    expect(body.extraction?.order.length).toBeGreaterThan(0);
    expect(body.report?.qualification.verdict).toBe("qualifies");
    // Detail-only field, proving this is the detail shape not the summary.
    expect(body.faxFromE164).toBeTruthy();
  });

  it("a sub-threshold AHI reports the comorbidity path, not a clean qualify", async () => {
    const { body } = await get<{
      report: {
        qualification: { verdict: string; hasDocumentedComorbidity: boolean };
      } | null;
    }>(`${A}/referral-reviews/demo-review-2`);
    expect(body.report?.qualification.verdict).toBe(
      "qualifies_with_comorbidity",
    );
    expect(body.report?.qualification.hasDocumentedComorbidity).toBe(true);
  });

  it("a failed extraction explains itself instead of showing a blank packet", async () => {
    const { body } = await get<{ status: string; errorReason: string | null }>(
      `${A}/referral-reviews/demo-review-6`,
    );
    expect(body.status).toBe("failed");
    expect(body.errorReason).toBeTruthy();
  });

  it("surfaces duplicate-patient candidates for the accept flow", async () => {
    const hit = await get<{ candidates: Array<{ matchedOn: string }> }>(
      `${A}/referral-reviews/demo-review-1/duplicates`,
    );
    expect(hit.body.candidates).toHaveLength(1);
    expect(hit.body.candidates[0].matchedOn).toBe("dob_name");

    const miss = await get<{ candidates: unknown[] }>(
      `${A}/referral-reviews/demo-review-3/duplicates`,
    );
    expect(miss.body.candidates).toHaveLength(0);
  });

  it("accepting a review creates a patient and marks it accepted", async () => {
    const { body } = await post<{
      patientId: string | null;
      status: string;
      documentsCreated: number;
    }>(`${A}/referral-reviews/demo-review-3/accept`);
    expect(body.patientId).toBeTruthy();
    expect(body.status).toBe("accepted");
    const after = await get<{ status: string }>(
      `${A}/referral-reviews/demo-review-3`,
    );
    expect(after.body.status).toBe("accepted");
  });

  it("dismissing a review records the note", async () => {
    const dismissed = await post<{ id: string; status: string }>(
      `${A}/referral-reviews/demo-review-2/dismiss`,
      { note: "Duplicate fax." },
    );
    expect(dismissed.body.status).toBe("dismissed");
    const { body } = await get<{
      status: string;
      dismissNote: string | null;
    }>(`${A}/referral-reviews/demo-review-2`);
    expect(body.status).toBe("dismissed");
    expect(body.dismissNote).toBe("Duplicate fax.");
  });

  it("re-running extraction on a failed packet fills it in", async () => {
    const { body } = await post<{ status: string; extraction: unknown }>(
      `${A}/referral-reviews/demo-review-6/extract`,
    );
    expect(body.status).toBe("extracted");
    expect(body.extraction).not.toBeNull();
  });

  it("builds a provider request list from the completeness gaps", async () => {
    const { body } = await post<{
      manualDocumentId: string;
      requests: string[];
    }>(`${A}/referral-reviews/demo-review-1/request-from-provider`);
    expect(body.manualDocumentId).toBeTruthy();
    expect(body.requests.length).toBeGreaterThan(0);
  });

  it("hands back a same-origin upload target so nothing escapes the sandbox", async () => {
    const { body } = await post<{ uploadURL: string; objectPath: string }>(
      `${A}/referral-reviews/upload-url`,
    );
    expect(body.objectPath).toContain("referral-uploads/");
    expect(body.uploadURL.startsWith("/resupply-api/")).toBe(true);
  });

  it("registering an uploaded packet adds it to the queue as pending", async () => {
    const created = await post<{
      id: string;
      status: string;
      source: string;
      enqueued: boolean;
    }>(`${A}/referral-reviews`, { objectPath: "demo/packet.pdf" });
    expect(created.body.status).toBe("pending");
    expect(created.body.source).toBe("upload");
    expect(created.body.enqueued).toBe(true);

    // A pending review belongs to the default `open` bucket.
    const { body } = await get<{ reviews: Array<{ id: string }> }>(
      `${A}/referral-reviews`,
    );
    expect(body.reviews.some((r) => r.id === created.body.id)).toBe(true);
  });
});

describe("tenant admin — shop orders", () => {
  it("seeds an order list with totals and pagination", async () => {
    const { body } = await get<{
      orders: Array<{ id: string; status: string; itemCount: number }>;
      total: number;
      limit: number;
      offset: number;
    }>(`${A}/shop/orders`);
    expect(body.orders.length).toBeGreaterThan(3);
    expect(body.total).toBe(body.orders.length);
    expect(body.orders[0].itemCount).toBeGreaterThan(0);
  });

  it("filters orders by status and free-text query", async () => {
    const paid = await get<{ orders: Array<{ status: string }> }>(
      `${A}/shop/orders?status=paid`,
    );
    expect(paid.body.orders.length).toBeGreaterThan(0);
    expect(paid.body.orders.every((o) => o.status === "paid")).toBe(true);

    const searched = await get<{
      orders: Array<{ customerName: string | null }>;
    }>(`${A}/shop/orders?q=avery`);
    expect(searched.body.orders).toHaveLength(1);
    expect(searched.body.orders[0].customerName).toBe("Avery Sample");
  });

  it("serves an order detail with line items and a shipping address", async () => {
    const { body } = await get<{
      id: string;
      stripeSessionId: string;
      lineItems: Array<{ name: string; quantity: number }>;
      shippingAddress: { city: string } | null;
    }>(`${A}/shop/orders/demo-order-0001`);
    expect(body.id).toBe("demo-order-0001");
    expect(body.stripeSessionId).toContain("cs_demo_");
    expect(body.lineItems.length).toBeGreaterThan(0);
    expect(body.shippingAddress?.city).toBe("Philadelphia");
  });

  it("omits the shipping address on a pickup order", async () => {
    const { body } = await get<{
      fulfillmentMethod: string | null;
      shippingAddress: unknown | null;
    }>(`${A}/shop/orders/demo-order-0004`);
    expect(body.fulfillmentMethod).toBe("pickup");
    expect(body.shippingAddress).toBeNull();
  });

  it("does not shadow the per-order action sub-routes", async () => {
    // The detail pattern is a single-segment match, so `/orders/:id/pod/meta`
    // and friends must still reach their own handlers rather than being
    // swallowed by the newly-added detail route.
    const pod = await get<{ signedName?: string; uploadedAt?: string }>(
      `${A}/shop/orders/demo-order-0001/pod/meta`,
    );
    expect(pod.body.signedName).toBe("D. Patient");

    const claims = await get<{ claims: unknown[] }>(
      `${A}/shop/orders/demo-order-0001/loss-claims`,
    );
    expect(Array.isArray(claims.body.claims)).toBe(true);
  });
});
