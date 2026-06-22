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

  it("answers /platform/system-info with a full shape (the system-info page derefs it)", async () => {
    // Regression guard: PlatformSystemInfoPage reads
    // data.server.uptimeSeconds, data.secrets.linkHmacKeyConfigured, etc.
    // directly. If this endpoint ever falls through to the empty-object GET
    // fallback, the page crashes into the global ErrorBoundary.
    const res = await get("/resupply-api/platform/system-info");
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
          expect((b.counts as { total: number }).total).toBeGreaterThanOrEqual(
            0,
          );
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
          expect((b.totals as { count: number }).count).toBeGreaterThanOrEqual(
            0,
          );
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

  it("answers the claims-workflow action POSTs with shape-complete payloads", async () => {
    // Regression guard (PR review finding): the seeded GETs enable the
    // pages' action buttons, whose POSTs would otherwise hit the
    // `{ ok: true }` mutation fallback — and the pages deref the
    // response (result.failures.length, summary.scanned, outcome.kind,
    // marked), crashing on the very click the seed data invites.
    const run = (await (await post(
      "/resupply-api/admin/billing/auto-submit/run",
      {},
    ))!.json()) as { failures: unknown[]; skippedNotReady: unknown[] };
    expect(Array.isArray(run.failures)).toBe(true);
    expect(Array.isArray(run.skippedNotReady)).toBe(true);

    const batch = (await (await post(
      "/resupply-api/admin/billing/statements/batch-send",
      {},
    ))!.json()) as { summary: { scanned: number } };
    expect(typeof batch.summary.scanned).toBe("number");

    const send = (await (await post(
      "/resupply-api/admin/billing/statements/demo-stmt-1/send",
    ))!.json()) as { outcome: { kind: string } };
    expect(typeof send.outcome.kind).toBe("string");

    const marked = (await (await post(
      "/resupply-api/admin/billing/statements/mark-mailed",
      { statementIds: ["demo-stmt-9"] },
    ))!.json()) as { marked: number };
    expect(marked.marked).toBe(1);
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

  it("answers a conversation detail with a populated message timeline", async () => {
    // Regression guard: ConversationDetailPage derefs `data.messages`
    // (and keys on `data.id`). Without a :id handler the detail GET hit
    // the empty-object fallback, so `data.messages.length` threw into
    // the global ErrorBoundary ("Something went wrong") the instant a
    // demo explorer clicked any inbox row.
    const res = await get("/resupply-api/conversations/demo-conv-2");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      id: string;
      channel: string;
      status: string;
      messages: Array<{ id: string; direction: string; body: string }>;
    };
    expect(body.id).toBe("demo-conv-2");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);
    for (const m of body.messages) {
      expect(typeof m.body).toBe("string");
      expect(["inbound", "outbound"]).toContain(m.direction);
    }
  });

  it("round-trips an unrecognized conversation id to a valid detail", async () => {
    // A stale deep link must still render a full thread, not a
    // half-empty shell that trips the same deref.
    const res = await get("/resupply-api/conversations/demo-conv-999");
    const body = (await res!.json()) as {
      id: string;
      messages: unknown[];
    };
    expect(body.id).toBe("demo-conv-999");
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("answers a patient detail with the four related-record arrays", async () => {
    // Regression guard: PatientDetailPage derefs data.episodes.length,
    // .conversations.length, .fulfillments.length, .prescriptions.length
    // for its tab counts. Without a :id handler the detail GET hit the
    // empty-object fallback and crashed into the global ErrorBoundary the
    // instant a roster row was clicked.
    const res = await get("/resupply-api/patients/demo-patient-3");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.id).toBe("demo-patient-3");
    for (const key of [
      "episodes",
      "conversations",
      "fulfillments",
      "prescriptions",
    ]) {
      expect(Array.isArray(body[key]), key).toBe(true);
    }
  });

  it("does not let the patient :id fixture shadow static sub-routes", async () => {
    // Regression guard (Codex review): `:id` matches any single segment,
    // so /resupply-api/patients/duplicates was being answered with
    // demoPatientDetail("duplicates") — which has no `groups`, crashing
    // AdminPatientsDuplicatesPage (data.groups.length). The static route
    // must win: it's now explicitly seeded by ext13 (registered ahead of
    // adminHandlers), so it returns a real `groups` array — never the
    // patient-detail fixture.
    const res = await get("/resupply-api/patients/duplicates");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(Array.isArray(body.groups)).toBe(true);
    // Seeded duplicates: a non-empty groups array (the bug returned a
    // fixture with no `groups` key at all).
    expect((body.groups as unknown[]).length).toBeGreaterThanOrEqual(1);
    // And a real demo patient id still gets the full detail.
    const detail = (await (await get(
      "/resupply-api/patients/demo-patient-1",
    ))!.json()) as { id: string; episodes: unknown[] };
    expect(detail.id).toBe("demo-patient-1");
    expect(Array.isArray(detail.episodes)).toBe(true);
  });

  it("returns a bodyless 200 for unmatched HEAD requests", async () => {
    // HTTP semantics (Copilot review): HEAD responses carry no body.
    const res = await routeDemoRequest("/resupply-api/whatever", {
      method: "HEAD",
    });
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("");
  });

  it("answers a storefront order detail with a populated payload", async () => {
    // Regression guard: AdminOrderDetail derefs data.order.payload.* —
    // the empty-object fallback (no `order`) crashed it on click.
    const res = await get("/api/admin/orders/demo-aorder-2");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      order: { id: string; orderReference: string; payload: unknown };
    };
    expect(body.order.id).toBe("demo-aorder-2");
    expect(typeof body.order.orderReference).toBe("string");
    expect(body.order.payload).toBeTypeOf("object");
    expect(body.order.payload).not.toBeNull();
  });

  it("falls back to an empty-collections shape for unmatched API GETs", async () => {
    // Systemic guard for the whole bug class: a broadly-permissioned demo
    // explorer can navigate to admin list pages whose endpoints aren't
    // seeded. Those pages deref `data.<field>.map/.length` directly, so a
    // bare `{}` fallback crashed them into the global ErrorBoundary. The
    // fallback now returns empty collections + zeroed pagination so each
    // renders its empty state instead.
    const res = await get("/resupply-api/admin/some-unseeded-list");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    // A representative sample of the collection names pages read.
    for (const key of [
      "items",
      "rows",
      "agents",
      "providers",
      "closures",
      "interventions",
      "claims",
      "ordersByDay",
    ]) {
      expect(Array.isArray(body[key]), key).toBe(true);
      expect((body[key] as unknown[]).length).toBe(0);
    }
    expect(body.total).toBe(0);
    expect(body.counts).toBeTypeOf("object");
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
