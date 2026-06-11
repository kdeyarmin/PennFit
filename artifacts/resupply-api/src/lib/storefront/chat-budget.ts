// Process-wide spend ceiling for the PUBLIC storefront chatbot
// (app-review 2026-06-10, P1-7).
//
// The per-IP limiter caps one client, but /api/chat is unauthenticated:
// a botnet rotating source IPs got effectively free LLM usage bounded
// only by the bill. This counter caps the AGGREGATE accepted turns per
// minute across every caller; once the window is exhausted the route
// degrades to the same `degraded: true` reply it already uses for an
// upstream failure — the widget needs no new states, and a real user
// retries a minute later.
//
// In-memory by design: the API runs as a single Railway process, and a
// restart resetting the window is harmless (this is a cost ceiling,
// not an entitlement ledger). The limit is env-tunable so an operator
// can widen it during a campaign without a deploy... of code: set
// RESUPPLY_CHAT_GLOBAL_TURNS_PER_MINUTE and restart.

const WINDOW_MS = 60_000;
/** Default aggregate ceiling: 6× the per-IP cap (20/min). Organic
 *  traffic bursts fit comfortably; a distributed scraper does not. */
const DEFAULT_TURNS_PER_MINUTE = 120;

function readLimit(): number {
  const raw = Number(process.env.RESUPPLY_CHAT_GLOBAL_TURNS_PER_MINUTE);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_TURNS_PER_MINUTE;
}

let windowStartMs = 0;
let consumed = 0;

/** Consume one turn from the global budget. False = window exhausted —
 *  the caller must degrade without touching any LLM vendor. */
export function tryConsumeChatBudget(now: number = Date.now()): boolean {
  if (now - windowStartMs >= WINDOW_MS) {
    windowStartMs = now;
    consumed = 0;
  }
  if (consumed >= readLimit()) return false;
  consumed += 1;
  return true;
}

/** Test seam — module state would otherwise leak across specs. */
export function resetChatBudgetForTests(): void {
  windowStartMs = 0;
  consumed = 0;
}
