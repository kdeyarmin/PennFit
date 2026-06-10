// Admin console handlers. Bootstrap (identity, inbox counts, dashboard
// summary) plus the most prominent worklists and list pages, seeded
// with fictional demo data. The long tail of admin endpoints falls
// through to the router's benign default (empty list / ok) so those
// pages render their empty states rather than erroring.

import { route, type DemoHandler } from "../types";
import { json, sseChat } from "../respond";
import {
  demoAdminIdentity,
  demoInboxCounts,
  demoDashboardSummary,
  demoPatients,
  demoConversations,
  demoEpisodes,
  demoToday,
  demoWorkItems,
  demoShopCustomers,
  demoCustomerDetail,
  demoFitterLeads,
  demoBillingDirectorSummary,
  demoAdminOrders,
  demoSystemInfo,
} from "../fixtures/admin";
import { findDemoProduct } from "../fixtures/products";

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
) {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Canned PennPilot (admin assistant) replies. The widget streams SSE
 * with a JSON fallback, exactly like the customer chatbot — without
 * this handler the endpoint hits the router's `{ ok: true }` mutation
 * fallback, which contains no SSE events, so the widget renders an
 * empty bubble and toasts "Trouble connecting". Each branch covers one
 * of the widget's suggested prompts; replies mention real /admin paths
 * because the widget renders them as one-click links.
 */
function pennPilotReply(messages: AssistantMessage[] | undefined): string {
  const lastUser = [...(messages ?? [])]
    .reverse()
    .find((m) => m.role === "user");
  const q = (lastUser?.content ?? "").toLowerCase();
  // "I have an idea…" — must be tested before the feature-FLAG branch,
  // since suggestion prompts also contain the word "feature".
  if (q.includes("idea") || q.includes("suggest")) {
    return "Happy to help shape it! In the live console I'd write your idea up as a structured suggestion and — after you confirm — email it to the super-admins. You're in the demo, so nothing is actually sent, but this is exactly where you'd pitch it. Try me on any \"how do I…\" question meanwhile.";
  }
  if (q.includes("claim") || q.includes("eligibility")) {
    return "Here's the claims path end to end: confirm coverage at Eligibility (/admin/billing/eligibility) — or run a one-off 270/271 from Verify insurance (/admin/billing/verify). If the plan needs one, secure it at Prior auths (/admin/billing/prior-auths). Send the 837P via Auto-submit (/admin/billing/auto-submit) or Manual claim (/admin/billing/manual-claim), then watch the payer response land in ERA files (/admin/billing/era). Anything denied goes to the Denials worklist (/admin/billing/denials-worklist), ranked by recoverable dollars; the AI queue (/admin/billing/ai-queue) suggests codes and edits along the way. (Demo answer — sample data only.)";
  }
  if (
    q.includes("flag") ||
    (q.includes("feature") && (q.includes("turn") || q.includes("toggle")))
  ) {
    return "Control Center (/admin/control-center) holds the feature flags — most automation (reminders, auto-submit, the chatbots, this very assistant) has an on/off switch there. Flip it and the change takes effect immediately. (Demo answer — toggles here are simulated.)";
  }
  if (q.includes("campaign") || q.includes("bulk")) {
    return "Bulk Campaigns (/admin/bulk-campaigns) is the place: build your audience with the filters, sanity-check the recipient count, then send a batch SMS or email. The reusable content lives alongside it — Alert Library (/admin/alerts) and Automated messages (/admin/templates). (Demo answer — no real messages go out.)";
  }
  return 'Hi, I\'m PennPilot — your guide to the admin console. Ask me how a page works or where to find something; try "walk me through processing a claim" or "where do I turn features on or off". You\'re exploring the PennFit demo, so my answers are canned samples and no data here is real.';
}

export const adminHandlers: DemoHandler[] = [
  // ── bootstrap ────────────────────────────────────────────────────
  route("GET", "/resupply-api/me", () => json(demoAdminIdentity())),
  route("GET", "/resupply-api/admin/inbox-counts", () =>
    json(demoInboxCounts()),
  ),
  route("GET", "/resupply-api/dashboard/summary", () =>
    json(demoDashboardSummary()),
  ),
  // The Settings page derefs nested objects from this payload directly, so
  // it must be answered with a full shape — without this the router's
  // empty-object GET fallback crashes /admin/settings (and traps the user,
  // since the demo on/off toggle lives on that very page).
  route("GET", "/resupply-api/admin/system-info", () => json(demoSystemInfo())),

  // ── PennPilot (admin assistant widget) ───────────────────────────
  route("POST", "/resupply-api/admin/assistant/chat", (req) => {
    const body = req.json<{ messages?: AssistantMessage[] }>() ?? {};
    const reply = pennPilotReply(body.messages);
    const wantsStream = (req.headers.get("accept") ?? "").includes(
      "text/event-stream",
    );
    return wantsStream ? sseChat(reply) : json({ reply });
  }),

  // ── worklists ────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/today", () => json(demoToday())),
  route("GET", "/resupply-api/admin/work-items", () => json(demoWorkItems())),
  route("GET", "/resupply-api/admin/shop/customers", (req) =>
    json(
      demoShopCustomers({
        q: req.query.get("q"),
        page: intParam(req, "page", 1),
        pageSize: intParam(req, "pageSize", 25),
        subscription: req.query.get("subscription"),
        awaitingReply:
          req.query.get("awaitingReply") === "1" ||
          req.query.get("awaitingReply") === "true",
      }),
    ),
  ),
  route(
    "GET",
    "/resupply-api/admin/shop/customers/:userId",
    (_req, { userId }) => json(demoCustomerDetail(userId)),
  ),

  // ── core lists (offset/limit pagination) ─────────────────────────
  route("GET", "/resupply-api/patients", (req) =>
    json(
      demoPatients(
        intParam(req, "limit", 25),
        intParam(req, "offset", 0),
        req.query.get("search"),
      ),
    ),
  ),
  route("GET", "/resupply-api/conversations", (req) =>
    json(
      demoConversations(intParam(req, "limit", 25), intParam(req, "offset", 0)),
    ),
  ),
  route("GET", "/resupply-api/episodes", (req) =>
    json(demoEpisodes(intParam(req, "limit", 25), intParam(req, "offset", 0))),
  ),

  // ── leads + billing + orders ─────────────────────────────────────
  route("GET", "/resupply-api/admin/fitter-leads", () =>
    json(demoFitterLeads()),
  ),
  route("GET", "/resupply-api/admin/billing/director-summary", () =>
    json(demoBillingDirectorSummary()),
  ),
  route("GET", "/api/admin/orders", (req) =>
    json(
      demoAdminOrders(intParam(req, "page", 1), intParam(req, "pageSize", 25)),
    ),
  ),

  // ── inventory mutations (admin maps the storefront catalog) ──────
  // The client (shop-inventory-api.ts) reads `json.product.{id,name,
  // category,price.unitAmount,price.currency,stockCount,
  // lowStockThreshold}`, so the response MUST be wrapped in
  // `{ product: <ShopProductView> }`, mirroring the real API.
  route(
    "PATCH",
    "/resupply-api/admin/shop/products/:id/stock",
    (req, { id }) => {
      const body = req.json<{ stockCount?: number | null }>() ?? {};
      return json({
        product: inventoryProduct(id, { stockCount: body.stockCount ?? null }),
      });
    },
  ),
  route(
    "PATCH",
    "/resupply-api/admin/shop/products/:id/threshold",
    (req, { id }) => {
      const body = req.json<{ lowStockThreshold?: number | null }>() ?? {};
      return json({
        product: inventoryProduct(id, {
          lowStockThreshold: body.lowStockThreshold ?? null,
        }),
      });
    },
  ),
];

/**
 * Build the `{ product }` payload the inventory client expects after a
 * stock/threshold PATCH. Starts from the seeded catalog product (a
 * full ShopProductView, so `price.unitAmount` etc. are present) and
 * applies the edited field.
 */
function inventoryProduct(
  id: string,
  patch: { stockCount?: number | null; lowStockThreshold?: number | null },
) {
  const p = findDemoProduct(id);
  if (p) return { ...p, ...patch };
  return {
    id,
    name: "Demo product",
    category: "accessory" as const,
    price: { id: `demo_price_${id}`, unitAmount: 0, currency: "usd" },
    stockCount: patch.stockCount ?? null,
    lowStockThreshold: patch.lowStockThreshold ?? null,
  };
}
