// Miscellaneous public handlers: order tracking, resupply reminders,
// the PennBot chatbot (streaming + JSON), NPS, newsletter, and the
// fire-and-forget analytics sink.

import { route, type DemoHandler } from "../types";
import { json, sseChat } from "../respond";
import { demoTrackResult } from "../fixtures/orders";
import { dateOnly } from "../fixtures/dates";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Build a friendly, demo-flavored PennBot reply for the chat surface. */
function chatReply(messages: ChatMessage[] | undefined): string {
  const lastUser = [...(messages ?? [])]
    .reverse()
    .find((m) => m.role === "user");
  const q = (lastUser?.content ?? "").toLowerCase();
  if (q.includes("leak")) {
    return "Mask leaks usually come down to fit. Try re-seating the cushion with the machine running and loosen the top straps a touch — over-tightening is the most common cause. If it keeps leaking, you might be between sizes and a quick refit would help. (You're in the PennFit demo, so this is a sample answer.)";
  }
  if (q.includes("insurance") || q.includes("cost") || q.includes("price")) {
    return "Most insurance plans cover CPAP resupplies on a set schedule. Once your deductible is met, many members pay little or nothing out of pocket. Head to the Insurance page for a quick estimate. (Demo answer — no real account is used.)";
  }
  if (q.includes("order") || q.includes("ship") || q.includes("track")) {
    return "You can see every order, tracking number, and delivery date under Account → Orders. Reorders ship on your subscription cadence, and you can change that anytime. (This is a demonstration response.)";
  }
  return "Hi! I'm PennBot. I can help with mask fit, resupply timing, insurance, and orders. Ask me anything — and remember you're exploring the PennFit demo, so the data here is simulated.";
}

function chatHandler(req: Parameters<DemoHandler["handle"]>[0]): Response {
  const body = req.json<{ messages?: ChatMessage[] }>() ?? {};
  const reply = chatReply(body.messages);
  const wantsStream = (req.headers.get("accept") ?? "").includes(
    "text/event-stream",
  );
  return wantsStream ? sseChat(reply) : json({ reply });
}

export const miscHandlers: DemoHandler[] = [
  // Order tracking (public lookup).
  route("POST", "/api/orders/track", (req) => {
    const body = req.json<{ orderReference?: string }>() ?? {};
    return json(demoTrackResult(body.orderReference ?? ""));
  }),

  // Resupply reminders.
  route("POST", "/api/reminders", () =>
    json({
      success: true,
      emailStatus: "sent",
      message:
        "You're subscribed — we'll email you when each supply is due. (Demo: no real email is sent.)",
    }),
  ),
  route("GET", "/api/reminders/manage", () =>
    json({
      email: "alex.demo@pennfit.example",
      status: "active",
      items: [
        {
          sku: "maskCushion",
          lastReplacedAt: dateOnly(-20),
          intervalDays: 30,
          nextDueAt: dateOnly(10),
        },
        {
          sku: "disposableFilter",
          lastReplacedAt: dateOnly(-25),
          intervalDays: 30,
          nextDueAt: dateOnly(5),
        },
        {
          sku: "tubing",
          lastReplacedAt: dateOnly(-60),
          intervalDays: 180,
          nextDueAt: dateOnly(120),
        },
      ],
      createdAt: dateOnly(-40),
    }),
  ),
  route("PATCH", "/api/reminders/manage", (req) => {
    const body =
      req.json<{
        items?: Array<{
          sku: string;
          lastReplacedAt: string;
          intervalDays: number;
        }>;
      }>() ?? {};
    const items = (body.items ?? []).map((it) => ({
      ...it,
      nextDueAt: it.lastReplacedAt,
    }));
    return json({
      email: "alex.demo@pennfit.example",
      status: "active",
      items,
      createdAt: dateOnly(-40),
    });
  }),
  route("POST", "/api/reminders/manage/unsubscribe", () =>
    json({
      success: true,
      message: "You've been unsubscribed from resupply reminders. (Demo)",
    }),
  ),

  // PennBot chatbot — public + signed-in.
  route("POST", "/api/chat", (req) => chatHandler(req)),
  route("POST", "/resupply-api/shop/me/chat", (req) => chatHandler(req)),

  // NPS rating (token-based, fire-and-forget).
  route("POST", "/resupply-api/shop/orders/nps", () => json({ ok: true })),

  // Newsletter + analytics (fire-and-forget).
  route("POST", "/api/newsletter/subscribe", () => json({ ok: true })),
  route("POST", "/api/usage-events", () => json({ ok: true })),
];
