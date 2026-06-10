import { describe, expect, it } from "vitest";

import { routeDemoRequest } from "./router";

async function get(url: string, init?: RequestInit) {
  return routeDemoRequest(url, { method: "GET", ...init });
}
async function post(url: string, body?: unknown, init?: RequestInit) {
  return routeDemoRequest(url, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
}

describe("demo router", () => {
  it("passes through non-API paths (returns null)", async () => {
    expect(await get("/assets/logo.svg")).toBeNull();
    expect(await get("https://cdn.example.com/x.png")).toBeNull();
  });

  it("serves the storefront catalog", async () => {
    const res = await get("/resupply-api/shop/products");
    expect(res).not.toBeNull();
    const body = (await res!.json()) as {
      previewMode: boolean;
      products: unknown[];
    };
    expect(body.previewMode).toBe(false);
    expect(body.products.length).toBeGreaterThan(0);
  });

  it("auto-signs-in the demo customer", async () => {
    const res = await get("/api/auth/me");
    const body = (await res!.json()) as { id: string; role: string };
    expect(body.id).toBe("demo-customer-1");
    expect(body.role).toBe("customer");
  });

  it("returns an admin identity for the console gate", async () => {
    const res = await get("/resupply-api/me");
    const body = (await res!.json()) as { role: string; permissions: string[] };
    expect(body.role).toBe("admin");
    expect(body.permissions.length).toBeGreaterThan(0);
  });

  it("produces mask recommendations for the fit flow", async () => {
    const res = await post("/api/recommendations", {
      measurements: {},
      answers: {},
    });
    const body = (await res!.json()) as { topRecommendations: unknown[] };
    expect(body.topRecommendations.length).toBe(3);
  });

  it("simulates checkout with a same-origin success URL", async () => {
    const res = await post("/resupply-api/shop/checkout", { items: [] });
    const body = (await res!.json()) as { url: string; sessionId: string };
    expect(body.sessionId).toMatch(/^demo_sess_/);
    expect(body.url).toContain("/shop/checkout-success?session_id=");
  });

  it("records a placed order so it appears in history", async () => {
    await post("/api/orders", { chosenMask: { name: "Demo Mask" } });
    const res = await get("/resupply-api/shop/me/orders");
    const body = (await res!.json()) as { orders: Array<{ items: unknown[] }> };
    // 2 seeded + at least 1 just-placed.
    expect(body.orders.length).toBeGreaterThanOrEqual(3);
  });

  it("returns JSON chat by default and SSE when requested", async () => {
    const jsonRes = await post("/api/chat", { messages: [] });
    expect(jsonRes!.headers.get("content-type")).toContain("application/json");

    const sseRes = await post(
      "/api/chat",
      { messages: [{ role: "user", content: "hi" }] },
      { headers: { accept: "text/event-stream" } },
    );
    expect(sseRes!.headers.get("content-type")).toContain("text/event-stream");
  });

  it("answers PennPilot (admin assistant) chat in JSON and SSE modes", async () => {
    // Regression guard: without a handler this endpoint hits the
    // `{ ok: true }` mutation fallback, which carries no SSE events —
    // the widget then renders an empty bubble and toasts "Trouble
    // connecting" (degraded). See AdminAssistantWidget.
    const jsonRes = await post("/resupply-api/admin/assistant/chat", {
      messages: [
        {
          role: "user",
          content:
            "Walk me through processing an insurance claim from eligibility to payment.",
        },
      ],
    });
    expect(jsonRes!.headers.get("content-type")).toContain("application/json");
    const body = (await jsonRes!.json()) as { reply: string };
    expect(body.reply).toContain("/admin/billing/eligibility");

    const sseRes = await post(
      "/resupply-api/admin/assistant/chat",
      { messages: [{ role: "user", content: "hi" }] },
      { headers: { accept: "text/event-stream" } },
    );
    expect(sseRes!.headers.get("content-type")).toContain("text/event-stream");
    const raw = await sseRes!.text();
    expect(raw).toContain('"type":"chunk"');
    expect(raw).toContain('"type":"done"');
  });

  it("answers /admin/system-info with a full shape (settings page derefs it)", async () => {
    // Regression guard: the Settings page reads data.server.uptimeSeconds,
    // data.secrets.linkHmacKeyConfigured, etc. directly. If this endpoint
    // ever falls through to the empty-object GET fallback, the page crashes
    // into the global ErrorBoundary — and the demo on/off toggle lives on
    // that same page, so the user gets trapped in demo mode.
    const res = await get("/resupply-api/admin/system-info");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    for (const key of [
      "server",
      "database",
      "publicUrls",
      "auth",
      "vendors",
      "secrets",
    ]) {
      expect(body[key]).toBeTypeOf("object");
      expect(body[key]).not.toBeNull();
    }
    const server = body.server as Record<string, unknown>;
    expect(typeof server.uptimeSeconds).toBe("number");
  });

  it("answers the claims-workflow pages with shape-complete payloads", async () => {
    // Regression guard: these pages dereference nested fields
    // unconditionally (counts.total, totals.count, eraFiles.length,
    // groups/excluded, pending.map, queued.map), so each endpoint
    // falling through to the empty-object GET fallback crashes the page
    // into the admin error boundary — the exact "Something went wrong"
    // a demo visitor hit while following PennPilot's claims walkthrough.
    const shapes: Array<[string, (body: Record<string, unknown>) => void]> = [
      [
        "/resupply-api/admin/billing/eligibility-recent",
        (b) => {
          expect(Array.isArray(b.checks)).toBe(true);
          expect(
            (b.counts as { total: number }).total,
          ).toBeGreaterThanOrEqual(0);
        },
      ],
      [
        "/resupply-api/admin/billing/era-files",
        (b) => expect(Array.isArray(b.eraFiles)).toBe(true),
      ],
      [
        "/resupply-api/admin/billing/denials-worklist",
        (b) => {
          expect(Array.isArray(b.items)).toBe(true);
          expect(
            (b.totals as { count: number }).count,
          ).toBeGreaterThanOrEqual(0);
        },
      ],
      [
        "/resupply-api/admin/billing/auto-submit/ready",
        (b) => {
          expect(Array.isArray(b.groups)).toBe(true);
          expect(Array.isArray(b.excluded)).toBe(true);
        },
      ],
      [
        "/resupply-api/admin/billing/auto-submit/status",
        (b) =>
          expect(
            (b.autoSubmit as { flagEnabled: boolean }).flagEnabled,
          ).toBeTypeOf("boolean"),
      ],
      [
        "/resupply-api/admin/billing/statements/pending",
        (b) => expect(Array.isArray(b.pending)).toBe(true),
      ],
      [
        "/resupply-api/admin/billing/statements/mail-queue",
        (b) => {
          expect(Array.isArray(b.queued)).toBe(true);
          expect(typeof b.printCap).toBe("number");
        },
      ],
    ];
    for (const [path, check] of shapes) {
      const res = await get(path);
      expect(res, path).not.toBeNull();
      expect(res!.status, path).toBe(200);
      check((await res!.json()) as Record<string, unknown>);
    }
  });

  it("includes appointmentsAssignedToMe in /admin/today (dashboard derefs .length)", async () => {
    // Regression guard: TodayResponse grew this key; the stale fixture
    // without it crashed /admin, /admin/today AND /admin/work-queue
    // (all three render AssignedAppointmentsCard) in demo mode.
    const res = await get("/resupply-api/admin/today");
    const body = (await res!.json()) as Record<string, unknown>;
    expect(Array.isArray(body.appointmentsAssignedToMe)).toBe(true);
  });

  it("filters the demo patient roster by search", async () => {
    const res = await get("/resupply-api/patients?search=jordan&limit=10");
    const body = (await res!.json()) as {
      items: Array<{ firstName: string }>;
    };
    expect(body.items.length).toBeGreaterThan(0);
    for (const p of body.items) {
      expect(p.firstName.toLowerCase()).toContain("jordan");
    }
  });

  it("falls back to empty object for unmatched API GETs", async () => {
    const res = await get("/api/totally-unknown-endpoint");
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({});
  });

  it("falls back to ok for unmatched API mutations", async () => {
    const res = await post("/api/some-unknown-write");
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
  });

  it("wraps the inventory PATCH response in { product } with a nested price", async () => {
    // The admin inventory client reads json.product.id and
    // json.product.price.unitAmount — a flat row would crash it.
    const res = await routeDemoRequest(
      "/resupply-api/admin/shop/products/demo-prod-n20-cushion/stock",
      { method: "PATCH", body: JSON.stringify({ stockCount: 7 }) },
    );
    const body = (await res!.json()) as {
      product: {
        id: string;
        stockCount: number;
        price: { unitAmount: number };
      };
    };
    expect(body.product.id).toBe("demo-prod-n20-cushion");
    expect(body.product.stockCount).toBe(7);
    expect(typeof body.product.price.unitAmount).toBe("number");
  });
});
